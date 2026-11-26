import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  CheckCircle2,
  Hand,
  LogOut,
  MoveUpRight,
  Shield,
  SlidersHorizontal,
  Trophy,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import {
  GameEvent,
  MatchSummary,
  MAX_RESPAWNS_PER_ROUND,
  RoomSnapshot,
} from '../shared/protocol';
import {
  auth,
  deleteCousinFromFirestore,
  ensureRoomInFirestore,
  loadCousinsFromFirestore,
  loadMatchHistoryFromFirestore,
  saveCheckpointMetaToFirestore,
  saveCousinToFirestore,
  saveMatchResultToFirestore,
  signInWithGoogle,
  signOutUser,
  StoredMatchRecord,
} from './lib/firebase';
import { ArenaGameClient, AuthSessionInfo, ConnectionState } from './lib/gameClient';
import { soundEngine } from './lib/sound';
import { ArenaCanvas } from './components/ArenaCanvas';
import { HostPanel } from './components/HostPanel';
import { LeaderboardModal } from './components/LeaderboardModal';

function formatTimer(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export default function App() {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [session, setSession] = useState<AuthSessionInfo | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);

  const [activeTool, setActiveTool] = useState<'THROW' | 'KICK'>('THROW');
  const [muted, setMuted] = useState(false);
  const [showHostPanel, setShowHostPanel] = useState(true);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [matchHistory, setMatchHistory] = useState<StoredMatchRecord[]>([]);

  const eventsQueueRef = useRef<GameEvent[]>([]);
  const lastCountdownSecRef = useRef<number | null>(null);
  const hostHydratedRef = useRef(false);
  const lastSyncedBalloonsRef = useRef<string>('');
  const firebaseUserRef = useRef<User | null>(null);
  firebaseUserRef.current = firebaseUser;

  const showToast = useCallback((msg: string) => {
    setNotice(msg);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  // WebSocket authoritative game client singleton
  const gameClient = useMemo(
    () =>
      new ArenaGameClient({
        onConnectionChange: (state, rtt) => {
          setConnState(state);
          setRttMs(rtt);
        },
        onAuthChange: (authSess, err) => {
          setSession(authSess);
          if (err) setNotice(err);
        },
        onSnapshot: (snap) => {
          setSnapshot(snap);
        },
        onEvents: (events) => {
          eventsQueueRef.current.push(...events);
          for (const ev of events) {
            if (ev.type === 'POP') soundEngine.playPop();
            else if (ev.type === 'HIT') soundEngine.playHit();
            else if (ev.type === 'RESPAWN') soundEngine.playRespawn();
            else if (ev.type === 'SHIELD_ON') soundEngine.playShieldOn();
            else if (ev.type === 'SHIELD_BLOCK') soundEngine.playShieldBlock();
            else if (ev.type === 'SLAP') soundEngine.playSlap();
            else if (ev.type === 'KICK') soundEngine.playKick();
            else if (ev.type === 'THROW') soundEngine.playThrow();
            else if (ev.type === 'LAST_SURVIVOR') soundEngine.playVictory();
          }
        },
        onMatchFinished: (summary: MatchSummary) => {
          soundEngine.playVictory();
          setShowLeaderboard(true);
          const u = firebaseUserRef.current;
          if (u && sessionRef.current?.isHost) {
            void saveMatchResultToFirestore(u.uid, summary)
              .then(() => loadMatchHistoryFromFirestore())
              .then((hist) => setMatchHistory(hist))
              .catch((err) => console.error('Failed saving match result:', err));
          } else if (u) {
            setTimeout(() => {
              void loadMatchHistoryFromFirestore()
                .then((hist) => setMatchHistory(hist))
                .catch(() => {});
            }, 1200);
          }
        },
        onCheckpointSaved: (checkpoint) => {
          const u = firebaseUserRef.current;
          if (u && sessionRef.current?.isHost) {
            void saveCheckpointMetaToFirestore(u.uid, checkpoint).catch(() => {});
          }
        },
        onError: (msg) => {
          setNotice(msg);
        },
      }),
    [],
  );

  const sessionRef = useRef<AuthSessionInfo | null>(null);
  sessionRef.current = session;

  // Countdown tick sound sync
  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.status === 'COUNTDOWN' && !snapshot.isPaused) {
      const sec = Math.max(1, Math.ceil(snapshot.countdownRemainingMs / 1000));
      if (lastCountdownSecRef.current !== sec) {
        lastCountdownSecRef.current = sec;
        soundEngine.playCountdownTick(false);
      }
    } else if (snapshot.status === 'PLAYING' && lastCountdownSecRef.current !== null) {
      lastCountdownSecRef.current = null;
      soundEngine.playCountdownTick(true);
    }
  }, [snapshot]);

  // Firebase Auth listener -> connect/disconnect WebSocket automatically
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setAuthReady(true);
      if (user) {
        gameClient.connect(async () => {
          const current = auth.currentUser;
          if (!current) return null;
          return current.getIdToken();
        });
        void loadMatchHistoryFromFirestore()
          .then((hist) => setMatchHistory(hist))
          .catch(() => {});
      } else {
        hostHydratedRef.current = false;
        gameClient.disconnect();
        setSession(null);
        setSnapshot(null);
      }
    });
    return () => {
      unsub();
      gameClient.disconnect();
    };
  }, [gameClient]);

  // Host Firestore hydration & roster persistence
  useEffect(() => {
    if (!firebaseUser || !session?.isHost || !snapshot) return;

    if (!hostHydratedRef.current) {
      hostHydratedRef.current = true;
      void (async () => {
        try {
          await ensureRoomInFirestore(
            firebaseUser.uid,
            snapshot.title,
            snapshot.status,
            snapshot.roundNumber,
          );
          if (snapshot.balloons.length === 0) {
            const savedCousins = await loadCousinsFromFirestore();
            if (savedCousins.length > 0) {
              gameClient.adminSyncRoster(
                savedCousins.map((c) => ({
                  playerId: c.cousinId,
                  name: c.name,
                  color: c.color,
                  ownerUid: c.claimedByUid || null,
                })),
              );
            }
          }
        } catch (err) {
          console.error('Host Firestore initialization error:', err);
        }
      })();
      return;
    }

    // Persist roster changes when cousins are added/edited/claimed (outside 30Hz physics)
    const rosterKey = JSON.stringify(
      snapshot.balloons.map((b) => [b.playerId, b.name, b.color, b.ownerUid]),
    );
    if (rosterKey !== lastSyncedBalloonsRef.current && snapshot.status !== 'PLAYING') {
      lastSyncedBalloonsRef.current = rosterKey;
      void ensureRoomInFirestore(
        firebaseUser.uid,
        snapshot.title,
        snapshot.status,
        snapshot.roundNumber,
      ).catch(() => {});
      for (const b of snapshot.balloons) {
        void saveCousinToFirestore({
          playerId: b.playerId,
          name: b.name,
          color: b.color,
          ownerUid: b.ownerUid,
        }).catch(() => {});
      }
    }
  }, [firebaseUser, session?.isHost, snapshot, gameClient]);

  const myPlayerId = session?.claimedPlayerId ?? null;
  const myBalloon = snapshot?.balloons.find((b) => b.playerId === myPlayerId) ?? null;

  // Keyboard shortcuts for desktop players
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        !myPlayerId ||
        snapshot?.status !== 'PLAYING' ||
        snapshot.isPaused
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        gameClient.sendSlap(myPlayerId);
      } else if (e.key.toLowerCase() === 's') {
        gameClient.sendShield(myPlayerId);
      } else if (e.key.toLowerCase() === 'k') {
        setActiveTool('KICK');
      } else if (e.key.toLowerCase() === 't') {
        setActiveTool('THROW');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [gameClient, myPlayerId, snapshot?.status, snapshot?.isPaused]);

  const handleSignIn = async () => {
    setSignInBusy(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Google Sign-In failed.');
    } finally {
      setSignInBusy(false);
    }
  };

  const handleSignOut = async () => {
    gameClient.disconnect();
    await signOutUser();
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    soundEngine.setMuted(next);
  };

  const handleRemoveCousin = (playerId: string) => {
    gameClient.adminRemoveCousin(playerId);
    if (session?.isHost) {
      void deleteCousinFromFirestore(playerId).catch(() => {});
    }
  };

  const handleKick = useCallback(
    (dx: number, dy: number, power: number, targetBalloonId?: string | null) => {
      if (!myPlayerId) return;
      gameClient.sendKick(myPlayerId, dx, dy, power, targetBalloonId);
    },
    [gameClient, myPlayerId],
  );

  const handleThrow = useCallback(
    (dx: number, dy: number, power: number) => {
      if (!myPlayerId) return;
      gameClient.sendThrow(myPlayerId, dx, dy, power);
    },
    [gameClient, myPlayerId],
  );

  const aliveCount = snapshot?.balloons.filter((b) => b.status === 'alive').length ?? 0;
  const totalCount = snapshot?.balloons.length ?? 0;
  const isPlaying = snapshot?.status === 'PLAYING' && !snapshot.isPaused;
  const statusLabel = snapshot
    ? snapshot.isPaused
      ? 'Paused'
      : snapshot.status === 'WAITING'
        ? 'Lobby'
        : snapshot.status === 'READY'
          ? 'Ready'
          : snapshot.status === 'COUNTDOWN'
            ? 'Countdown'
            : snapshot.status === 'PLAYING'
              ? 'Live Match'
              : 'Finished'
    : 'Connecting';

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF8F4] text-[#1C1917]">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-[#E5E1D8]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-8">
          {/* Zone 1: Single text element wordmark */}
          <span className="font-display text-lg font-bold tracking-tight text-[#1C1917] whitespace-nowrap shrink-0">
            Cousins Chaos Arena
          </span>

          {/* Zone 2: Clean single-line navigation links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-[#57534E]">
            <button
              type="button"
              onClick={() => {
                setShowRules(false);
                setShowLeaderboard(false);
              }}
              className="hover:text-[#1C1917] transition-colors whitespace-nowrap shrink-0"
            >
              Arena
            </button>
            <button
              type="button"
              onClick={() => setShowLeaderboard(true)}
              disabled={!firebaseUser}
              className="hover:text-[#1C1917] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
            >
              Leaderboard
            </button>
            <button
              type="button"
              onClick={() => setShowRules((v) => !v)}
              className="hover:text-[#1C1917] transition-colors whitespace-nowrap shrink-0"
            >
              Rules
            </button>
            {session?.isHost && (
              <button
                type="button"
                onClick={() => setShowHostPanel((v) => !v)}
                className="text-[#0F5132] hover:text-[#0B3D25] transition-colors whitespace-nowrap shrink-0"
              >
                {showHostPanel ? 'Hide Host Panel' : 'Host Panel'}
              </button>
            )}
          </nav>

          {/* Zone 3: Single primary action */}
          <div className="flex items-center gap-2 shrink-0">
            {firebaseUser ? (
              <>
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted ? 'Unmute audio' : 'Mute audio'}
                  className="p-2 text-[#57534E] hover:text-[#1C1917] rounded-lg hover:bg-[#F5F2EB] transition-colors"
                >
                  {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                </button>
                {session?.isHost && (
                  <button
                    type="button"
                    onClick={() => setShowHostPanel((v) => !v)}
                    aria-label="Toggle Host Controls"
                    className="md:hidden p-2 text-[#0F5132] hover:bg-[#F0FDF4] rounded-lg transition-colors"
                  >
                    <SlidersHorizontal className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#57534E] hover:text-[#1C1917] border border-[#E5E1D8] rounded-lg hover:bg-[#F5F2EB] transition-colors whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign Out
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleSignIn}
                disabled={signInBusy || !authReady}
                className="px-4 py-2 text-xs font-semibold bg-[#0F5132] text-white rounded-lg hover:bg-[#0B3D25] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {signInBusy ? 'Signing in...' : 'Sign In'}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Non-blocking feedback toast */}
      {notice && (
        <div className="max-w-[1440px] w-full mx-auto px-4 sm:px-6 pt-3">
          <div className="bg-[#1C1917] text-white text-xs font-medium px-4 py-2.5 rounded-lg flex items-center justify-between gap-4">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-[#D6D3D1] hover:text-white whitespace-nowrap"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Rules Drawer / Collapsible Bar */}
      {showRules && (
        <section className="max-w-[1440px] w-full mx-auto px-4 sm:px-6 pt-4">
          <div className="bg-white border border-[#E5E1D8] rounded-xl p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 text-sm">
            <div>
              <h3 className="font-semibold text-[#1C1917]">01. Shared Arena</h3>
              <p className="text-xs text-[#57534E] mt-1 leading-relaxed">
                Every phone connects to one live server-authoritative arena running 90-second rounds for up to 50 cousins.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-[#1C1917]">02. Controls</h3>
              <p className="text-xs text-[#57534E] mt-1 leading-relaxed">
                Swipe & release to <strong>Throw</strong>, tap a nearby opponent or direction to <strong>Kick</strong>, tap <strong>Shield</strong> to deflect damage, or <strong>Slap</strong> to push nearby rivals.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-[#1C1917]">03. Health & Respawn</h3>
              <p className="text-xs text-[#57534E] mt-1 leading-relaxed">
                Start at 100 HP. First pop triggers a 3-second respawn at 100 HP with 2 seconds of spawn protection. Second pop eliminates you until next round.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-[#1C1917]">04. Scoring</h3>
              <p className="text-xs text-[#57534E] mt-1 leading-relaxed">
                Valid opponent hit: <strong>+5</strong> · Successful pop: <strong>+20</strong> · Last surviving balloon: <strong>+30 bonus</strong>. Self-hits award 0 points.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Main Workspace */}
      {!authReady ? (
        <main className="flex-1 flex items-center justify-center p-6">
          <p className="text-sm text-[#6B655E]">Loading arena...</p>
        </main>
      ) : !firebaseUser ? (
        /* Unauthenticated Welcome & Join Screen */
        <main className="flex-1 flex items-center justify-center px-6 py-12">
          <div className="max-w-5xl w-full grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
            <div className="lg:col-span-7 space-y-6">
              <p className="text-xs font-medium text-[#6B655E]">
                Live Wedding Multiplayer · 90-Second Rounds · Up to 50 Cousins
              </p>
              <h1 className="font-display text-4xl sm:text-5xl font-bold text-[#1C1917] leading-[1.1] tracking-tight">
                One shared balloon arena for every cousin in the room.
              </h1>
              <p className="text-base text-[#57534E] leading-relaxed max-w-xl">
                Claim your named balloon, swipe to throw, tap to kick rivals across the marquee, pop shields at the perfect moment, and fight to be the last balloon floating.
              </p>

              <div className="flex flex-wrap items-center gap-4 pt-2">
                <button
                  type="button"
                  onClick={handleSignIn}
                  disabled={signInBusy}
                  className="px-6 py-3.5 text-sm font-semibold bg-[#0F5132] text-white rounded-lg hover:bg-[#0B3D25] disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  {signInBusy ? 'Signing in...' : 'Sign in with Google to Join'}
                </button>
                <span className="text-xs text-[#78716C]">
                  Verified sign-in prevents impersonation & keeps scores fair
                </span>
              </div>
            </div>

            <div className="lg:col-span-5 bg-white border border-[#E5E1D8] rounded-xl p-6 space-y-5">
              <h2 className="font-display text-xl font-semibold text-[#1C1917]">
                Match Rules at a Glance
              </h2>
              <dl className="divide-y divide-[#F0EDE6] text-sm">
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-[#57534E]">Round duration</dt>
                  <dd className="font-mono font-semibold tabular-nums text-[#1C1917]">90 seconds</dd>
                </div>
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-[#57534E]">Starting health</dt>
                  <dd className="font-mono font-semibold tabular-nums text-[#1C1917]">100 HP</dd>
                </div>
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-[#57534E]">Respawn rule</dt>
                  <dd className="font-medium text-[#1C1917] text-right">1x after 3s · 2s shield</dd>
                </div>
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-[#57534E]">Hit / Pop / Survivor</dt>
                  <dd className="font-mono font-semibold tabular-nums text-[#0F5132]">+5 / +20 / +30</dd>
                </div>
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-[#57534E]">Physics authority</dt>
                  <dd className="font-medium text-[#1C1917] text-right">Shared 30 Hz server</dd>
                </div>
              </dl>
            </div>
          </div>
        </main>
      ) : (
        /* Authenticated Live Arena Workspace */
        <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-4 flex flex-col gap-4">
          {/* Compact Top Match HUD Strip (unboxed metadata with separators) */}
          <div className="bg-white border border-[#E5E1D8] rounded-xl px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm">
              <span className="font-semibold text-[#1C1917]">{statusLabel}</span>
              <span className="text-[#D6D3D1]" aria-hidden="true">·</span>
              <span className="text-[#57534E] tabular-nums">
                Round {snapshot?.roundNumber ?? 1}
              </span>
              <span className="text-[#D6D3D1]" aria-hidden="true">·</span>
              <span className="text-[#57534E] tabular-nums">
                {aliveCount}/{totalCount} alive
              </span>
              <span className="text-[#D6D3D1] hidden sm:inline" aria-hidden="true">·</span>
              <span className="text-xs text-[#78716C] hidden sm:inline tabular-nums">
                {connState === 'connected'
                  ? `Live${rttMs ? ` · ${rttMs}ms` : ''}`
                  : connState === 'connecting' || connState === 'authenticating'
                    ? 'Connecting...'
                    : 'Reconnecting...'}
              </span>
            </div>

            {/* Authoritative Server Timer */}
            <div className="flex items-center gap-4">
              <div className="text-right">
                <span className="font-mono text-2xl sm:text-3xl font-bold tracking-tight tabular-nums text-[#1C1917]">
                  {formatTimer(snapshot?.timeRemainingMs ?? 90_000)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowLeaderboard(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-[#E5E1D8] rounded-lg text-[#1C1917] hover:bg-[#F5F2EB] transition-colors whitespace-nowrap"
              >
                <Trophy className="w-3.5 h-3.5 text-[#C59B27]" />
                Standings
              </button>
            </div>
          </div>

          {/* Cousin Claim & Ready Strip (visible before/between matches or if unclaimed) */}
          {snapshot && snapshot.balloons.length > 0 && (!myBalloon || snapshot.status === 'WAITING' || snapshot.status === 'READY') && (
            <section className="bg-white border border-[#E5E1D8] rounded-xl px-4 sm:px-5 py-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-[#1C1917]">
                    {myBalloon ? `Playing as ${myBalloon.name}` : 'Pick your cousin balloon to join'}
                  </h2>
                  <p className="text-xs text-[#6B655E]">
                    {myBalloon
                      ? 'Mark yourself ready before the Host starts the countdown.'
                      : 'Tap your name below to claim your balloon on this device.'}
                  </p>
                </div>

                {myBalloon && (snapshot.status === 'WAITING' || snapshot.status === 'READY') && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => gameClient.setReady(myBalloon.playerId, !myBalloon.ready)}
                      className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                        myBalloon.ready
                          ? 'bg-[#0F5132] text-white hover:bg-[#0B3D25]'
                          : 'border border-[#0F5132] text-[#0F5132] hover:bg-[#F0FDF4]'
                      }`}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {myBalloon.ready ? 'Ready' : 'Mark Ready'}
                    </button>
                    <button
                      type="button"
                      onClick={() => gameClient.claimCousin(null, true)}
                      className="px-3 py-2 text-xs font-medium text-[#57534E] hover:text-[#1C1917] whitespace-nowrap"
                    >
                      Switch / Spectate
                    </button>
                  </div>
                )}
              </div>

              {!myBalloon && (
                <div className="flex flex-wrap gap-2 max-h-36 overflow-y-auto pt-1">
                  {snapshot.balloons.map((b) => {
                    const takenByOther = Boolean(b.ownerUid && b.ownerUid !== session?.uid);
                    return (
                      <button
                        key={b.playerId}
                        type="button"
                        disabled={takenByOther}
                        onClick={() => gameClient.claimCousin(b.playerId)}
                        className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap ${
                          takenByOther
                            ? 'bg-[#F5F2EB] border-[#E5E1D8] text-[#A8A29E] cursor-not-allowed'
                            : 'bg-white border-[#D6D1C7] text-[#1C1917] hover:border-[#0F5132] hover:bg-[#FAF8F4]'
                        }`}
                      >
                        <span
                          className="w-3 h-3 rounded-full shrink-0"
                          style={{ backgroundColor: b.color }}
                        />
                        <span>{b.name}</span>
                        {takenByOther && <span className="text-[10px] font-normal">(Taken)</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* Main Grid: Shared Arena Canvas + Optional Host Panel */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start flex-1">
            <div className={session?.isHost && showHostPanel ? 'lg:col-span-8 xl:col-span-9 flex flex-col gap-3' : 'lg:col-span-12 flex flex-col gap-3'}>
              {/* Shared Authoritative HTML5 Canvas */}
              <ArenaCanvas
                client={gameClient}
                snapshot={snapshot}
                myPlayerId={myPlayerId}
                activeTool={activeTool}
                eventsQueueRef={eventsQueueRef}
                onKick={handleKick}
                onThrow={handleThrow}
              />

              {/* Player Action Controls Bar (Touch-Friendly >= 44px) */}
              <div className="bg-white border border-[#E5E1D8] rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
                {/* Left: Active Drag/Tap Control Mode + Action Buttons */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 p-1 bg-[#F5F2EB] rounded-lg">
                    <button
                      type="button"
                      onClick={() => setActiveTool('THROW')}
                      className={`flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                        activeTool === 'THROW'
                          ? 'bg-white text-[#1C1917] shadow-xs'
                          : 'text-[#6B655E] hover:text-[#1C1917]'
                      }`}
                    >
                      <MoveUpRight className="w-3.5 h-3.5" />
                      Throw (Swipe)
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTool('KICK')}
                      className={`flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                        activeTool === 'KICK'
                          ? 'bg-white text-[#1C1917] shadow-xs'
                          : 'text-[#6B655E] hover:text-[#1C1917]'
                      }`}
                    >
                      <Zap className="w-3.5 h-3.5" />
                      Kick (Tap)
                    </button>
                  </div>

                  <button
                    type="button"
                    disabled={
                      !isPlaying ||
                      !myBalloon ||
                      myBalloon.status !== 'alive' ||
                      myBalloon.shieldCooldownRemainingMs > 0
                    }
                    onClick={() => myPlayerId && gameClient.sendShield(myPlayerId)}
                    className={`flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap ${
                      myBalloon?.shieldActive
                        ? 'bg-[#C59B27] border-[#C59B27] text-white'
                        : 'bg-white border-[#D6D1C7] text-[#1C1917] hover:border-[#C59B27] disabled:opacity-45'
                    }`}
                  >
                    <Shield className="w-4 h-4" />
                    <span className="tabular-nums">
                      {myBalloon?.shieldActive
                        ? `Shield ${(myBalloon.shieldRemainingMs / 1000).toFixed(1)}s`
                        : myBalloon && myBalloon.shieldCooldownRemainingMs > 0
                          ? `Shield ${(myBalloon.shieldCooldownRemainingMs / 1000).toFixed(1)}s`
                          : 'Shield'}
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={!isPlaying || !myBalloon || myBalloon.status !== 'alive'}
                    onClick={() => myPlayerId && gameClient.sendSlap(myPlayerId)}
                    className="flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] text-xs font-semibold rounded-lg bg-[#0F5132] text-white hover:bg-[#0B3D25] disabled:opacity-45 transition-colors whitespace-nowrap"
                  >
                    <Hand className="w-4 h-4" />
                    Slap Push
                  </button>
                </div>

                {/* Right: Personal Status & Live Top 3 */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#57534E] tabular-nums">
                  {myBalloon ? (
                    <>
                      <span className="flex items-center gap-1.5 font-semibold text-[#1C1917]">
                        <span
                          className="w-2.5 h-2.5 rounded-full"
                          style={{ backgroundColor: myBalloon.color }}
                        />
                        {myBalloon.name}
                      </span>
                      <span>
                        HP <strong className="font-mono text-[#1C1917]">{myBalloon.health}/100</strong>
                      </span>
                      <span>
                        Score <strong className="font-mono text-[#0F5132]">{myBalloon.score}</strong>
                      </span>
                      <span>
                        {Math.max(0, MAX_RESPAWNS_PER_ROUND - myBalloon.respawnsUsed)} respawn left
                      </span>
                    </>
                  ) : (
                    <span>Spectating live arena · Claim a cousin above to play</span>
                  )}
                </div>
              </div>

              {/* Compact Live Leaderboard Ticker Strip */}
              {snapshot && snapshot.leaderboard.length > 0 && (
                <div className="bg-white border border-[#E5E1D8] rounded-xl px-4 py-2.5 flex items-center gap-4 overflow-x-auto text-xs">
                  <span className="font-semibold text-[#57534E] whitespace-nowrap shrink-0">
                    Top Standings
                  </span>
                  <div className="flex items-center gap-4">
                    {snapshot.leaderboard.slice(0, 6).map((entry) => (
                      <div key={entry.playerId} className="flex items-center gap-1.5 whitespace-nowrap shrink-0">
                        <span className="font-mono text-[#78716C] tabular-nums">#{entry.rank}</span>
                        <span
                          className="w-2.5 h-2.5 rounded-full"
                          style={{ backgroundColor: entry.color }}
                        />
                        <span className="font-medium text-[#1C1917]">{entry.name}</span>
                        <span className="font-mono font-semibold text-[#0F5132] tabular-nums">
                          {entry.score}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Host Admin Sidebar */}
            {session?.isHost && showHostPanel && (
              <div className="lg:col-span-4 xl:col-span-3">
                <HostPanel
                  snapshot={snapshot}
                  onAddCousin={(name) => gameClient.adminAddCousin(name)}
                  onBulkAddCousins={(names) => gameClient.adminBulkAddCousins(names)}
                  onEditCousin={(id, name) => gameClient.adminEditCousin(id, name)}
                  onRemoveCousin={handleRemoveCousin}
                  onGenerateBalloons={() => gameClient.adminGenerateBalloons()}
                  onStartMatch={() => gameClient.adminStartMatch()}
                  onPauseMatch={() => gameClient.adminPauseMatch()}
                  onResumeMatch={() => gameClient.adminResumeMatch()}
                  onEndMatch={() => gameClient.adminEndMatch()}
                  onRestartMatch={() => gameClient.adminRestartMatch()}
                  onResetScores={() => gameClient.adminResetScores()}
                  onClose={() => setShowHostPanel(false)}
                />
              </div>
            )}
          </div>
        </main>
      )}

      {/* Final Leaderboard & Saved Match History Modal */}
      {showLeaderboard && snapshot && (
        <LeaderboardModal
          roundNumber={snapshot.roundNumber}
          leaderboard={snapshot.leaderboard}
          history={matchHistory}
          isHost={Boolean(session?.isHost)}
          onRestartMatch={() => gameClient.adminRestartMatch()}
          onClose={() => setShowLeaderboard(false)}
        />
      )}
    </div>
  );
}
