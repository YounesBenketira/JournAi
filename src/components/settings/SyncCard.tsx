import { useState, type FormEvent } from 'react';
import { IoCloudOutline, IoRefresh } from 'react-icons/io5';
import { Button, Spinner, Text } from '../themed';
import StatusMessage from './StatusMessage';
import { useSync } from '../../hooks/useSync';
import { SERVER_URL, apiRequest } from '../../services/account/client';
import SharingSettings from './SharingSettings';
import ChatGptApproval from './ChatGptApproval';
import ConflictResolutionModal from './ConflictResolutionModal';
import '../../styles/settings.css';

export default function SyncCard() {
  const { account, loading, status, message, progress, lastSyncedAt, canSync, login, disconnect, runSync, conflicts } = useSync();
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showConflicts, setShowConflicts] = useState(false);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not complete this action.'); }
    finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => { await login(email, password, register); setPassword(''); });
  };
  if (loading) return <div className="settings-sync-card"><Spinner size="sm" /></div>;
  return <div className="settings-sync-card">
    <div className="settings-sync-header"><div className="settings-sync-heading">
      <span className="settings-sync-heading__icon" aria-hidden="true"><IoCloudOutline size={24} /></span>
      <div className="settings-sync-heading__copy">
        <Text variant="primary" className="settings-sync-title">JournAi Account</Text>
        <Text variant="secondary" className="settings-sync-subtitle">{account ? account.email : 'Your journal, todos, and notes across your devices.'}</Text>
      </div>
    </div></div>
    {!account ? <form className="account-form" onSubmit={submit}>
      <label className="settings-label" htmlFor="account-email">Email</label>
      <input id="account-email" className="settings-input" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} disabled={busy} />
      <label className="settings-label" htmlFor="account-password">Password</label>
      <input id="account-password" className="settings-input" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 12 : undefined} required value={password} onChange={e => setPassword(e.target.value)} disabled={busy} />
      {register && <Text variant="secondary">Use at least 12 characters. Keep this password safe: it protects your encrypted journal and cannot be recovered.</Text>}
      <Text variant="secondary">Signing in syncs this device’s existing data to your account. Journal entries stay encrypted. Todos and notes are stored in your account for sharing and ChatGPT access.</Text>
      <div className="account-actions">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? 'Connecting...' : register ? 'Create account' : 'Sign in'}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setRegister(!register)}>{register ? 'Already have an account?' : 'Create an account'}</Button>
      </div>
    </form> : <>
      <div className="settings-sync-panel">
        <div className="account-actions">
          <Button variant="secondary" size="sm" icon={<IoRefresh />} disabled={!canSync || busy} onClick={() => void act(runSync)}>{status === 'syncing' ? 'Syncing...' : 'Sync now'}</Button>
          <Button variant="ghost" size="sm" disabled={busy || status === 'syncing'} onClick={() => void act(disconnect)}>Sign out</Button>
        </div>
        <Text variant="secondary">{progress?.message ?? (lastSyncedAt ? `Last synced: ${new Date(lastSyncedAt).toLocaleString()}` : 'Your changes sync automatically.')}</Text>
        {conflicts.length > 0 && <Button variant="secondary" size="sm" onClick={() => setShowConflicts(true)}>Review conflicting edits ({conflicts.length})</Button>}
      </div>
      <SharingSettings />
      <div className="settings-divider account-form">
        <Text variant="primary">ChatGPT</Text>
        <Text variant="secondary">Add a custom MCP server in ChatGPT Plugins, then sign in to JournAi. ChatGPT can read and write your todos and sticky notes. Journal entries are excluded.</Text>
        <label className="settings-label" htmlFor="account-mcp-url">Server URL</label>
        <input id="account-mcp-url" className="settings-input" value={`${SERVER_URL}/mcp`} readOnly onFocus={e => e.target.select()} />
        <ChatGptApproval />
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act(async () => {
          await apiRequest('/connections/revoke', { method: 'POST' }); setNotice('ChatGPT access revoked. Reconnect to allow access again.');
        })}>Revoke ChatGPT access</Button>
      </div>
    </>}
    {(error || message) && <StatusMessage variant="error">{error || message}</StatusMessage>}
    {notice && <StatusMessage variant="success">{notice}</StatusMessage>}
    <ConflictResolutionModal isOpen={showConflicts} onClose={() => setShowConflicts(false)} />
  </div>;
}
