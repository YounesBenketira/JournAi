import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SyncCard from '../SyncCard';
import { ThemeProvider } from '../../../contexts/ThemeContext';

const state = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../../../hooks/useSync', () => ({ useSync: () => state.current }));
vi.mock('../../../services/account/client', () => ({
  SERVER_URL: 'https://journai.example.com',
  apiRequest: vi.fn().mockResolvedValue({ shares: [], invitations: [] }),
}));
vi.mock('../ConflictResolutionModal', () => ({ default: () => null }));

describe('JournAi account settings', () => {
  beforeEach(() => {
    state.current = { account: null, loading: false, status: 'disconnected', message: null,
      progress: null, lastSyncedAt: null, canSync: false, conflicts: [],
      login: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
      runSync: vi.fn(), refreshShared: vi.fn(), sharedTodos: [] };
  });
  const renderCard = () => render(<ThemeProvider><SyncCard /></ThemeProvider>);
  it('offers one account login without provider selection', async () => {
    renderCard();
    expect(screen.queryByText('Google Drive')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email'), 'wife@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'my private password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(state.current.login).toHaveBeenCalledWith('wife@example.com', 'my private password', false);
  });
  it('explains encryption and uses the registration flow', async () => {
    renderCard();
    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.getByText(/cannot be recovered/)).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('minlength', '12');
    await userEvent.type(screen.getByLabelText('Email'), 'owner@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'my private password');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(state.current.login).toHaveBeenCalledWith('owner@example.com', 'my private password', true);
  });
  it('shows sharing and ChatGPT controls after sign-in', async () => {
    state.current.account = { id: 'owner', email: 'owner@example.com', sharingEpoch: 0 };
    state.current.canSync = true;
    renderCard();
    expect(await screen.findByLabelText('Their JournAi account email')).toBeInTheDocument();
    expect(screen.getByText(/Existing todos, journal entries, and sticky notes stay private/)).toBeInTheDocument();
    expect(screen.getByLabelText('Server URL')).toHaveValue('https://journai.example.com/mcp');
    expect(screen.queryByText('Reset Cloud Data')).not.toBeInTheDocument();
  });
});
