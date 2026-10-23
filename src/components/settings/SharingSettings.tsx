import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Text } from '../themed';
import StatusMessage from './StatusMessage';
import { apiRequest, type Sharing } from '../../services/account/client';
import { useSync } from '../../hooks/useSync';

export default function SharingSettings() {
  const { account, refreshShared, runSync } = useSync();
  const [sharing, setSharing] = useState<Sharing>({ shares: [], invitations: [] });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [invitation, setInvitation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setSharing(await apiRequest<Sharing>('/sharing')), []);
  useEffect(() => {
    const refresh = () => { void load().catch(() => setError('Could not load sharing. Check your connection.')); };
    refresh(); window.addEventListener('account:synced', refresh);
    return () => window.removeEventListener('account:synced', refresh);
  }, [load]);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); await load(); await refreshShared(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Sharing could not be updated.'); }
    finally { setBusy(false); }
  };
  const invite = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const result = await apiRequest<{ code: string }>('/sharing/invite', { method: 'POST', body: JSON.stringify({ email }) });
      setInvitation(result.code);
    });
  };
  const accept = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await apiRequest('/sharing/accept', { method: 'POST', body: JSON.stringify({ code: code.trim() }) });
      setCode(''); await runSync();
    });
  };
  return <div className="settings-divider account-form">
    <Text variant="primary">Share future todos</Text>
    <Text variant="secondary">Invite someone to view todos you create after they accept. Existing todos, journal entries, and sticky notes stay private. Sharing starts on each device when it next syncs.</Text>
    <form className="account-form" onSubmit={invite}>
      <label className="settings-label" htmlFor="share-email">Their JournAi account email</label>
      <input className="settings-input" id="share-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} disabled={busy} />
      <Button type="submit" variant="secondary" size="sm" disabled={busy}>Create invitation</Button>
    </form>
    {invitation && <div className="account-form">
      <label className="settings-label" htmlFor="share-invitation">Send this code to the person you invited. It expires in 24 hours.</label>
      <input className="settings-input" id="share-invitation" value={invitation} readOnly onFocus={e => e.target.select()} />
    </div>}
    <form className="account-form" onSubmit={accept}>
      <label className="settings-label" htmlFor="share-code">Have an invitation?</label>
      <input className="settings-input" id="share-code" placeholder="Paste invitation code" required value={code} onChange={e => setCode(e.target.value)} disabled={busy} />
      <Button type="submit" variant="secondary" size="sm" disabled={busy}>Accept invitation</Button>
    </form>
    {sharing.shares.map(share => <div className="account-share-row" key={share.id}>
      <Text variant="secondary">{share.ownerId === account?.id ? `${share.viewerEmail} can view your future todos` : `You can view ${share.ownerEmail}’s future todos`}</Text>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => apiRequest(`/sharing/${share.id}`, { method: 'DELETE' }))}>Stop sharing</Button>
    </div>)}
    {sharing.invitations.map(invite => <div className="account-share-row" key={invite.email}>
      <Text variant="secondary">Invitation pending: {invite.email}</Text>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(async () => {
        await apiRequest('/sharing/invite', { method: 'DELETE', body: JSON.stringify({ email: invite.email }) }); setInvitation('');
      })}>Cancel invitation</Button>
    </div>)}
    {error && <StatusMessage variant="error">{error}</StatusMessage>}
  </div>;
}
