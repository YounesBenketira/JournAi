import { useState } from 'react';
import { Button, Text } from '../themed';
import { apiRequest } from '../../services/account/client';
import StatusMessage from './StatusMessage';

interface ConnectionPreview { clientName: string; scopes: string[]; expiresAt: number }
const permissionLabels: Record<string, string> = {
  'todos:read': 'Read todos', 'todos:write': 'Create and update todos',
  'notes:read': 'Read sticky notes', 'notes:write': 'Create and update sticky notes',
};

export default function ChatGptApproval() {
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<ConnectionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const submit = async (approve: boolean) => {
    setBusy(true); setError(null);
    try {
      const body = JSON.stringify({ code: code.trim() });
      if (approve) {
        await apiRequest('/connections/approve', { method: 'POST', body });
        setApproved(true); setCode(''); setPreview(null);
      } else {
        const result = await apiRequest<ConnectionPreview>('/connections/preview', { method: 'POST', body });
        setPreview(result);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not approve this connection.');
    } finally { setBusy(false); }
  };
  return <div className="account-form">
    <Text variant="secondary">Already signed in here? On the Connect JournAi browser page, choose approval from your signed-in app. Paste its code below. Only approve a connection you started yourself.</Text>
    <label className="settings-label" htmlFor="chatgpt-connection-code">Connection code</label>
    <input id="chatgpt-connection-code" className="settings-input" value={code} disabled={busy} autoComplete="off" spellCheck={false}
      onChange={event => { setCode(event.target.value); setPreview(null); setApproved(false); }} />
    {preview ? <>
      <Text variant="primary">Allow {preview.clientName} to access this account?</Text>
      <ul>{preview.scopes.map(scope => <li key={scope}>{permissionLabels[scope] ?? scope}</li>)}</ul>
      <Text variant="secondary">Journal entries are excluded. You can revoke access below.</Text>
      <Button size="sm" disabled={busy} onClick={() => void submit(true)}>Allow access</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPreview(null); setCode(''); }}>Cancel</Button>
    </> : <Button size="sm" variant="secondary" disabled={busy || !code.trim()} onClick={() => void submit(false)}>Review connection</Button>}
    {error && <StatusMessage variant="error">{error}</StatusMessage>}
    {approved && <StatusMessage variant="success">Approved. Return to your ChatGPT browser tab to finish connecting.</StatusMessage>}
  </div>;
}
