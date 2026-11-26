import {
  BalloonSnapshot,
  ClientMessage,
  FIXED_DT_MS,
  GameEvent,
  MatchSummary,
  ROOM_ID,
  RoomSnapshot,
  RoomStatus,
  ServerMessage,
} from '../../shared/protocol';

export type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

export interface AuthSessionInfo {
  uid: string;
  displayName: string;
  isHost: boolean;
  claimedPlayerId: string | null;
}

interface SnapshotFrame {
  receivedAt: number;
  snapshot: RoomSnapshot;
}

interface VisualPrediction {
  playerId: string;
  offsetX: number;
  offsetY: number;
  vx: number;
  vy: number;
  createdAt: number;
}

export interface GameClientCallbacks {
  onConnectionChange?: (state: ConnectionState, rttMs: number | null) => void;
  onAuthChange?: (session: AuthSessionInfo | null, error?: string) => void;
  onSnapshot?: (snapshot: RoomSnapshot) => void;
  onEvents?: (events: GameEvent[]) => void;
  onMatchFinished?: (summary: MatchSummary) => void;
  onCheckpointSaved?: (checkpoint: {
    checkpointId: string;
    roundNumber: number;
    status: RoomStatus;
    timeRemainingMs: number;
    balloonsCount: number;
    savedAt: number;
  }) => void;
  onError?: (message: string) => void;
}

export class ArenaGameClient {
  private ws: WebSocket | null = null;
  private getToken: (() => Promise<string | null>) | null = null;
  private callbacks: GameClientCallbacks;
  private connectionState: ConnectionState = 'disconnected';
  private authSession: AuthSessionInfo | null = null;
  private shouldReconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private rttMs: number | null = null;
  private seq = 1;

  // Snapshot interpolation ring buffer (30Hz server -> 60fps smooth client)
  private snapshotBuffer: SnapshotFrame[] = [];
  private latestSnapshot: RoomSnapshot | null = null;
  private seenEventIds = new Set<string>();

  // Short-term visual-only prediction nudge (reconciles immediately against server)
  private prediction: VisualPrediction | null = null;

  constructor(callbacks: GameClientCallbacks) {
    this.callbacks = callbacks;
  }

  public connect(getToken: () => Promise<string | null>): void {
    this.getToken = getToken;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.authSession = null;
    this.setConnectionState('disconnected');
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.callbacks.onConnectionChange?.(state, this.rttMs);
  }

  private buildWsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }

  private openSocket(): void {
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    this.setConnectionState('connecting');
    const ws = new WebSocket(this.buildWsUrl());
    this.ws = ws;

    ws.onopen = async () => {
      this.setConnectionState('authenticating');
      try {
        const token = await this.getToken?.();
        if (!token) {
          this.callbacks.onAuthChange?.(null, 'Sign in required.');
          ws.close();
          return;
        }
        this.sendRaw({ type: 'AUTH', idToken: token });
      } catch (err) {
        this.callbacks.onAuthChange?.(
          null,
          err instanceof Error ? err.message : 'Failed to fetch auth token.',
        );
        ws.close();
      }
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handleServerMessage(msg);
    };

    ws.onclose = () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.ws = null;
      this.setConnectionState('disconnected');
      if (this.shouldReconnect) {
        const delayMs = Math.min(8000, 600 * Math.pow(1.6, this.reconnectAttempt));
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
          if (this.shouldReconnect) this.openSocket();
        }, delayMs);
      }
    };

    ws.onerror = () => {
      // Handled by onclose automatic reconnect
    };
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendRaw({ type: 'HEARTBEAT_PING', clientTime: Date.now() });
      }
    }, 12_000);
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'AUTH_OK': {
        this.reconnectAttempt = 0;
        this.authSession = {
          uid: msg.uid,
          displayName: msg.displayName,
          isHost: msg.isHost,
          claimedPlayerId: msg.claimedPlayerId,
        };
        this.setConnectionState('connected');
        this.startHeartbeat();
        this.callbacks.onAuthChange?.(this.authSession);
        break;
      }
      case 'AUTH_ERROR': {
        this.authSession = null;
        this.callbacks.onAuthChange?.(null, msg.message);
        break;
      }
      case 'HEARTBEAT_PONG': {
        this.rttMs = Math.max(1, Date.now() - msg.clientTime);
        this.callbacks.onConnectionChange?.(this.connectionState, this.rttMs);
        break;
      }
      case 'SNAPSHOT': {
        const now = performance.now();
        this.latestSnapshot = msg.snapshot;
        this.snapshotBuffer.push({ receivedAt: now, snapshot: msg.snapshot });
        if (this.snapshotBuffer.length > 6) {
          this.snapshotBuffer.shift();
        }
        // Reconcile visual prediction against authoritative server state
        if (this.prediction && now - this.prediction.createdAt > 120) {
          this.prediction = null;
        }
        this.callbacks.onSnapshot?.(msg.snapshot);

        // Emit deduplicated authoritative game events for animations & sound
        if (msg.snapshot.events.length > 0) {
          const fresh: GameEvent[] = [];
          for (const ev of msg.snapshot.events) {
            if (!this.seenEventIds.has(ev.id)) {
              this.seenEventIds.add(ev.id);
              fresh.push(ev);
            }
          }
          if (this.seenEventIds.size > 400) {
            const arr = Array.from(this.seenEventIds).slice(-200);
            this.seenEventIds = new Set(arr);
          }
          if (fresh.length > 0) {
            this.callbacks.onEvents?.(fresh);
          }
        }
        break;
      }
      case 'MATCH_FINISHED': {
        this.callbacks.onMatchFinished?.(msg.summary);
        break;
      }
      case 'CHECKPOINT_SAVED': {
        this.callbacks.onCheckpointSaved?.(msg.checkpoint);
        break;
      }
      case 'ACTION_ACK': {
        if (!msg.accepted && msg.reason && msg.reason !== 'Kick is on cooldown.' && msg.reason !== 'Throw is on cooldown.') {
          // Clear visual prediction immediately if server rejected the action
          this.prediction = null;
        }
        break;
      }
      case 'ERROR': {
        this.callbacks.onError?.(msg.message);
        break;
      }
    }
  }

  public sendRaw(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private nextActionMeta(): { actionId: string; seq: number; roomId: string } {
    const seq = this.seq++;
    const rand = Math.random().toString(36).slice(2, 8);
    return {
      actionId: `act-${Date.now()}-${seq}-${rand}`,
      seq,
      roomId: ROOM_ID,
    };
  }

  // ---- Gameplay Actions (Validated by Server) ----
  public claimCousin(playerId: string | null, asSpectator = false): void {
    this.sendRaw({
      type: 'JOIN_ROOM',
      roomId: ROOM_ID,
      playerId,
      asSpectator,
    });
  }

  public setReady(playerId: string, ready: boolean): void {
    const meta = this.nextActionMeta();
    this.sendRaw({
      type: 'PLAYER_READY',
      ...meta,
      playerId,
      ready,
    });
  }

  public sendKick(
    playerId: string,
    dx: number,
    dy: number,
    power = 0.85,
    targetBalloonId?: string | null,
  ): void {
    const meta = this.nextActionMeta();
    // Short-term visual-only responsiveness nudge (reconciled immediately by server)
    if (!targetBalloonId) {
      this.applyVisualPrediction(playerId, dx, dy, 10);
    }
    this.sendRaw({
      type: 'KICK',
      ...meta,
      playerId,
      dx,
      dy,
      power,
      targetBalloonId: targetBalloonId ?? null,
    });
  }

  public sendThrow(playerId: string, dx: number, dy: number, power: number): void {
    const meta = this.nextActionMeta();
    this.applyVisualPrediction(playerId, dx, dy, 12 * Math.min(1, Math.max(0.3, power)));
    this.sendRaw({
      type: 'THROW',
      ...meta,
      playerId,
      dx,
      dy,
      power,
    });
  }

  public sendShield(playerId: string): void {
    const meta = this.nextActionMeta();
    this.sendRaw({
      type: 'SHIELD',
      ...meta,
      playerId,
    });
  }

  public sendSlap(playerId: string): void {
    const meta = this.nextActionMeta();
    this.sendRaw({
      type: 'SLAP',
      ...meta,
      playerId,
    });
  }

  // ---- Host-Only Admin Commands ----
  public adminAddCousin(name: string): void {
    this.sendRaw({ type: 'ADMIN_ADD_COUSIN', roomId: ROOM_ID, name });
  }

  public adminBulkAddCousins(names: string[]): void {
    this.sendRaw({ type: 'ADMIN_BULK_ADD_COUSINS', roomId: ROOM_ID, names });
  }

  public adminEditCousin(playerId: string, name: string, color?: string): void {
    this.sendRaw({ type: 'ADMIN_EDIT_COUSIN', roomId: ROOM_ID, playerId, name, color });
  }

  public adminRemoveCousin(playerId: string): void {
    this.sendRaw({ type: 'ADMIN_REMOVE_COUSIN', roomId: ROOM_ID, playerId });
  }

  public adminSyncRoster(
    cousins: Array<{ playerId: string; name: string; color: string; ownerUid?: string | null }>,
  ): void {
    this.sendRaw({ type: 'ADMIN_SYNC_ROSTER', roomId: ROOM_ID, cousins });
  }

  public adminGenerateBalloons(): void {
    this.sendRaw({ type: 'ADMIN_GENERATE_BALLOONS', roomId: ROOM_ID });
  }

  public adminStartMatch(): void {
    this.sendRaw({ type: 'ADMIN_START_MATCH', roomId: ROOM_ID });
  }

  public adminPauseMatch(): void {
    this.sendRaw({ type: 'ADMIN_PAUSE_MATCH', roomId: ROOM_ID });
  }

  public adminResumeMatch(): void {
    this.sendRaw({ type: 'ADMIN_RESUME_MATCH', roomId: ROOM_ID });
  }

  public adminEndMatch(): void {
    this.sendRaw({ type: 'ADMIN_END_MATCH', roomId: ROOM_ID });
  }

  public adminRestartMatch(): void {
    this.sendRaw({ type: 'ADMIN_RESTART_MATCH', roomId: ROOM_ID });
  }

  public adminResetScores(): void {
    this.sendRaw({ type: 'ADMIN_RESET_SCORES', roomId: ROOM_ID });
  }

  private applyVisualPrediction(playerId: string, dx: number, dy: number, speed: number): void {
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;
    this.prediction = {
      playerId,
      offsetX: (dx / len) * speed * 0.45,
      offsetY: (dy / len) * speed * 0.45,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed,
      createdAt: performance.now(),
    };
  }

  // ---- Smooth 60 FPS Interpolation Between 30 Hz Authoritative Snapshots ----
  public getInterpolatedBalloons(nowPerf: number): BalloonSnapshot[] {
    if (this.snapshotBuffer.length === 0) return [];
    if (this.snapshotBuffer.length === 1) {
      return this.snapshotBuffer[0].snapshot.balloons;
    }

    // Render ~40ms behind latest packet to guarantee smooth interpolation between snapshots
    const renderTime = nowPerf - FIXED_DT_MS * 1.15;
    let prev = this.snapshotBuffer[0];
    let next = this.snapshotBuffer[this.snapshotBuffer.length - 1];

    for (let i = 0; i < this.snapshotBuffer.length - 1; i++) {
      const a = this.snapshotBuffer[i];
      const b = this.snapshotBuffer[i + 1];
      if (renderTime >= a.receivedAt && renderTime <= b.receivedAt) {
        prev = a;
        next = b;
        break;
      }
    }

    const span = Math.max(1, next.receivedAt - prev.receivedAt);
    const t = Math.max(0, Math.min(1, (renderTime - prev.receivedAt) / span));
    const prevMap = new Map(prev.snapshot.balloons.map((b) => [b.playerId, b]));

    return next.snapshot.balloons.map((bNext) => {
      const bPrev = prevMap.get(bNext.playerId);
      let x = bNext.x;
      let y = bNext.y;
      if (bPrev && bPrev.status === 'alive' && bNext.status === 'alive') {
        const dist = Math.hypot(bNext.x - bPrev.x, bNext.y - bPrev.y);
        // Avoid lerping across respawn teleport jumps
        if (dist < 160) {
          x = bPrev.x + (bNext.x - bPrev.x) * t;
          y = bPrev.y + (bNext.y - bPrev.y) * t;
        }
      }

      // Blend decaying short-term visual prediction for the local player only
      if (this.prediction && this.prediction.playerId === bNext.playerId) {
        const age = nowPerf - this.prediction.createdAt;
        if (age < 110) {
          const weight = 1 - age / 110;
          x += this.prediction.offsetX * weight;
          y += this.prediction.offsetY * weight;
        }
      }

      return { ...bNext, x, y };
    });
  }

  public getLatestSnapshot(): RoomSnapshot | null {
    return this.latestSnapshot;
  }
}
