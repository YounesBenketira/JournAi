import { secureStorage } from '../../lib/secureStorage';
import { deriveCredentials } from '../../../server/src/credential.js';
import { getAccountMeta, initializeAccountStorage, setAccountMeta } from './storage';
import { resetAllSyncStates } from '../sync/localRepository';

export const SERVER_URL = (import.meta.env.VITE_JOURNAI_SERVER_URL || 'https://journai.younesbenketira.com').replace(/\/$/, '');
const SESSION_KEY = 'journai.account.session.v1';
export interface Account { id: string; email: string; sharingEpoch: number }
export interface AccountSession { account: Account; token: string; journalKey: string; server: string }
export interface Share { id: string; ownerId: string; ownerEmail: string; viewerEmail: string; acceptedAt: string }
export interface Sharing { shares: Share[]; invitations: { email: string; expiresAt: number }[] }
export interface SharedTodo { recordId: string; ownerEmail: string; shareId: string; payload: { date: string; content: string; completed: number } }

export class AccountApiError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : `Request failed (${status}).`);
  }
}

export async function getSession(): Promise<AccountSession | null> {
  const raw = await secureStorage.get(SESSION_KEY);
  if (!raw) return null;
  const session = JSON.parse(raw) as AccountSession;
  return session.server === SERVER_URL ? session : null;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}, session?: AccountSession | null): Promise<T> {
  const active = session === undefined ? await getSession() : session;
  const response = await fetch(`${SERVER_URL}/api${path}`, { ...options, signal: options.signal ?? AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', ...(active ? { Authorization: `Bearer ${active.token}` } : {}), ...options.headers } });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new AccountApiError(response.status, body);
  return body as T;
}

export async function signIn(emailInput: string, password: string, register: boolean): Promise<AccountSession> {
  const email = emailInput.trim().toLowerCase();
  if (register && password.length < 12) throw new Error('Use at least 12 characters for your password.');
  await initializeAccountStorage();
  const binding = await getAccountMeta('owner');
  if (binding && binding !== `${SERVER_URL}|${email}`) throw new Error('This local journal belongs to another account. Use a separate app profile to keep your journals private.');
  const { credential, journalKey } = await deriveCredentials(email, password);
  const result = await apiRequest<{ account: Account; token: string }>(register ? '/register' : '/login', {
    method: 'POST', body: JSON.stringify({ email, credential }),
  }, null);
  const session = { ...result, journalKey, server: SERVER_URL };
  if (!binding) {
    await resetAllSyncStates();
    await setAccountMeta('owner', `${SERVER_URL}|${email}`);
    await setAccountMeta('cursor', '0');
  }
  await setAccountMeta('sharingEpoch', String(result.account.sharingEpoch));
  await secureStorage.set(SESSION_KEY, JSON.stringify(session));
  return session;
}

export async function signOut(): Promise<void> {
  const session = await getSession();
  if (session) {
    try {
      await apiRequest('/logout', { method: 'POST' }, session);
    } catch (error) {
      if (!(error instanceof AccountApiError) || error.status !== 401) throw error;
    }
  }
  await secureStorage.delete(SESSION_KEY);
  await setAccountMeta('sharingEpoch', '0');
}

export async function refreshAccount(session: AccountSession): Promise<Account> {
  const account = await apiRequest<Account>('/me', {}, session);
  await setAccountMeta('sharingEpoch', String(account.sharingEpoch));
  return account;
}
