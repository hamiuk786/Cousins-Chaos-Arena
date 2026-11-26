import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Matter from 'matter-js';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  BalloonSnapshot,
  BalloonStatus,
  CheckpointData,
  COUNTDOWN_DURATION_MS,
  FIXED_DT_MS,
  GameEvent,
  getCousinColor,
  KICK_COOLDOWN_MS,
  KICK_RANGE,
  LeaderboardEntry,
  MatchSummary,
  MAX_BALLOON_SPEED,
  MAX_PARTICIPANTS,
  MAX_RESPAWNS_PER_ROUND,
  PAIR_HIT_COOLDOWN_MS,
  ParticipantConnectionInfo,
  POINTS_LAST_SURVIVOR,
  POINTS_POP,
  POINTS_VALID_HIT,
  RESPAWN_DELAY_MS,
  ROOM_ID,
  RoomSnapshot,
  RoomStatus,
  ROUND_DURATION_MS,
  SHIELD_COOLDOWN_MS,
  SHIELD_DURATION_MS,
  SLAP_COOLDOWN_MS,
  SLAP_RANGE,
  SPAWN_PROTECTION_MS,
  STARTING_HEALTH,
  THROW_COOLDOWN_MS,
} from '../shared/protocol.ts';

interface LastImpulse {
  attackerPlayerId: string;
  actionId: string;
  expiresAt: number;
}

interface InternalBalloon {
  playerId: string;
  balloonId: string;
  name: string;
  color: string;
  ownerUid: string | null;
  ownerDisplayName: string | null;
  connected: boolean;
  ready: boolean;
  body: Matter.Body | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  health: number;
  score: number;
  hits: number;
  pops: number;
  status: BalloonStatus;
  respawnsUsed: number;
  respawnAt: number | null;
  spawnProtectedUntil: number;
  shieldActiveUntil: number;
  shieldCooldownUntil: number;
  lastSurvivorBonus: boolean;
  floatPhase: number;
  lastImpulse: LastImpulse | null;
  cooldowns: {
    KICK: number;
    THROW: number;
    SHIELD: number;
    SLAP: number;
  };
  seenActionIds: Set<string>;
  seenActionOrder: string[];
  lastSeq: number;
}

export interface ActionResult {
  accepted: boolean;
  reason?: string;
}

export interface EngineCallbacks {
  onMatchFinished?: (summary: MatchSummary) => void;
  onCheckpointSaved?: (checkpoint: CheckpointData) => void;
}

const MAX_SEEN_ACTIONS_PER_PLAYER = 200;
const WALL_THICKNESS = 60;
const MIN_DAMAGE_IMPACT_SPEED = 2.4;

export class CousinsArenaEngine {
  public readonly roomId = ROOM_ID;
  private title = "The Wedding Cousins Chaos Arena";
  private status: RoomStatus = 'WAITING';
  private isPaused = false;
  private roundNumber = 1;
  private timeRemainingMs = ROUND_DURATION_MS;
  private countdownRemainingMs = 0;
  private tick = 0;
  private lastSurvivorAwarded = false;
  private recoveredFromCheckpoint = false;
  private lastCheckpointAt: number | null = null;
  private lastCheckpointSaveClock = 0;

  private engine: Matter.Engine;
  private balloons = new Map<string, InternalBalloon>(); // keyed by playerId
  private bodyToPlayerId = new Map<number, string>();
  private pairHitCooldowns = new Map<string, number>();
  private pendingEvents: GameEvent[] = [];
  private activeConnections = new Map<string, ParticipantConnectionInfo>(); // keyed by uid
  private callbacks: EngineCallbacks;
  private checkpointPath: string | null;
  private nowFn: () => number;

  constructor(options?: {
    callbacks?: EngineCallbacks;
    checkpointPath?: string | null;
    nowFn?: () => number;
  }) {
    this.callbacks = options?.callbacks ?? {};
    this.checkpointPath =
      options?.checkpointPath === undefined
        ? path.resolve('/tmp', 'cousins-chaos-arena-checkpoint.json')
        : options.checkpointPath;
    this.nowFn = options?.nowFn ?? (() => Date.now());

    this.engine = this.createPhysicsWorld();
    this.tryRestoreFromDisk();
  }

  private now(): number {
    return this.nowFn();
  }

  private createPhysicsWorld(): Matter.Engine {
    const engine = Matter.Engine.create({
      gravity: { x: 0, y: 0.035, scale: 0.001 },
      positionIterations: 6,
      velocityIterations: 4,
    });

    const wallOptions: Matter.IChamferableBodyDefinition = {
      isStatic: true,
      restitution: 0.9,
      friction: 0.02,
      frictionStatic: 0.01,
      label: 'wall',
    };

    const topWall = Matter.Bodies.rectangle(
      ARENA_WIDTH / 2,
      -WALL_THICKNESS / 2,
      ARENA_WIDTH + WALL_THICKNESS * 2,
      WALL_THICKNESS,
      wallOptions,
    );
    const bottomWall = Matter.Bodies.rectangle(
      ARENA_WIDTH / 2,
      ARENA_HEIGHT + WALL_THICKNESS / 2,
      ARENA_WIDTH + WALL_THICKNESS * 2,
      WALL_THICKNESS,
      wallOptions,
    );
    const leftWall = Matter.Bodies.rectangle(
      -WALL_THICKNESS / 2,
      ARENA_HEIGHT / 2,
      WALL_THICKNESS,
      ARENA_HEIGHT + WALL_THICKNESS * 2,
      wallOptions,
    );
    const rightWall = Matter.Bodies.rectangle(
      ARENA_WIDTH + WALL_THICKNESS / 2,
      ARENA_HEIGHT / 2,
      WALL_THICKNESS,
      ARENA_HEIGHT + WALL_THICKNESS * 2,
      wallOptions,
    );

    Matter.Composite.add(engine.world, [topWall, bottomWall, leftWall, rightWall]);

    Matter.Events.on(engine, 'collisionStart', (event) => {
      if (this.status !== 'PLAYING' || this.isPaused) return;
      for (const pair of event.pairs) {
        this.handleCollisionPair(pair.bodyA, pair.bodyB);
      }
    });

    return engine;
  }

  private computeBalloonRadius(): number {
    const count = Math.max(1, this.balloons.size);
    if (count <= 20) return 38;
    if (count <= 35) return 34;
    return 30;
  }

  private createBalloonBody(x: number, y: number, radius: number, playerId: string): Matter.Body {
    const body = Matter.Bodies.circle(x, y, radius, {
      restitution: 0.92,
      friction: 0.015,
      frictionAir: 0.024,
      density: 0.0012,
      label: `balloon:${playerId}`,
    });
    this.bodyToPlayerId.set(body.id, playerId);
    Matter.Composite.add(this.engine.world, body);
    return body;
  }

  private removeBalloonBody(balloon: InternalBalloon): void {
    if (!balloon.body) return;
    this.bodyToPlayerId.delete(balloon.body.id);
    Matter.Composite.remove(this.engine.world, balloon.body);
    balloon.body = null;
  }

  private clearAllBodies(): void {
    for (const b of this.balloons.values()) {
      this.removeBalloonBody(b);
    }
    this.bodyToPlayerId.clear();
  }

  private findSafeSpawnPosition(radius: number, ignorePlayerId?: string): { x: number; y: number } {
    const pad = radius + 28;
    let bestX = ARENA_WIDTH / 2;
    let bestY = ARENA_HEIGHT / 2;
    let bestMinDist = -1;

    for (let attempt = 0; attempt < 36; attempt++) {
      const cx = pad + Math.random() * (ARENA_WIDTH - pad * 2);
      const cy = pad + Math.random() * (ARENA_HEIGHT - pad * 2);
      let minDist = Infinity;

      for (const other of this.balloons.values()) {
        if (other.playerId === ignorePlayerId || other.status !== 'alive') continue;
        const dx = cx - other.x;
        const dy = cy - other.y;
        const dist = Math.hypot(dx, dy) - (radius + other.radius);
        if (dist < minDist) minDist = dist;
      }

      if (minDist > 42) {
        return { x: cx, y: cy };
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestX = cx;
        bestY = cy;
      }
    }

    return { x: bestX, y: bestY };
  }

  private assignStagedGridPositions(): void {
    const list = Array.from(this.balloons.values());
    const count = list.length;
    if (count === 0) return;

    const radius = this.computeBalloonRadius();
    const cols = Math.ceil(Math.sqrt(count * (ARENA_WIDTH / ARENA_HEIGHT)));
    const rows = Math.ceil(count / cols);
    const marginX = radius + 48;
    const marginY = radius + 48;
    const usableW = Math.max(100, ARENA_WIDTH - marginX * 2);
    const usableH = Math.max(100, ARENA_HEIGHT - marginY * 2);
    const stepX = cols > 1 ? usableW / (cols - 1) : 0;
    const stepY = rows > 1 ? usableH / (rows - 1) : 0;

    list.forEach((b, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const jitterX = ((idx * 37) % 19) - 9;
      const jitterY = ((idx * 53) % 19) - 9;
      const x = Math.max(marginX, Math.min(ARENA_WIDTH - marginX, marginX + col * stepX + jitterX));
      const y = Math.max(marginY, Math.min(ARENA_HEIGHT - marginY, marginY + row * stepY + jitterY));
      b.radius = radius;
      b.x = x;
      b.y = y;
      b.vx = 0;
      b.vy = 0;
      this.removeBalloonBody(b);
      b.body = this.createBalloonBody(x, y, radius, b.playerId);
    });
  }

  // ---- Roster & Host Admin Controls ----
  public setTitle(title: string): void {
    const clean = title.trim().slice(0, 80);
    if (clean.length > 0) {
      this.title = clean;
    }
  }

  public addCousin(name: string, explicitId?: string, explicitColor?: string): InternalBalloon | null {
    if (this.status === 'PLAYING' || this.status === 'COUNTDOWN') return null;
    if (this.balloons.size >= MAX_PARTICIPANTS) return null;
    const cleanName = name.trim().replace(/\s+/g, ' ').slice(0, 32);
    if (!cleanName) return null;

    const index = this.balloons.size;
    const playerId = explicitId && /^[a-zA-Z0-9_-]{1,64}$/.test(explicitId)
      ? explicitId
      : `cousin-${crypto.randomBytes(4).toString('hex')}`;
    if (this.balloons.has(playerId)) return this.balloons.get(playerId)!;

    const balloonId = `balloon-${playerId}`;
    const radius = this.computeBalloonRadius();
    const pos = this.findSafeSpawnPosition(radius);
    const color = explicitColor && /^#[0-9a-fA-F]{6}$/.test(explicitColor)
      ? explicitColor
      : getCousinColor(index);

    const balloon: InternalBalloon = {
      playerId,
      balloonId,
      name: cleanName,
      color,
      ownerUid: null,
      ownerDisplayName: null,
      connected: false,
      ready: false,
      body: null,
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      radius,
      health: STARTING_HEALTH,
      score: 0,
      hits: 0,
      pops: 0,
      status: 'alive',
      respawnsUsed: 0,
      respawnAt: null,
      spawnProtectedUntil: 0,
      shieldActiveUntil: 0,
      shieldCooldownUntil: 0,
      lastSurvivorBonus: false,
      floatPhase: (index * 1.17) % (Math.PI * 2),
      lastImpulse: null,
      cooldowns: { KICK: 0, THROW: 0, SHIELD: 0, SLAP: 0 },
      seenActionIds: new Set(),
      seenActionOrder: [],
      lastSeq: -1,
    };

    balloon.body = this.createBalloonBody(pos.x, pos.y, radius, playerId);
    this.balloons.set(playerId, balloon);
    return balloon;
  }

  public bulkAddCousins(names: string[]): InternalBalloon[] {
    const added: InternalBalloon[] = [];
    for (const raw of names) {
      if (this.balloons.size >= MAX_PARTICIPANTS) break;
      const b = this.addCousin(raw);
      if (b) added.push(b);
    }
    if (added.length > 0 && (this.status === 'WAITING' || this.status === 'READY')) {
      this.assignStagedGridPositions();
    }
    return added;
  }

  public syncRosterFromFirestore(
    cousins: Array<{ playerId: string; name: string; color: string; ownerUid?: string | null }>,
  ): void {
    if (this.status === 'PLAYING' || this.status === 'COUNTDOWN') return;
    if (this.balloons.size > 0) return; // Never overwrite active in-memory room state
    for (const item of cousins.slice(0, MAX_PARTICIPANTS)) {
      const b = this.addCousin(item.name, item.playerId, item.color);
      if (b && item.ownerUid) {
        b.ownerUid = item.ownerUid;
      }
    }
    if (this.balloons.size > 0) {
      this.assignStagedGridPositions();
    }
  }

  public editCousin(playerId: string, name: string, color?: string): boolean {
    if (this.status === 'PLAYING' || this.status === 'COUNTDOWN') return false;
    const b = this.balloons.get(playerId);
    if (!b) return false;
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 32);
    if (!clean) return false;
    b.name = clean;
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
      b.color = color;
    }
    return true;
  }

  public removeCousin(playerId: string): boolean {
    if (this.status === 'PLAYING' || this.status === 'COUNTDOWN') return false;
    const b = this.balloons.get(playerId);
    if (!b) return false;
    this.removeBalloonBody(b);
    this.balloons.delete(playerId);
    for (const conn of this.activeConnections.values()) {
      if (conn.claimedPlayerId === playerId) {
        conn.claimedPlayerId = null;
        conn.claimedName = null;
      }
    }
    return true;
  }

  public generateBalloons(): boolean {
    if (this.status === 'PLAYING' || this.status === 'COUNTDOWN') return false;
    if (this.balloons.size === 0) return false;
    this.isPaused = false;
    this.lastSurvivorAwarded = false;
    this.timeRemainingMs = ROUND_DURATION_MS;
    this.countdownRemainingMs = 0;
    this.pairHitCooldowns.clear();

    for (const b of this.balloons.values()) {
      b.health = STARTING_HEALTH;
      b.status = 'alive';
      b.respawnsUsed = 0;
      b.respawnAt = null;
      b.spawnProtectedUntil = 0;
      b.shieldActiveUntil = 0;
      b.shieldCooldownUntil = 0;
      b.lastSurvivorBonus = false;
      b.lastImpulse = null;
      b.cooldowns = { KICK: 0, THROW: 0, SHIELD: 0, SLAP: 0 };
    }

    this.assignStagedGridPositions();
    this.status = 'READY';
    this.saveCheckpointNow();
    return true;
  }

  public startMatch(): { ok: boolean; reason?: string } {
    if (this.balloons.size < 2) {
      return { ok: false, reason: 'Add at least 2 cousins before starting a match.' };
    }
    if (this.status === 'PLAYING' || this.status === 'COUNTDOWN') {
      return { ok: false, reason: 'Match is already active.' };
    }
    // Always stage balloons fresh before countdown
    this.generateBalloons();
    this.status = 'COUNTDOWN';
    this.countdownRemainingMs = COUNTDOWN_DURATION_MS;
    this.timeRemainingMs = ROUND_DURATION_MS;
    this.isPaused = false;
    this.recoveredFromCheckpoint = false;
    this.lastSurvivorAwarded = false;
    this.saveCheckpointNow();
    return { ok: true };
  }

  public pauseMatch(): boolean {
    if (this.status !== 'PLAYING' && this.status !== 'COUNTDOWN') return false;
    this.isPaused = true;
    this.saveCheckpointNow();
    return true;
  }

  public resumeMatch(): boolean {
    if (this.status !== 'PLAYING' && this.status !== 'COUNTDOWN') return false;
    this.isPaused = false;
    this.recoveredFromCheckpoint = false;
    this.saveCheckpointNow();
    return true;
  }

  public endMatch(): boolean {
    if (this.status !== 'PLAYING' && this.status !== 'COUNTDOWN') return false;
    this.finishMatch();
    return true;
  }

  public restartMatch(): { ok: boolean; reason?: string } {
    if (this.balloons.size < 2) {
      return { ok: false, reason: 'Add at least 2 cousins before restarting.' };
    }
    this.roundNumber += 1;
    this.resetScores(false);
    return this.startMatch();
  }

  public resetScores(resetToWaiting = false): void {
    this.lastSurvivorAwarded = false;
    for (const b of this.balloons.values()) {
      b.score = 0;
      b.hits = 0;
      b.pops = 0;
      b.lastSurvivorBonus = false;
      b.health = STARTING_HEALTH;
      b.status = 'alive';
      b.respawnsUsed = 0;
      b.respawnAt = null;
      b.spawnProtectedUntil = 0;
      b.shieldActiveUntil = 0;
      b.shieldCooldownUntil = 0;
    }
    if (resetToWaiting) {
      this.status = this.balloons.size > 0 ? 'READY' : 'WAITING';
      this.isPaused = false;
      this.timeRemainingMs = ROUND_DURATION_MS;
      this.assignStagedGridPositions();
    }
    this.saveCheckpointNow();
  }

  // ---- Connection & Claim Management ----
  public registerConnection(uid: string, displayName: string, isHost: boolean): string | null {
    // Reconnect: automatically find any balloon previously owned by this verified UID
    let existingClaim: InternalBalloon | null = null;
    for (const b of this.balloons.values()) {
      if (b.ownerUid === uid) {
        b.connected = true;
        b.ownerDisplayName = displayName;
        existingClaim = b;
        break;
      }
    }

    this.activeConnections.set(uid, {
      uid,
      displayName,
      isHost,
      claimedPlayerId: existingClaim?.playerId ?? null,
      claimedName: existingClaim?.name ?? null,
      connectedAt: this.now(),
    });

    return existingClaim?.playerId ?? null;
  }

  public unregisterConnection(uid: string): void {
    this.activeConnections.delete(uid);
    for (const b of this.balloons.values()) {
      if (b.ownerUid === uid) {
        b.connected = false;
      }
    }
  }

  public claimBalloon(
    uid: string,
    displayName: string,
    playerId: string | null,
  ): { ok: boolean; claimedPlayerId: string | null; reason?: string } {
    if (!playerId) {
      // Unclaim any currently claimed balloon (spectator mode)
      for (const b of this.balloons.values()) {
        if (b.ownerUid === uid) {
          b.ownerUid = null;
          b.ownerDisplayName = null;
          b.connected = false;
          b.ready = false;
        }
      }
      const conn = this.activeConnections.get(uid);
      if (conn) {
        conn.claimedPlayerId = null;
        conn.claimedName = null;
      }
      return { ok: true, claimedPlayerId: null };
    }

    const target = this.balloons.get(playerId);
    if (!target) {
      return { ok: false, claimedPlayerId: null, reason: 'Cousin balloon not found.' };
    }
    if (target.ownerUid && target.ownerUid !== uid) {
      return {
        ok: false,
        claimedPlayerId: null,
        reason: `${target.name} is already claimed by another player.`,
      };
    }

    // Release any previous balloon claimed by this UID
    for (const b of this.balloons.values()) {
      if (b.ownerUid === uid && b.playerId !== playerId) {
        b.ownerUid = null;
        b.ownerDisplayName = null;
        b.connected = false;
        b.ready = false;
      }
    }

    target.ownerUid = uid;
    target.ownerDisplayName = displayName;
    target.connected = true;

    const conn = this.activeConnections.get(uid);
    if (conn) {
      conn.claimedPlayerId = target.playerId;
      conn.claimedName = target.name;
    }

    return { ok: true, claimedPlayerId: target.playerId };
  }

  public setPlayerReady(uid: string, playerId: string, ready: boolean): ActionResult {
    const b = this.balloons.get(playerId);
    if (!b) return { accepted: false, reason: 'Balloon not found.' };
    if (b.ownerUid !== uid) return { accepted: false, reason: 'Cannot change ready state for another player.' };
    if (this.status !== 'WAITING' && this.status !== 'READY') {
      return { accepted: false, reason: 'Match already started.' };
    }
    b.ready = Boolean(ready);
    return { accepted: true };
  }

  // ---- Authoritative Action Validation & Execution ----
  private recordActionId(b: InternalBalloon, actionId: string, seq: number): ActionResult {
    if (typeof actionId !== 'string' || actionId.length < 3 || actionId.length > 80) {
      return { accepted: false, reason: 'Invalid action ID.' };
    }
    if (b.seenActionIds.has(actionId)) {
      return { accepted: false, reason: 'Duplicate action ID rejected.' };
    }
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) {
      return { accepted: false, reason: 'Invalid sequence number.' };
    }
    b.seenActionIds.add(actionId);
    b.seenActionOrder.push(actionId);
    if (b.seenActionOrder.length > MAX_SEEN_ACTIONS_PER_PLAYER) {
      const oldest = b.seenActionOrder.shift();
      if (oldest) b.seenActionIds.delete(oldest);
    }
    if (seq > b.lastSeq) b.lastSeq = seq;
    return { accepted: true };
  }

  private normalizeDirection(dx: number, dy: number): { nx: number; ny: number } | null {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return null;
    return { nx: dx / len, ny: dy / len };
  }

  public handlePlayerAction(
    authenticatedUid: string,
    payload: {
      type: 'KICK' | 'THROW' | 'SHIELD' | 'SLAP';
      actionId: string;
      playerId: string;
      roomId: string;
      seq: number;
      dx?: number;
      dy?: number;
      power?: number;
      targetBalloonId?: string | null;
    },
  ): ActionResult {
    if (payload.roomId !== this.roomId) {
      return { accepted: false, reason: 'Invalid room ID.' };
    }
    if (this.status !== 'PLAYING' || this.isPaused) {
      return { accepted: false, reason: 'Match is not actively playing.' };
    }

    const actor = this.balloons.get(payload.playerId);
    if (!actor) {
      return { accepted: false, reason: 'Player is not in this room.' };
    }
    if (actor.ownerUid !== authenticatedUid) {
      return { accepted: false, reason: 'Unauthorized: cannot act for another player.' };
    }
    if (actor.status !== 'alive' || !actor.body) {
      return { accepted: false, reason: 'Balloon is not currently alive.' };
    }

    const dedup = this.recordActionId(actor, payload.actionId, payload.seq);
    if (!dedup.accepted) return dedup;

    const now = this.now();

    if (payload.type === 'SHIELD') {
      if (now < actor.shieldCooldownUntil) {
        return { accepted: false, reason: 'Shield is on cooldown.' };
      }
      actor.shieldActiveUntil = now + SHIELD_DURATION_MS;
      actor.shieldCooldownUntil = now + SHIELD_COOLDOWN_MS;
      actor.cooldowns.SHIELD = actor.shieldCooldownUntil;
      this.emitEvent({
        type: 'SHIELD_ON',
        x: actor.x,
        y: actor.y,
        color: actor.color,
        attackerPlayerId: actor.playerId,
        attackerName: actor.name,
      });
      return { accepted: true };
    }

    if (payload.type === 'SLAP') {
      if (now < actor.cooldowns.SLAP) {
        return { accepted: false, reason: 'Slap is on cooldown.' };
      }
      actor.cooldowns.SLAP = now + SLAP_COOLDOWN_MS;

      let slappedAny = false;
      for (const target of this.balloons.values()) {
        if (target.playerId === actor.playerId || target.status !== 'alive' || !target.body) continue;
        const dx = target.x - actor.x;
        const dy = target.y - actor.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= SLAP_RANGE + target.radius) {
          slappedAny = true;
          const nx = dist > 0.01 ? dx / dist : 1;
          const ny = dist > 0.01 ? dy / dist : 0;
          const pushSpeed = 14.5;
          Matter.Body.setVelocity(target.body, {
            x: target.body.velocity.x + nx * pushSpeed,
            y: target.body.velocity.y + ny * pushSpeed,
          });
          this.clampBodySpeed(target.body);
          target.lastImpulse = {
            attackerPlayerId: actor.playerId,
            actionId: payload.actionId,
            expiresAt: now + 3500,
          };
          this.applyAuthoritativeDamage(actor, target, 12, now);
        }
      }

      // Small recoil/burst visual even if nobody in range
      this.emitEvent({
        type: 'SLAP',
        x: actor.x,
        y: actor.y,
        color: actor.color,
        attackerPlayerId: actor.playerId,
        attackerName: actor.name,
        damage: slappedAny ? 12 : 0,
      });
      return { accepted: true };
    }

    if (payload.type === 'THROW') {
      if (now < actor.cooldowns.THROW) {
        return { accepted: false, reason: 'Throw is on cooldown.' };
      }
      const dir = this.normalizeDirection(payload.dx ?? 0, payload.dy ?? 0);
      if (!dir) return { accepted: false, reason: 'Invalid throw direction.' };

      const clampedPower = Math.max(0.25, Math.min(1.0, Number(payload.power) || 0.7));
      const launchSpeed = 11 + clampedPower * 11; // max 22
      actor.cooldowns.THROW = now + THROW_COOLDOWN_MS;

      Matter.Body.setVelocity(actor.body, {
        x: dir.nx * launchSpeed,
        y: dir.ny * launchSpeed,
      });
      this.clampBodySpeed(actor.body);
      actor.lastImpulse = {
        attackerPlayerId: actor.playerId,
        actionId: payload.actionId,
        expiresAt: now + 3500,
      };

      this.emitEvent({
        type: 'THROW',
        x: actor.x,
        y: actor.y,
        color: actor.color,
        attackerPlayerId: actor.playerId,
        attackerName: actor.name,
      });
      return { accepted: true };
    }

    if (payload.type === 'KICK') {
      if (now < actor.cooldowns.KICK) {
        return { accepted: false, reason: 'Kick is on cooldown.' };
      }

      // If targeting another balloon specifically (e.g. clicking/tapping opponent balloon within kick reach)
      if (payload.targetBalloonId) {
        const target = Array.from(this.balloons.values()).find(
          (b) => b.balloonId === payload.targetBalloonId || b.playerId === payload.targetBalloonId,
        );
        if (!target || target.status !== 'alive' || !target.body) {
          return { accepted: false, reason: 'Target balloon is not valid or alive.' };
        }
        if (target.playerId === actor.playerId) {
          return { accepted: false, reason: 'Cannot target self with targeted kick.' };
        }
        const dist = Math.hypot(target.x - actor.x, target.y - actor.y);
        if (dist > KICK_RANGE + target.radius + actor.radius) {
          return { accepted: false, reason: 'Target balloon is out of kick range.' };
        }

        const dir =
          this.normalizeDirection(payload.dx ?? target.x - actor.x, payload.dy ?? target.y - actor.y) ?? {
            nx: 1,
            ny: 0,
          };
        const clampedPower = Math.max(0.3, Math.min(1.0, Number(payload.power) || 0.85));
        const kickSpeed = 13 + clampedPower * 8;

        actor.cooldowns.KICK = now + KICK_COOLDOWN_MS;
        Matter.Body.setVelocity(target.body, {
          x: dir.nx * kickSpeed,
          y: dir.ny * kickSpeed,
        });
        this.clampBodySpeed(target.body);
        target.lastImpulse = {
          attackerPlayerId: actor.playerId,
          actionId: payload.actionId,
          expiresAt: now + 3500,
        };
        this.applyAuthoritativeDamage(actor, target, 14, now);
        this.emitEvent({
          type: 'KICK',
          x: target.x,
          y: target.y,
          color: actor.color,
          attackerPlayerId: actor.playerId,
          attackerName: actor.name,
          victimPlayerId: target.playerId,
          victimName: target.name,
        });
        return { accepted: true };
      }

      // Directional kick launch of own balloon
      const dir = this.normalizeDirection(payload.dx ?? 0, payload.dy ?? 0);
      if (!dir) return { accepted: false, reason: 'Invalid kick direction.' };
      const clampedPower = Math.max(0.3, Math.min(1.0, Number(payload.power) || 0.85));
      const kickSpeed = 12 + clampedPower * 8;
      actor.cooldowns.KICK = now + KICK_COOLDOWN_MS;

      Matter.Body.setVelocity(actor.body, {
        x: dir.nx * kickSpeed,
        y: dir.ny * kickSpeed,
      });
      this.clampBodySpeed(actor.body);
      actor.lastImpulse = {
        attackerPlayerId: actor.playerId,
        actionId: payload.actionId,
        expiresAt: now + 3500,
      };
      this.emitEvent({
        type: 'KICK',
        x: actor.x,
        y: actor.y,
        color: actor.color,
        attackerPlayerId: actor.playerId,
        attackerName: actor.name,
      });
      return { accepted: true };
    }

    return { accepted: false, reason: 'Unknown action type.' };
  }

  // ---- Collision & Authoritative Damage / Scoring ----
  private handleCollisionPair(bodyA: Matter.Body, bodyB: Matter.Body): void {
    const idA = this.bodyToPlayerId.get(bodyA.id);
    const idB = this.bodyToPlayerId.get(bodyB.id);
    if (!idA || !idB || idA === idB) return;

    const bA = this.balloons.get(idA);
    const bB = this.balloons.get(idB);
    if (!bA || !bB || bA.status !== 'alive' || bB.status !== 'alive') return;

    const relVx = bodyA.velocity.x - bodyB.velocity.x;
    const relVy = bodyA.velocity.y - bodyB.velocity.y;
    const relSpeed = Math.hypot(relVx, relVy);
    if (relSpeed < MIN_DAMAGE_IMPACT_SPEED) return;

    const now = this.now();
    const speedA = Math.hypot(bodyA.velocity.x, bodyA.velocity.y);
    const speedB = Math.hypot(bodyB.velocity.x, bodyB.velocity.y);
    const baseDamage = Math.round(Math.max(8, Math.min(36, (relSpeed - 1.8) * 4.8)));

    // Determine attacker(s): faster / recently launched balloon hits the slower one
    const attackerForB = this.resolveAttacker(bA, now);
    const attackerForA = this.resolveAttacker(bB, now);

    if (speedA >= speedB * 0.85 && attackerForB && attackerForB.playerId !== bB.playerId) {
      this.applyAuthoritativeDamage(attackerForB, bB, baseDamage, now);
    }
    if (speedB >= speedA * 0.85 && attackerForA && attackerForA.playerId !== bA.playerId) {
      this.applyAuthoritativeDamage(attackerForA, bA, baseDamage, now);
    }
  }

  private resolveAttacker(source: InternalBalloon, now: number): InternalBalloon | null {
    if (source.lastImpulse && source.lastImpulse.expiresAt >= now) {
      return this.balloons.get(source.lastImpulse.attackerPlayerId) ?? source;
    }
    return source;
  }

  private applyAuthoritativeDamage(
    attacker: InternalBalloon,
    victim: InternalBalloon,
    damage: number,
    now: number,
  ): void {
    if (attacker.playerId === victim.playerId) return; // Zero points & damage for self-hits
    if (victim.status !== 'alive') return;

    // Anti-farming per-pair cooldown
    const pairKey = `${attacker.playerId}->${victim.playerId}`;
    const blockedUntil = this.pairHitCooldowns.get(pairKey) ?? 0;
    if (now < blockedUntil) return;
    this.pairHitCooldowns.set(pairKey, now + PAIR_HIT_COOLDOWN_MS);

    // Spawn protection (2s after respawn)
    if (now < victim.spawnProtectedUntil) {
      this.emitEvent({
        type: 'SHIELD_BLOCK',
        x: victim.x,
        y: victim.y,
        color: victim.color,
        attackerPlayerId: attacker.playerId,
        victimPlayerId: victim.playerId,
        victimName: victim.name,
      });
      return;
    }

    // Active Shield blocks collision damage & reflects attacker
    if (now < victim.shieldActiveUntil) {
      if (attacker.body && victim.body) {
        const dx = attacker.x - victim.x;
        const dy = attacker.y - victim.y;
        const d = Math.hypot(dx, dy) || 1;
        Matter.Body.setVelocity(attacker.body, {
          x: (dx / d) * 14,
          y: (dy / d) * 14,
        });
      }
      this.emitEvent({
        type: 'SHIELD_BLOCK',
        x: victim.x,
        y: victim.y,
        color: victim.color,
        attackerPlayerId: attacker.playerId,
        victimPlayerId: victim.playerId,
        victimName: victim.name,
      });
      return;
    }

    // Apply damage & award valid opponent hit (+5 pts)
    victim.health = Math.max(0, victim.health - damage);
    attacker.score += POINTS_VALID_HIT;
    attacker.hits += 1;

    this.emitEvent({
      type: 'HIT',
      x: victim.x,
      y: victim.y,
      color: victim.color,
      attackerPlayerId: attacker.playerId,
      attackerName: attacker.name,
      victimPlayerId: victim.playerId,
      victimName: victim.name,
      damage,
      points: POINTS_VALID_HIT,
    });

    if (victim.health <= 0) {
      this.processPop(attacker, victim, now);
    }
  }

  private processPop(attacker: InternalBalloon, victim: InternalBalloon, now: number): void {
    if (victim.status !== 'alive') return; // Prevent duplicate pop points

    attacker.score += POINTS_POP;
    attacker.pops += 1;

    const popX = victim.x;
    const popY = victim.y;
    this.removeBalloonBody(victim);
    victim.vx = 0;
    victim.vy = 0;
    victim.shieldActiveUntil = 0;

    let isEliminated = false;
    if (victim.respawnsUsed < MAX_RESPAWNS_PER_ROUND) {
      // First pop: 3-second respawn countdown
      victim.respawnsUsed += 1;
      victim.status = 'respawning';
      victim.respawnAt = now + RESPAWN_DELAY_MS;
    } else {
      // Second pop: eliminated until next round
      victim.status = 'eliminated';
      victim.respawnAt = null;
      isEliminated = true;
    }

    this.emitEvent({
      type: 'POP',
      x: popX,
      y: popY,
      color: victim.color,
      attackerPlayerId: attacker.playerId,
      attackerName: attacker.name,
      victimPlayerId: victim.playerId,
      victimName: victim.name,
      points: POINTS_POP,
      isEliminated,
    });

    if (isEliminated) {
      this.checkLastSurvivorCondition();
    }
  }

  private checkLastSurvivorCondition(): void {
    if (this.status !== 'PLAYING' || this.lastSurvivorAwarded) return;
    if (this.balloons.size < 2) return;

    const alive: InternalBalloon[] = [];
    let respawningCount = 0;

    for (const b of this.balloons.values()) {
      if (b.status === 'alive') alive.push(b);
      else if (b.status === 'respawning') respawningCount += 1;
    }

    if (alive.length === 1 && respawningCount === 0) {
      const survivor = alive[0];
      this.lastSurvivorAwarded = true;
      survivor.score += POINTS_LAST_SURVIVOR;
      survivor.lastSurvivorBonus = true;
      this.emitEvent({
        type: 'LAST_SURVIVOR',
        x: survivor.x,
        y: survivor.y,
        color: survivor.color,
        attackerPlayerId: survivor.playerId,
        attackerName: survivor.name,
        points: POINTS_LAST_SURVIVOR,
      });
      this.finishMatch();
    }
  }

  private finishMatch(): void {
    if (this.status === 'FINISHED') return;

    // Award last surviving balloon bonus if exactly 1 balloon survived at timer end
    if (!this.lastSurvivorAwarded && this.balloons.size >= 2) {
      const alive = Array.from(this.balloons.values()).filter((b) => b.status === 'alive');
      const respawning = Array.from(this.balloons.values()).filter((b) => b.status === 'respawning');
      if (alive.length === 1 && respawning.length === 0) {
        this.lastSurvivorAwarded = true;
        alive[0].score += POINTS_LAST_SURVIVOR;
        alive[0].lastSurvivorBonus = true;
        this.emitEvent({
          type: 'LAST_SURVIVOR',
          x: alive[0].x,
          y: alive[0].y,
          color: alive[0].color,
          attackerPlayerId: alive[0].playerId,
          attackerName: alive[0].name,
          points: POINTS_LAST_SURVIVOR,
        });
      }
    }

    this.status = 'FINISHED';
    this.isPaused = false;
    this.timeRemainingMs = Math.max(0, this.timeRemainingMs);

    const leaderboard = this.computeLeaderboard();
    const winner = leaderboard[0];
    const summary: MatchSummary = {
      matchId: `match-r${this.roundNumber}-${this.now()}`,
      roomId: this.roomId,
      roundNumber: this.roundNumber,
      winnerName: winner?.name ?? 'No Winner',
      winnerScore: winner?.score ?? 0,
      participantCount: this.balloons.size,
      durationSeconds: Math.round((ROUND_DURATION_MS - this.timeRemainingMs) / 1000),
      leaderboard,
      finishedAt: this.now(),
    };

    this.saveCheckpointNow();
    this.callbacks.onMatchFinished?.(summary);
  }

  private clampBodySpeed(body: Matter.Body): void {
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    if (speed > MAX_BALLOON_SPEED) {
      const ratio = MAX_BALLOON_SPEED / speed;
      Matter.Body.setVelocity(body, {
        x: body.velocity.x * ratio,
        y: body.velocity.y * ratio,
      });
    }
  }

  // ---- Fixed-Timestep 30 Hz Authoritative Simulation Tick ----
  public step(dtMs: number = FIXED_DT_MS): void {
    const safeDt = Math.min(Math.max(dtMs, 1), 50);
    const now = this.now();
    this.tick += 1;

    if (this.status === 'COUNTDOWN' && !this.isPaused) {
      this.countdownRemainingMs = Math.max(0, this.countdownRemainingMs - safeDt);
      if (this.countdownRemainingMs <= 0) {
        this.status = 'PLAYING';
        this.timeRemainingMs = ROUND_DURATION_MS;
        // Give gentle initial floating drift so balloons start lively
        for (const b of this.balloons.values()) {
          if (b.body) {
            Matter.Body.setVelocity(b.body, {
              x: (Math.random() - 0.5) * 2.5,
              y: (Math.random() - 0.5) * 2.5,
            });
          }
        }
      }
      return;
    }

    if (this.status === 'WAITING' || this.status === 'READY') {
      // Gentle idle floating motion in lobby/staging
      for (const b of this.balloons.values()) {
        if (!b.body) continue;
        b.floatPhase += 0.04;
        Matter.Body.applyForce(b.body, b.body.position, {
          x: Math.cos(b.floatPhase * 0.7) * 0.00018,
          y: Math.sin(b.floatPhase) * 0.00022 - 0.00004,
        });
      }
      const halfDt = safeDt / 2;
      Matter.Engine.update(this.engine, halfDt);
      Matter.Engine.update(this.engine, halfDt);
      this.syncPositionsFromBodies();
      return;
    }

    if (this.status !== 'PLAYING' || this.isPaused) {
      return;
    }

    // Countdown 90s authoritative round timer
    this.timeRemainingMs = Math.max(0, this.timeRemainingMs - safeDt);
    if (this.timeRemainingMs <= 0) {
      this.finishMatch();
      return;
    }

    // Handle authoritative respawns
    for (const b of this.balloons.values()) {
      if (b.status === 'respawning' && b.respawnAt !== null && now >= b.respawnAt) {
        const pos = this.findSafeSpawnPosition(b.radius, b.playerId);
        b.x = pos.x;
        b.y = pos.y;
        b.vx = 0;
        b.vy = 0;
        b.health = STARTING_HEALTH;
        b.status = 'alive';
        b.respawnAt = null;
        b.spawnProtectedUntil = now + SPAWN_PROTECTION_MS;
        b.body = this.createBalloonBody(pos.x, pos.y, b.radius, b.playerId);
        this.emitEvent({
          type: 'RESPAWN',
          x: b.x,
          y: b.y,
          color: b.color,
          victimPlayerId: b.playerId,
          victimName: b.name,
        });
      }
    }

    // Subtle helium buoyancy & floating bobbing forces
    for (const b of this.balloons.values()) {
      if (b.status !== 'alive' || !b.body) continue;
      b.floatPhase += 0.055;
      Matter.Body.applyForce(b.body, b.body.position, {
        x: Math.cos(b.floatPhase * 0.8) * 0.00016,
        y: Math.sin(b.floatPhase) * 0.0002 - 0.00005,
      });
      this.clampBodySpeed(b.body);
    }

    const halfDt = safeDt / 2;
    Matter.Engine.update(this.engine, halfDt);
    Matter.Engine.update(this.engine, halfDt);
    this.syncPositionsFromBodies();

    // Periodic checkpoint every 5 seconds during active play
    if (now - this.lastCheckpointSaveClock >= 5_000) {
      this.saveCheckpointNow();
    }
  }

  private syncPositionsFromBodies(): void {
    for (const b of this.balloons.values()) {
      if (!b.body) continue;
      // Keep strictly inside arena bounds
      const minX = b.radius + 4;
      const maxX = ARENA_WIDTH - b.radius - 4;
      const minY = b.radius + 4;
      const maxY = ARENA_HEIGHT - b.radius - 4;
      let clampedX = b.body.position.x;
      let clampedY = b.body.position.y;
      if (clampedX < minX || clampedX > maxX || clampedY < minY || clampedY > maxY) {
        clampedX = Math.max(minX, Math.min(maxX, clampedX));
        clampedY = Math.max(minY, Math.min(maxY, clampedY));
        Matter.Body.setPosition(b.body, { x: clampedX, y: clampedY });
      }
      b.x = clampedX;
      b.y = clampedY;
      b.vx = b.body.velocity.x;
      b.vy = b.body.velocity.y;
    }
  }

  private emitEvent(partial: Omit<GameEvent, 'id' | 'tick' | 'timestamp'>): void {
    this.pendingEvents.push({
      ...partial,
      id: `ev-${this.tick}-${crypto.randomBytes(3).toString('hex')}`,
      tick: this.tick,
      timestamp: this.now(),
    });
    if (this.pendingEvents.length > 60) {
      this.pendingEvents.shift();
    }
  }

  public computeLeaderboard(): LeaderboardEntry[] {
    const sorted = Array.from(this.balloons.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.pops !== a.pops) return b.pops - a.pops;
      if (a.status === 'alive' && b.status !== 'alive') return -1;
      if (b.status === 'alive' && a.status !== 'alive') return 1;
      return a.name.localeCompare(b.name);
    });
    return sorted.map((b, i) => ({
      rank: i + 1,
      playerId: b.playerId,
      balloonId: b.balloonId,
      name: b.name,
      color: b.color,
      score: b.score,
      pops: b.pops,
      hits: b.hits,
      status: b.status,
      lastSurvivorBonus: b.lastSurvivorBonus,
    }));
  }

  public buildSnapshot(drainEvents = false): RoomSnapshot {
    const now = this.now();
    const balloons: BalloonSnapshot[] = Array.from(this.balloons.values()).map((b) => ({
      balloonId: b.balloonId,
      playerId: b.playerId,
      name: b.name,
      color: b.color,
      x: Math.round(b.x * 10) / 10,
      y: Math.round(b.y * 10) / 10,
      vx: Math.round(b.vx * 100) / 100,
      vy: Math.round(b.vy * 100) / 100,
      radius: b.radius,
      health: b.health,
      maxHealth: STARTING_HEALTH,
      score: b.score,
      hits: b.hits,
      pops: b.pops,
      status: b.status,
      respawnsUsed: b.respawnsUsed,
      respawnRemainingMs:
        b.status === 'respawning' && b.respawnAt ? Math.max(0, b.respawnAt - now) : 0,
      spawnProtected: now < b.spawnProtectedUntil,
      spawnProtectedRemainingMs: Math.max(0, b.spawnProtectedUntil - now),
      shieldActive: now < b.shieldActiveUntil,
      shieldRemainingMs: Math.max(0, b.shieldActiveUntil - now),
      shieldCooldownRemainingMs: Math.max(0, b.shieldCooldownUntil - now),
      ownerUid: b.ownerUid,
      connected: b.connected,
      ready: b.ready,
    }));

    const events = drainEvents ? this.pendingEvents.splice(0, this.pendingEvents.length) : [...this.pendingEvents];

    return {
      roomId: this.roomId,
      title: this.title,
      status: this.status,
      isPaused: this.isPaused,
      roundNumber: this.roundNumber,
      roundDurationMs: ROUND_DURATION_MS,
      timeRemainingMs: Math.round(this.timeRemainingMs),
      countdownRemainingMs: Math.round(this.countdownRemainingMs),
      serverTime: now,
      tick: this.tick,
      arenaWidth: ARENA_WIDTH,
      arenaHeight: ARENA_HEIGHT,
      maxParticipants: MAX_PARTICIPANTS,
      recoveredFromCheckpoint: this.recoveredFromCheckpoint,
      lastCheckpointAt: this.lastCheckpointAt,
      balloons,
      leaderboard: this.computeLeaderboard(),
      events,
      connectedCount: this.activeConnections.size,
      connections: Array.from(this.activeConnections.values()),
    };
  }

  // ---- Checkpoint & Server Restart Recovery ----
  public serializeCheckpoint(): CheckpointData {
    const now = this.now();
    return {
      version: 1,
      roomId: this.roomId,
      title: this.title,
      status: this.status,
      roundNumber: this.roundNumber,
      timeRemainingMs: Math.round(this.timeRemainingMs),
      savedAt: now,
      lastSurvivorAwarded: this.lastSurvivorAwarded,
      balloons: Array.from(this.balloons.values()).map((b) => ({
        playerId: b.playerId,
        balloonId: b.balloonId,
        name: b.name,
        color: b.color,
        ownerUid: b.ownerUid,
        ownerDisplayName: b.ownerDisplayName,
        x: b.x,
        y: b.y,
        vx: b.vx,
        vy: b.vy,
        health: b.health,
        score: b.score,
        hits: b.hits,
        pops: b.pops,
        status: b.status,
        respawnsUsed: b.respawnsUsed,
        respawnRemainingMs:
          b.status === 'respawning' && b.respawnAt ? Math.max(0, b.respawnAt - now) : 0,
        ready: b.ready,
      })),
    };
  }

  public saveCheckpointNow(): void {
    const data = this.serializeCheckpoint();
    this.lastCheckpointAt = data.savedAt;
    this.lastCheckpointSaveClock = data.savedAt;

    if (this.checkpointPath) {
      try {
        const tmpPath = `${this.checkpointPath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
        fs.renameSync(tmpPath, this.checkpointPath);
      } catch {
        // Non-fatal on ephemeral filesystems
      }
    }
    this.callbacks.onCheckpointSaved?.(data);
  }

  public restoreFromCheckpoint(data: CheckpointData): boolean {
    if (!data || data.version !== 1 || data.roomId !== this.roomId || !Array.isArray(data.balloons)) {
      return false;
    }

    this.clearAllBodies();
    this.balloons.clear();
    this.pairHitCooldowns.clear();

    this.title = data.title || this.title;
    this.roundNumber = Math.max(1, data.roundNumber || 1);
    this.timeRemainingMs = Math.max(0, Math.min(ROUND_DURATION_MS, data.timeRemainingMs ?? ROUND_DURATION_MS));
    this.lastSurvivorAwarded = Boolean(data.lastSurvivorAwarded);
    this.lastCheckpointAt = data.savedAt || this.now();

    // If server restarted during an active match, restore PAUSED so Host can safely resume or restart
    if (data.status === 'PLAYING' || data.status === 'COUNTDOWN') {
      this.status = 'PLAYING';
      this.isPaused = true;
      this.recoveredFromCheckpoint = true;
    } else {
      this.status = data.status;
      this.isPaused = false;
      this.recoveredFromCheckpoint = data.balloons.length > 0;
    }

    const now = this.now();
    const count = data.balloons.length;
    const radius = count <= 20 ? 38 : count <= 35 ? 34 : 30;

    data.balloons.slice(0, MAX_PARTICIPANTS).forEach((item, idx) => {
      const b: InternalBalloon = {
        playerId: item.playerId,
        balloonId: item.balloonId,
        name: item.name,
        color: item.color,
        ownerUid: item.ownerUid ?? null,
        ownerDisplayName: item.ownerDisplayName ?? null,
        connected: false,
        ready: Boolean(item.ready),
        body: null,
        x: item.x,
        y: item.y,
        vx: item.vx,
        vy: item.vy,
        radius,
        health: item.health,
        score: item.score,
        hits: item.hits,
        pops: item.pops,
        status: item.status,
        respawnsUsed: item.respawnsUsed,
        respawnAt: item.status === 'respawning' ? now + Math.max(500, item.respawnRemainingMs) : null,
        spawnProtectedUntil: 0,
        shieldActiveUntil: 0,
        shieldCooldownUntil: 0,
        lastSurvivorBonus: false,
        floatPhase: (idx * 1.17) % (Math.PI * 2),
        lastImpulse: null,
        cooldowns: { KICK: 0, THROW: 0, SHIELD: 0, SLAP: 0 },
        seenActionIds: new Set(),
        seenActionOrder: [],
        lastSeq: -1,
      };
      if (b.status === 'alive') {
        b.body = this.createBalloonBody(b.x, b.y, radius, b.playerId);
        Matter.Body.setVelocity(b.body, { x: b.vx, y: b.vy });
      }
      this.balloons.set(b.playerId, b);
    });

    return true;
  }

  private tryRestoreFromDisk(): void {
    if (!this.checkpointPath || !fs.existsSync(this.checkpointPath)) return;
    try {
      const raw = fs.readFileSync(this.checkpointPath, 'utf-8');
      const parsed = JSON.parse(raw) as CheckpointData;
      if (parsed && parsed.balloons && parsed.balloons.length > 0) {
        this.restoreFromCheckpoint(parsed);
      }
    } catch {
      // Ignore corrupt checkpoint file
    }
  }

  public getStatus(): RoomStatus {
    return this.status;
  }

  public getIsPaused(): boolean {
    return this.isPaused;
  }

  public getBalloonCount(): number {
    return this.balloons.size;
  }

  public getBalloon(playerId: string): BalloonSnapshot | null {
    const snap = this.buildSnapshot(false);
    return snap.balloons.find((b) => b.playerId === playerId) ?? null;
  }
}
