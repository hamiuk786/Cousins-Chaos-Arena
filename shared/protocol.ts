export const ROOM_ID = 'wedding-main';
export const MAX_PARTICIPANTS = 50;
export const ARENA_WIDTH = 1200;
export const ARENA_HEIGHT = 800;
export const TICK_RATE = 30;
export const FIXED_DT_MS = 1000 / TICK_RATE;

export const ROUND_DURATION_MS = 90_000;
export const COUNTDOWN_DURATION_MS = 3_000;
export const RESPAWN_DELAY_MS = 3_000;
export const SPAWN_PROTECTION_MS = 2_000;
export const MAX_RESPAWNS_PER_ROUND = 1;

export const STARTING_HEALTH = 100;
export const POINTS_VALID_HIT = 5;
export const POINTS_POP = 20;
export const POINTS_LAST_SURVIVOR = 30;

export const SHIELD_DURATION_MS = 2_500;
export const SHIELD_COOLDOWN_MS = 7_000;
export const KICK_COOLDOWN_MS = 650;
export const THROW_COOLDOWN_MS = 850;
export const SLAP_COOLDOWN_MS = 550;

export const KICK_RANGE = 260;
export const SLAP_RANGE = 175;
export const PAIR_HIT_COOLDOWN_MS = 600;
export const MAX_BALLOON_SPEED = 24;

export type RoomStatus = 'WAITING' | 'READY' | 'COUNTDOWN' | 'PLAYING' | 'FINISHED';
export type BalloonStatus = 'alive' | 'respawning' | 'eliminated';
export type ActionType = 'KICK' | 'THROW' | 'SHIELD' | 'SLAP';

// 50 distinct, festive high-contrast balloon colors
export const COUSIN_COLORS: string[] = [
  '#D94848', '#2563EB', '#0F766E', '#D97706', '#7C3AED',
  '#DB2777', '#059669', '#EA580C', '#4F46E5', '#0284C7',
  '#B91C1C', '#15803D', '#9333EA', '#C2410C', '#0369A1',
  '#BE185D', '#047857', '#B45309', '#4338CA', '#0E7490',
  '#E11D48', '#16A34A', '#6D28D9', '#DC2626', '#1D4ED8',
  '#0D9488', '#CA8A04', '#A21CAF', '#EA580C', '#0284C7',
  '#9F1239', '#166534', '#5B21B6', '#9A3412', '#1E40AF',
  '#115E59', '#A16207', '#86198F', '#C2410C', '#075985',
  '#F43F5E', '#10B981', '#8B5CF6', '#F59E0B', '#3B82F6',
  '#14B8A6', '#EC4899', '#6366F1', '#EF4444', '#06B6D4',
];

export function getCousinColor(index: number): string {
  return COUSIN_COLORS[index % COUSIN_COLORS.length];
}

export function getReadableTextColor(hexColor: string): string {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.64 ? '#1C1917' : '#FFFFFF';
}

export interface CousinConfig {
  playerId: string;
  balloonId: string;
  name: string;
  color: string;
  ownerUid: string | null;
  ownerDisplayName: string | null;
}

export interface BalloonSnapshot {
  balloonId: string;
  playerId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  health: number;
  maxHealth: number;
  score: number;
  hits: number;
  pops: number;
  status: BalloonStatus;
  respawnsUsed: number;
  respawnRemainingMs: number;
  spawnProtected: boolean;
  spawnProtectedRemainingMs: number;
  shieldActive: boolean;
  shieldRemainingMs: number;
  shieldCooldownRemainingMs: number;
  ownerUid: string | null;
  connected: boolean;
  ready: boolean;
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  balloonId: string;
  name: string;
  color: string;
  score: number;
  pops: number;
  hits: number;
  status: BalloonStatus;
  lastSurvivorBonus: boolean;
}

export type GameEventType =
  | 'HIT'
  | 'POP'
  | 'RESPAWN'
  | 'SHIELD_ON'
  | 'SHIELD_BLOCK'
  | 'KICK'
  | 'THROW'
  | 'SLAP'
  | 'LAST_SURVIVOR';

export interface GameEvent {
  id: string;
  type: GameEventType;
  tick: number;
  timestamp: number;
  x: number;
  y: number;
  color?: string;
  attackerPlayerId?: string;
  attackerName?: string;
  victimPlayerId?: string;
  victimName?: string;
  damage?: number;
  points?: number;
  isEliminated?: boolean;
}

export interface ParticipantConnectionInfo {
  uid: string;
  displayName: string;
  isHost: boolean;
  claimedPlayerId: string | null;
  claimedName: string | null;
  connectedAt: number;
}

export interface RoomSnapshot {
  roomId: string;
  title: string;
  status: RoomStatus;
  isPaused: boolean;
  roundNumber: number;
  roundDurationMs: number;
  timeRemainingMs: number;
  countdownRemainingMs: number;
  serverTime: number;
  tick: number;
  arenaWidth: number;
  arenaHeight: number;
  maxParticipants: number;
  recoveredFromCheckpoint: boolean;
  lastCheckpointAt: number | null;
  balloons: BalloonSnapshot[];
  leaderboard: LeaderboardEntry[];
  events: GameEvent[];
  connectedCount: number;
  connections: ParticipantConnectionInfo[];
}

export interface MatchSummary {
  matchId: string;
  roomId: string;
  roundNumber: number;
  winnerName: string;
  winnerScore: number;
  participantCount: number;
  durationSeconds: number;
  leaderboard: LeaderboardEntry[];
  finishedAt: number;
}

export interface CheckpointData {
  version: number;
  roomId: string;
  title: string;
  status: RoomStatus;
  roundNumber: number;
  timeRemainingMs: number;
  savedAt: number;
  lastSurvivorAwarded: boolean;
  balloons: Array<{
    playerId: string;
    balloonId: string;
    name: string;
    color: string;
    ownerUid: string | null;
    ownerDisplayName: string | null;
    x: number;
    y: number;
    vx: number;
    vy: number;
    health: number;
    score: number;
    hits: number;
    pops: number;
    status: BalloonStatus;
    respawnsUsed: number;
    respawnRemainingMs: number;
    ready: boolean;
  }>;
}

// ---- Client -> Server WebSocket Messages ----
export interface ActionEnvelope {
  actionId: string;
  playerId: string;
  roomId: string;
  seq: number;
}

export type ClientMessage =
  | { type: 'AUTH'; idToken: string }
  | { type: 'JOIN_ROOM'; roomId: string; playerId?: string | null; asSpectator?: boolean }
  | { type: 'LEAVE_ROOM'; roomId: string }
  | { type: 'PLAYER_READY'; roomId: string; playerId: string; ready: boolean; actionId: string; seq: number }
  | ({ type: 'KICK'; dx: number; dy: number; power?: number; targetBalloonId?: string | null } & ActionEnvelope)
  | ({ type: 'THROW'; dx: number; dy: number; power: number } & ActionEnvelope)
  | ({ type: 'SHIELD' } & ActionEnvelope)
  | ({ type: 'SLAP'; dx?: number; dy?: number } & ActionEnvelope)
  | { type: 'HEARTBEAT_PING'; clientTime: number }
  // Host-only Admin Controls
  | { type: 'ADMIN_SET_TITLE'; roomId: string; title: string }
  | { type: 'ADMIN_ADD_COUSIN'; roomId: string; name: string }
  | { type: 'ADMIN_BULK_ADD_COUSINS'; roomId: string; names: string[] }
  | { type: 'ADMIN_EDIT_COUSIN'; roomId: string; playerId: string; name: string; color?: string }
  | { type: 'ADMIN_REMOVE_COUSIN'; roomId: string; playerId: string }
  | { type: 'ADMIN_SYNC_ROSTER'; roomId: string; cousins: Array<{ playerId: string; name: string; color: string; ownerUid?: string | null }> }
  | { type: 'ADMIN_GENERATE_BALLOONS'; roomId: string }
  | { type: 'ADMIN_START_MATCH'; roomId: string }
  | { type: 'ADMIN_PAUSE_MATCH'; roomId: string }
  | { type: 'ADMIN_RESUME_MATCH'; roomId: string }
  | { type: 'ADMIN_END_MATCH'; roomId: string }
  | { type: 'ADMIN_RESTART_MATCH'; roomId: string }
  | { type: 'ADMIN_RESET_SCORES'; roomId: string };

// ---- Server -> Client WebSocket Messages ----
export type ServerMessage =
  | {
      type: 'AUTH_OK';
      uid: string;
      displayName: string;
      isHost: boolean;
      claimedPlayerId: string | null;
    }
  | { type: 'AUTH_ERROR'; message: string }
  | { type: 'ACTION_ACK'; actionId: string; seq: number; accepted: boolean; reason?: string }
  | { type: 'SNAPSHOT'; snapshot: RoomSnapshot }
  | { type: 'MATCH_FINISHED'; summary: MatchSummary }
  | { type: 'CHECKPOINT_SAVED'; checkpoint: { checkpointId: string; roundNumber: number; status: RoomStatus; timeRemainingMs: number; balloonsCount: number; savedAt: number } }
  | { type: 'HEARTBEAT_PONG'; clientTime: number; serverTime: number }
  | { type: 'ERROR'; code: string; message: string };
