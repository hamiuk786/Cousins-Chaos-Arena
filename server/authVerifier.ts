import fs from 'node:fs';
import path from 'node:path';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export interface VerifiedUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
  isHost: boolean;
}

export type TokenVerifierFn = (idToken: string) => Promise<VerifiedUser>;

const HOST_EMAIL = (process.env.HOST_ADMIN_EMAIL || 'bhoraniyahami@gmail.com').toLowerCase().trim();

function loadFirebaseProjectId(): string | null {
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as { projectId?: string };
    if (!parsed.projectId || parsed.projectId === 'remixed-project-id') {
      return null;
    }
    return parsed.projectId;
  } catch {
    return null;
  }
}

let adminAuthInitialized = false;

function ensureAdminAuth() {
  if (adminAuthInitialized) return;
  const projectId = loadFirebaseProjectId();
  if (!projectId) {
    throw new Error('Firebase project configuration is missing.');
  }
  if (!getApps().length) {
    // Only projectId is needed for verifyIdToken(token) — requires zero IAM roles.
    initializeApp({ projectId });
  }
  adminAuthInitialized = true;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedUser> {
  if (typeof idToken !== 'string' || idToken.trim().length < 20) {
    throw new Error('Invalid authentication token.');
  }
  ensureAdminAuth();
  const app = getApp();
  const decoded = await getAuth(app).verifyIdToken(idToken);
  const email = typeof decoded.email === 'string' ? decoded.email.toLowerCase() : null;
  const emailVerified = decoded.email_verified === true;
  const displayName =
    (typeof decoded.name === 'string' && decoded.name.trim()) ||
    (email ? email.split('@')[0] : `Guest-${decoded.uid.slice(0, 6)}`);

  return {
    uid: decoded.uid,
    email,
    emailVerified,
    displayName: displayName.slice(0, 40),
    isHost: emailVerified && email === HOST_EMAIL,
  };
}
