import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessage,
  FIXED_DT_MS,
  MatchSummary,
  ROOM_ID,
  ServerMessage,
} from '../shared/protocol.ts';
import { TokenVerifierFn, VerifiedUser, verifyFirebaseIdToken } from './authVerifier.ts';
import { CousinsArenaEngine } from './gameEngine.ts';

interface ClientSession {
  ws: WebSocket;
  user: VerifiedUser | null;
  claimedPlayerId: string | null;
  isAlive: boolean;
  connectedAt: number;
  authTimer: ReturnType<typeof setTimeout> | null;
}

export interface ArenaServerInstance {
  engine: CousinsArenaEngine;
  wss: WebSocketServer;
  broadcastSnapshot: () => void;
  close: () => Promise<void>;
}

const MAX_MESSAGE_BYTES = 16 * 1024;
const HEARTBEAT_INTERVAL_MS = 15_000;
const AUTH_TIMEOUT_MS = 15_000;

export function attachAuthoritativeArenaServer(
  httpServer: HttpServer,
  options?: {
    verifyToken?: TokenVerifierFn;
    checkpointPath?: string | null;
    autoTick?: boolean;
  },
): ArenaServerInstance {
  const verifyToken = options?.verifyToken ?? verifyFirebaseIdToken;
  const sessions = new Set<ClientSession>();
  const uidToSession = new Map<string, ClientSession>();

  const sendJson = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  const broadcast = (msg: ServerMessage, predicate?: (s: ClientSession) => boolean): void => {
    const raw = JSON.stringify(msg);
    for (const s of sessions) {
      if (!s.user) continue;
      if (predicate && !predicate(s)) continue;
      if (s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(raw);
      }
    }
  };

  const engine = new CousinsArenaEngine({
    checkpointPath: options?.checkpointPath,
    callbacks: {
      onMatchFinished: (summary: MatchSummary) => {
        broadcast({ type: 'MATCH_FINISHED', summary });
      },
      onCheckpointSaved: (checkpoint) => {
        broadcast(
          {
            type: 'CHECKPOINT_SAVED',
            checkpoint: {
              checkpointId: 'latest',
              roundNumber: checkpoint.roundNumber,
              status: checkpoint.status,
              timeRemainingMs: checkpoint.timeRemainingMs,
              balloonsCount: checkpoint.balloons.length,
              savedAt: checkpoint.savedAt,
            },
          },
          (s) => Boolean(s.user?.isHost),
        );
      },
    },
  });

  const broadcastSnapshot = (): void => {
    if (sessions.size === 0) return;
    const snapshot = engine.buildSnapshot(true);
    broadcast({ type: 'SNAPSHOT', snapshot });
  };

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: MAX_MESSAGE_BYTES,
  });

  wss.on('connection', (ws) => {
    const session: ClientSession = {
      ws,
      user: null,
      claimedPlayerId: null,
      isAlive: true,
      connectedAt: Date.now(),
      authTimer: setTimeout(() => {
        if (!session.user && ws.readyState === WebSocket.OPEN) {
          sendJson(ws, { type: 'AUTH_ERROR', message: 'Authentication timed out.' });
          ws.close(4001, 'Auth timeout');
        }
      }, AUTH_TIMEOUT_MS),
    };

    sessions.add(session);

    ws.on('pong', () => {
      session.isAlive = true;
    });

    ws.on('message', async (rawData) => {
      let msg: ClientMessage;
      try {
        const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
        msg = JSON.parse(text) as ClientMessage;
      } catch {
        sendJson(ws, { type: 'ERROR', code: 'BAD_JSON', message: 'Malformed JSON payload.' });
        return;
      }

      if (!msg || typeof msg.type !== 'string') {
        sendJson(ws, { type: 'ERROR', code: 'BAD_MESSAGE', message: 'Missing message type.' });
        return;
      }

      // Heartbeat allowed at any time
      if (msg.type === 'HEARTBEAT_PING') {
        session.isAlive = true;
        sendJson(ws, {
          type: 'HEARTBEAT_PONG',
          clientTime: Number(msg.clientTime) || Date.now(),
          serverTime: Date.now(),
        });
        return;
      }

      // Authenticate socket via Firebase ID token
      if (msg.type === 'AUTH') {
        try {
          const verified = await verifyToken(msg.idToken);
          if (session.authTimer) {
            clearTimeout(session.authTimer);
            session.authTimer = null;
          }

          // Replace any stale socket for the same UID cleanly (supports mobile reconnects)
          const previous = uidToSession.get(verified.uid);
          if (previous && previous !== session) {
            previous.user = null;
            sessions.delete(previous);
            try {
              previous.ws.close(4000, 'Replaced by new connection');
            } catch {
              // ignore
            }
          }

          session.user = verified;
          uidToSession.set(verified.uid, session);
          const restoredPlayerId = engine.registerConnection(
            verified.uid,
            verified.displayName,
            verified.isHost,
          );
          session.claimedPlayerId = restoredPlayerId;

          sendJson(ws, {
            type: 'AUTH_OK',
            uid: verified.uid,
            displayName: verified.displayName,
            isHost: verified.isHost,
            claimedPlayerId: restoredPlayerId,
          });
          sendJson(ws, { type: 'SNAPSHOT', snapshot: engine.buildSnapshot(false) });
        } catch (err) {
          sendJson(ws, {
            type: 'AUTH_ERROR',
            message: err instanceof Error ? err.message : 'Authentication failed.',
          });
          ws.close(4003, 'Unauthorized');
        }
        return;
      }

      // All subsequent messages strictly require an authenticated user
      if (!session.user) {
        sendJson(ws, { type: 'AUTH_ERROR', message: 'Sign in required before sending commands.' });
        return;
      }

      const user = session.user;

      // ---- Room Join / Leave / Ready ----
      if (msg.type === 'JOIN_ROOM') {
        if (msg.roomId !== ROOM_ID) {
          sendJson(ws, { type: 'ERROR', code: 'INVALID_ROOM', message: 'Invalid room ID.' });
          return;
        }
        if (msg.asSpectator) {
          engine.claimBalloon(user.uid, user.displayName, null);
          session.claimedPlayerId = null;
          sendJson(ws, {
            type: 'AUTH_OK',
            uid: user.uid,
            displayName: user.displayName,
            isHost: user.isHost,
            claimedPlayerId: null,
          });
          broadcastSnapshot();
          return;
        }
        if (msg.playerId !== undefined) {
          const result = engine.claimBalloon(user.uid, user.displayName, msg.playerId);
          if (!result.ok) {
            sendJson(ws, { type: 'ERROR', code: 'CLAIM_FAILED', message: result.reason ?? 'Could not claim balloon.' });
            return;
          }
          session.claimedPlayerId = result.claimedPlayerId;
          sendJson(ws, {
            type: 'AUTH_OK',
            uid: user.uid,
            displayName: user.displayName,
            isHost: user.isHost,
            claimedPlayerId: session.claimedPlayerId,
          });
          broadcastSnapshot();
        } else {
          sendJson(ws, { type: 'SNAPSHOT', snapshot: engine.buildSnapshot(false) });
        }
        return;
      }

      if (msg.type === 'LEAVE_ROOM') {
        engine.claimBalloon(user.uid, user.displayName, null);
        session.claimedPlayerId = null;
        broadcastSnapshot();
        return;
      }

      if (msg.type === 'PLAYER_READY') {
        const res = engine.setPlayerReady(user.uid, msg.playerId, msg.ready);
        sendJson(ws, {
          type: 'ACTION_ACK',
          actionId: msg.actionId,
          seq: msg.seq,
          accepted: res.accepted,
          reason: res.reason,
        });
        if (res.accepted) broadcastSnapshot();
        return;
      }

      // ---- Validated Gameplay Actions ----
      if (msg.type === 'KICK' || msg.type === 'THROW' || msg.type === 'SHIELD' || msg.type === 'SLAP') {
        const res = engine.handlePlayerAction(user.uid, msg);
        sendJson(ws, {
          type: 'ACTION_ACK',
          actionId: msg.actionId,
          seq: msg.seq,
          accepted: res.accepted,
          reason: res.reason,
        });
        return;
      }

      // ---- Host-Only Admin Commands ----
      if (msg.type.startsWith('ADMIN_')) {
        if (!user.isHost) {
          sendJson(ws, {
            type: 'ERROR',
            code: 'FORBIDDEN',
            message: 'Host privileges are required for this action.',
          });
          return;
        }
        if ('roomId' in msg && msg.roomId !== ROOM_ID) {
          sendJson(ws, { type: 'ERROR', code: 'INVALID_ROOM', message: 'Invalid room ID.' });
          return;
        }

        switch (msg.type) {
          case 'ADMIN_SET_TITLE':
            engine.setTitle(msg.title);
            break;
          case 'ADMIN_ADD_COUSIN':
            if (!engine.addCousin(msg.name)) {
              sendJson(ws, {
                type: 'ERROR',
                code: 'ADD_FAILED',
                message: 'Could not add cousin (room may be full or match active).',
              });
            }
            break;
          case 'ADMIN_BULK_ADD_COUSINS':
            engine.bulkAddCousins(Array.isArray(msg.names) ? msg.names : []);
            break;
          case 'ADMIN_EDIT_COUSIN':
            if (!engine.editCousin(msg.playerId, msg.name, msg.color)) {
              sendJson(ws, { type: 'ERROR', code: 'EDIT_FAILED', message: 'Could not edit cousin.' });
            }
            break;
          case 'ADMIN_REMOVE_COUSIN':
            if (!engine.removeCousin(msg.playerId)) {
              sendJson(ws, { type: 'ERROR', code: 'REMOVE_FAILED', message: 'Could not remove cousin.' });
            }
            break;
          case 'ADMIN_SYNC_ROSTER':
            engine.syncRosterFromFirestore(Array.isArray(msg.cousins) ? msg.cousins : []);
            break;
          case 'ADMIN_GENERATE_BALLOONS':
            if (!engine.generateBalloons()) {
              sendJson(ws, {
                type: 'ERROR',
                code: 'GENERATE_FAILED',
                message: 'Add at least 1 cousin before generating balloons.',
              });
            }
            break;
          case 'ADMIN_START_MATCH': {
            const started = engine.startMatch();
            if (!started.ok) {
              sendJson(ws, {
                type: 'ERROR',
                code: 'START_FAILED',
                message: started.reason ?? 'Could not start match.',
              });
            }
            break;
          }
          case 'ADMIN_PAUSE_MATCH':
            engine.pauseMatch();
            break;
          case 'ADMIN_RESUME_MATCH':
            engine.resumeMatch();
            break;
          case 'ADMIN_END_MATCH':
            engine.endMatch();
            break;
          case 'ADMIN_RESTART_MATCH': {
            const restarted = engine.restartMatch();
            if (!restarted.ok) {
              sendJson(ws, {
                type: 'ERROR',
                code: 'RESTART_FAILED',
                message: restarted.reason ?? 'Could not restart match.',
              });
            }
            break;
          }
          case 'ADMIN_RESET_SCORES':
            engine.resetScores(true);
            break;
        }
        broadcastSnapshot();
        return;
      }

      sendJson(ws, { type: 'ERROR', code: 'UNKNOWN_MESSAGE', message: 'Unsupported command.' });
    });

    ws.on('close', () => {
      if (session.authTimer) clearTimeout(session.authTimer);
      sessions.delete(session);
      if (session.user && uidToSession.get(session.user.uid) === session) {
        uidToSession.delete(session.user.uid);
        engine.unregisterConnection(session.user.uid);
        broadcastSnapshot();
      }
    });

    ws.on('error', () => {
      // Handled via close event
    });
  });

  // Authoritative 30 Hz physics & snapshot broadcast loop
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  if (options?.autoTick !== false) {
    tickTimer = setInterval(() => {
      engine.step(FIXED_DT_MS);
      broadcastSnapshot();
    }, FIXED_DT_MS);
  }

  // Heartbeat keepalive for Cloud Run WebSockets
  const heartbeatTimer = setInterval(() => {
    for (const session of sessions) {
      if (!session.isAlive) {
        session.ws.terminate();
        continue;
      }
      session.isAlive = false;
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const close = async (): Promise<void> => {
    if (tickTimer) clearInterval(tickTimer);
    clearInterval(heartbeatTimer);
    for (const session of sessions) {
      if (session.authTimer) clearTimeout(session.authTimer);
      try {
        session.ws.close(1001, 'Server shutting down');
      } catch {
        // ignore
      }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  return { engine, wss, broadcastSnapshot, close };
}
