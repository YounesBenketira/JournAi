import { createContext, useContext, useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import type { SyncConnectionStatus, SyncProgress, SyncSummary } from '../types/sync';
import { apiRequest, getSession, signIn, signOut, type Account, type SharedTodo } from '../services/account/client';
import { getAccountMeta, initializeAccountStorage } from '../services/account/storage';
import { syncAccount } from '../services/account/sync';
import { getPendingConflicts, resolveConflict as resolveStoredConflict, type SyncConflictRow } from '../services/sync/localRepository';

interface SyncContextType {
  account: Account | null; connected: boolean; loading: boolean; status: SyncConnectionStatus;
  message: string | null; progress: SyncProgress | null; summary: SyncSummary | null;
  lastSyncedAt: string | null; canSync: boolean; conflicts: SyncConflictRow[]; sharedTodos: SharedTodo[];
  login: (email: string, password: string, register: boolean) => Promise<void>;
  disconnect: () => Promise<void>; runSync: () => Promise<SyncSummary>;
  refreshShared: () => Promise<void>;
  resolveConflict: (id: string, resolution: 'local' | 'remote') => Promise<void>;
}
const SyncContext = createContext<SyncContextType | undefined>(undefined);

export function SyncProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SyncConnectionStatus>('disconnected');
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflictRow[]>([]);
  const [sharedTodos, setSharedTodos] = useState<SharedTodo[]>([]);
  const inFlight = useRef<Promise<SyncSummary> | null>(null);
  const active = useRef(true);

  const refreshShared = useCallback(async () => {
    try {
      const result = await apiRequest<{ records: SharedTodo[] }>('/shared-todos');
      if (active.current) setSharedTodos(result.records);
    } catch (error) {
      // Do not retain shared records offline after access may have been revoked.
      if (active.current) setSharedTodos([]);
      throw error;
    }
  }, []);
  const runSync = useCallback((): Promise<SyncSummary> => {
    if (inFlight.current) return inFlight.current;
    setStatus('syncing'); setMessage(null);
    const operation = async () => {
      try {
        const result = await syncAccount(value => { if (active.current) setProgress(value); });
        await refreshShared();
        if (active.current) {
          setSummary(result); setStatus(result.status); setLastSyncedAt(result.lastSyncedAt);
          setConflicts(await getPendingConflicts());
        }
        return result;
      } catch (error) {
        if (active.current) {
          setSharedTodos([]); setStatus('error');
          setMessage(error instanceof Error ? error.message : 'Sync failed. Your local changes are saved.');
        }
        throw error;
      } finally {
        if (active.current) setProgress(null);
        inFlight.current = null;
      }
    };
    inFlight.current = operation();
    return inFlight.current;
  }, [refreshShared]);
  const login = useCallback(async (email: string, password: string, register: boolean) => {
    const session = await signIn(email, password, register);
    setAccount(session.account); setStatus('connected');
    await runSync();
  }, [runSync]);
  const disconnect = useCallback(async () => {
    if (inFlight.current) await inFlight.current.catch(() => undefined);
    await signOut();
    setAccount(null); setSharedTodos([]); setStatus('disconnected'); setMessage(null); setSummary(null);
  }, []);
  const resolveConflict = useCallback(async (id: string, resolution: 'local' | 'remote') => {
    await resolveStoredConflict(id, resolution);
    setConflicts(await getPendingConflicts());
    await runSync();
  }, [runSync]);
  useEffect(() => {
    active.current = true;
    void (async () => {
      try {
        await initializeAccountStorage();
        const session = await getSession();
        if (!active.current) return;
        setAccount(session?.account ?? null);
        setLastSyncedAt(await getAccountMeta('lastSyncedAt'));
        setConflicts(await getPendingConflicts());
        if (session) await runSync();
      } catch (error) {
        if (active.current) setMessage(error instanceof Error ? error.message : 'Could not load account.');
      } finally { if (active.current) setLoading(false); }
    })();
    return () => { active.current = false; };
  }, [runSync]);
  useEffect(() => {
    if (!account) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => { void runSync().catch(() => undefined); };
    const dirty = () => { clearTimeout(timer); timer = setTimeout(sync, 1500); };
    const clearShared = () => setSharedTodos([]);
    const interval = setInterval(sync, 30000);
    window.addEventListener('sync:dirty-record', dirty);
    window.addEventListener('online', sync); window.addEventListener('offline', clearShared); window.addEventListener('focus', sync);
    return () => {
      clearInterval(interval); clearTimeout(timer);
      window.removeEventListener('sync:dirty-record', dirty);
      window.removeEventListener('online', sync); window.removeEventListener('offline', clearShared); window.removeEventListener('focus', sync);
    };
  }, [account, runSync]);
  const value = useMemo(() => ({ account, connected: Boolean(account), loading, status, message, progress,
    summary, lastSyncedAt, conflicts, sharedTodos, canSync: Boolean(account) && status !== 'syncing',
    login, disconnect, runSync, refreshShared, resolveConflict }),
  [account, loading, status, message, progress, summary, lastSyncedAt, conflicts, sharedTodos, login, disconnect, runSync, refreshShared, resolveConflict]);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
export function useSync() {
  const context = useContext(SyncContext);
  if (!context) throw new Error('useSync must be used within a SyncProvider');
  return context;
}
