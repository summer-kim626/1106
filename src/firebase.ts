import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  onSnapshot,
  getDocFromServer,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

export const app = initializeApp(firebaseConfig);
const firestoreDatabaseId =
  (firebaseConfig as Record<string, any>).firestoreDatabaseId || 'ai-studio-564b5a24-a847-43de-b09e-977eb51d15bd';
export const db = getFirestore(app, firestoreDatabaseId);
export const auth = getAuth(app);

export const ADMIN_EMAIL = 'seungyeop2002@gmail.com';

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

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
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

export async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

// Automatically test connection on boot
testConnection();

export interface ApplicationRecord {
  id: string;
  name: string;
  email: string;
  phone?: string;
  org?: string;
  session: string;
  motive: string;
  agree: boolean;
  submittedAt: number;
  updatedAt: number;
}

export async function submitApplicationToFirestore(data: ApplicationRecord): Promise<void> {
  const path = `applications/${data.id}`;
  try {
    const writeOp = setDoc(doc(db, 'applications', data.id), data);
    const timeoutOp = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('서버 응답 대기 시간이 초과되었습니다. 네트워크 연결을 확인해 주세요.')), 10000)
    );
    await Promise.race([writeOp, timeoutOp]);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export function subscribeToApplications(
  onData: (apps: ApplicationRecord[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  const path = 'applications';
  return onSnapshot(
    collection(db, path),
    (snapshot) => {
      const records: ApplicationRecord[] = [];
      snapshot.forEach((d) => {
        const item = d.data() as ApplicationRecord;
        if (!item.id) item.id = d.id;
        records.push(item);
      });
      onData(records);
    },
    (error) => {
      console.warn('Applications snapshot error:', error);
      if (onError) onError(error);
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function updateApplicationInFirestore(id: string, data: Partial<ApplicationRecord>): Promise<void> {
  const path = `applications/${id}`;
  try {
    await updateDoc(doc(db, 'applications', id), {
      ...data,
      updatedAt: Date.now(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteApplicationFromFirestore(id: string): Promise<void> {
  const path = `applications/${id}`;
  try {
    await deleteDoc(doc(db, 'applications', id));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// In-memory token cache (never stored in localStorage/sessionStorage)
let cachedAccessToken: string | null = null;
export const getAccessToken = (): string | null => cachedAccessToken;
export const setAccessToken = (token: string | null): void => {
  cachedAccessToken = token;
};

export async function signInAdminWithGoogle(): Promise<{ user: User; accessToken: string | null }> {
  const provider = new GoogleAuthProvider();
  SCOPES.forEach((scope) => provider.addScope(scope));
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (credential?.accessToken) {
    cachedAccessToken = credential.accessToken;
  }
  return { user: result.user, accessToken: cachedAccessToken };
}

export async function signInAdminWithRedirect(): Promise<void> {
  const provider = new GoogleAuthProvider();
  SCOPES.forEach((scope) => provider.addScope(scope));
  provider.setCustomParameters({ prompt: 'select_account' });
  await signInWithRedirect(auth, provider);
}

export async function checkRedirectResult(): Promise<{ user: User; accessToken: string | null } | null> {
  try {
    const result = await getRedirectResult(auth);
    if (result) {
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        cachedAccessToken = credential.accessToken;
      }
      return { user: result.user, accessToken: cachedAccessToken };
    }
  } catch (err) {
    console.warn('Redirect auth check warning:', err);
  }
  return null;
}

export async function signOutAdmin(): Promise<void> {
  await signOut(auth);
  cachedAccessToken = null;
}

export function onAdminAuthChanged(callback: (user: User | null) => void): Unsubscribe {
  return onAuthStateChanged(auth, (user) => {
    if (!user) {
      cachedAccessToken = null;
    }
    callback(user);
  });
}
