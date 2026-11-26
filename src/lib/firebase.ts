import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  limit,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  MAX_PARTICIPANTS,
  MatchSummary,
  ROOM_ID,
  RoomStatus,
  ROUND_DURATION_MS,
} from '../../shared/protocol';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutUser(): Promise<void> {
  await firebaseSignOut(auth);
}

export interface StoredCousin {
  cousinId: string;
  roomId: string;
  name: string;
  color: string;
  claimedByUid: string;
}

export interface StoredMatchRecord {
  matchId: string;
  roomId: string;
  roundNumber: number;
  winnerName: string;
  winnerScore: number;
  participantCount: number;
  durationSeconds: number;
  leaderboard: MatchSummary['leaderboard'];
  finishedAtMs: number;
}

const VALID_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function ensureRoomInFirestore(
  hostUid: string,
  title: string,
  status: RoomStatus,
  roundNumber: number,
): Promise<void> {
  const roomPath = `rooms/${ROOM_ID}`;
  const roomRef = doc(db, 'rooms', ROOM_ID);
  const safeTitle = title.trim().slice(0, 80) || 'The Wedding Cousins Chaos Arena';
  const safeRound = Math.max(1, Math.min(1000, Math.round(roundNumber)));
  try {
    const existing = await getDoc(roomRef);
    if (!existing.exists()) {
      await setDoc(roomRef, {
        roomId: ROOM_ID,
        title: safeTitle,
        hostUid,
        status,
        roundDurationSeconds: Math.round(ROUND_DURATION_MS / 1000),
        maxParticipants: MAX_PARTICIPANTS,
        roundNumber: safeRound,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(roomRef, {
        title: safeTitle,
        status,
        roundNumber: safeRound,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, roomPath);
  }
}

export async function saveCousinToFirestore(cousin: {
  playerId: string;
  name: string;
  color: string;
  ownerUid: string | null;
}): Promise<void> {
  if (!VALID_ID_RE.test(cousin.playerId)) return;
  const safeName = cousin.name.trim().slice(0, 32) || 'Cousin';
  const safeColor = VALID_COLOR_RE.test(cousin.color) ? cousin.color : '#2563EB';
  const docPath = `rooms/${ROOM_ID}/cousins/${cousin.playerId}`;
  const ref = doc(db, 'rooms', ROOM_ID, 'cousins', cousin.playerId);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        cousinId: cousin.playerId,
        roomId: ROOM_ID,
        name: safeName,
        color: safeColor,
        claimedByUid: cousin.ownerUid ?? '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        name: safeName,
        color: safeColor,
        claimedByUid: cousin.ownerUid ?? '',
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}

export async function deleteCousinFromFirestore(playerId: string): Promise<void> {
  if (!VALID_ID_RE.test(playerId)) return;
  const docPath = `rooms/${ROOM_ID}/cousins/${playerId}`;
  try {
    await deleteDoc(doc(db, 'rooms', ROOM_ID, 'cousins', playerId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, docPath);
  }
}

export async function loadCousinsFromFirestore(): Promise<StoredCousin[]> {
  const colPath = `rooms/${ROOM_ID}/cousins`;
  try {
    const q = query(
      collection(db, 'rooms', ROOM_ID, 'cousins'),
      where('roomId', '==', ROOM_ID),
      limit(MAX_PARTICIPANTS),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        cousinId: String(data.cousinId || d.id),
        roomId: ROOM_ID,
        name: String(data.name || ''),
        color: String(data.color || '#2563EB'),
        claimedByUid: String(data.claimedByUid || ''),
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, colPath);
  }
}

export async function saveMatchResultToFirestore(
  hostUid: string,
  summary: MatchSummary,
): Promise<void> {
  if (!VALID_ID_RE.test(summary.matchId)) return;
  const docPath = `rooms/${ROOM_ID}/matches/${summary.matchId}`;
  try {
    await setDoc(doc(db, 'rooms', ROOM_ID, 'matches', summary.matchId), {
      matchId: summary.matchId,
      roomId: ROOM_ID,
      hostUid,
      roundNumber: Math.max(1, Math.min(1000, Math.round(summary.roundNumber))),
      winnerName: (summary.winnerName || 'Winner').slice(0, 64),
      winnerScore: Math.max(0, Math.min(100000, Math.round(summary.winnerScore))),
      participantCount: Math.max(0, Math.min(50, Math.round(summary.participantCount))),
      durationSeconds: Math.max(0, Math.min(600, Math.round(summary.durationSeconds))),
      leaderboard: summary.leaderboard.slice(0, 50).map((entry) => ({
        rank: Math.round(entry.rank),
        playerId: entry.playerId,
        name: entry.name.slice(0, 32),
        color: entry.color,
        score: Math.round(entry.score),
        pops: Math.round(entry.pops),
        hits: Math.round(entry.hits),
        status: entry.status,
      })),
      finishedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, docPath);
  }
}

export async function loadMatchHistoryFromFirestore(): Promise<StoredMatchRecord[]> {
  const colPath = `rooms/${ROOM_ID}/matches`;
  try {
    const q = query(
      collection(db, 'rooms', ROOM_ID, 'matches'),
      where('roomId', '==', ROOM_ID),
      orderBy('finishedAt', 'desc'),
      limit(15),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      const finishedTs = data.finishedAt?.toMillis ? data.finishedAt.toMillis() : Date.now();
      return {
        matchId: String(data.matchId || d.id),
        roomId: ROOM_ID,
        roundNumber: Number(data.roundNumber || 1),
        winnerName: String(data.winnerName || 'Winner'),
        winnerScore: Number(data.winnerScore || 0),
        participantCount: Number(data.participantCount || 0),
        durationSeconds: Number(data.durationSeconds || 0),
        leaderboard: Array.isArray(data.leaderboard) ? data.leaderboard : [],
        finishedAtMs: finishedTs,
      };
    });
  } catch (error) {
    // Handle missing composite index gracefully by falling back to unordered query
    if (error instanceof Error && error.message.includes('index')) {
      const fallbackQ = query(
        collection(db, 'rooms', ROOM_ID, 'matches'),
        where('roomId', '==', ROOM_ID),
        limit(15),
      );
      const snap = await getDocs(fallbackQ);
      return snap.docs
        .map((d) => {
          const data = d.data();
          const finishedTs = data.finishedAt?.toMillis ? data.finishedAt.toMillis() : Date.now();
          return {
            matchId: String(data.matchId || d.id),
            roomId: ROOM_ID,
            roundNumber: Number(data.roundNumber || 1),
            winnerName: String(data.winnerName || 'Winner'),
            winnerScore: Number(data.winnerScore || 0),
            participantCount: Number(data.participantCount || 0),
            durationSeconds: Number(data.durationSeconds || 0),
            leaderboard: Array.isArray(data.leaderboard) ? data.leaderboard : [],
            finishedAtMs: finishedTs,
          };
        })
        .sort((a, b) => b.finishedAtMs - a.finishedAtMs);
    }
    handleFirestoreError(error, OperationType.LIST, colPath);
  }
}

export async function saveCheckpointMetaToFirestore(
  hostUid: string,
  meta: {
    checkpointId: string;
    roundNumber: number;
    status: RoomStatus;
    timeRemainingMs: number;
    balloonsCount: number;
  },
): Promise<void> {
  const safeId = VALID_ID_RE.test(meta.checkpointId) ? meta.checkpointId : 'latest';
  const docPath = `rooms/${ROOM_ID}/checkpoints/${safeId}`;
  const ref = doc(db, 'rooms', ROOM_ID, 'checkpoints', safeId);
  try {
    const existing = await getDoc(ref);
    const payload = {
      roundNumber: Math.max(1, Math.min(1000, Math.round(meta.roundNumber))),
      status: meta.status,
      timeRemainingMs: Math.max(0, Math.min(300000, Math.round(meta.timeRemainingMs))),
      balloonsCount: Math.max(0, Math.min(50, Math.round(meta.balloonsCount))),
      savedAt: serverTimestamp(),
    };
    if (!existing.exists()) {
      await setDoc(ref, {
        checkpointId: safeId,
        roomId: ROOM_ID,
        hostUid,
        ...payload,
      });
    } else {
      await updateDoc(ref, payload);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}
