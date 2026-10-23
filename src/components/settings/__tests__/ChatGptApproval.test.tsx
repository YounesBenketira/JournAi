import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../../contexts/ThemeContext';
import { apiRequest } from '../../../services/account/client';
import ChatGptApproval from '../ChatGptApproval';

vi.mock('../../../services/account/client', () => ({ apiRequest: vi.fn() }));
const request = vi.mocked(apiRequest);
beforeEach(() => request.mockReset());

it('requires permission review and an explicit approval click', async () => {
  request.mockResolvedValueOnce({ clientName: 'ChatGPT', scopes: ['todos:read', 'notes:write'], expiresAt: Date.now() + 60000 });
  request.mockResolvedValueOnce(undefined);
  render(<ThemeProvider><ChatGptApproval /></ThemeProvider>);
  await userEvent.type(screen.getByLabelText('Connection code'), 'connection-code');
  await userEvent.click(screen.getByRole('button', { name: 'Review connection' }));
  expect(await screen.findByText('Read todos')).toBeInTheDocument();
  expect(screen.getByText('Create and update sticky notes')).toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe('/connections/preview');
  await userEvent.click(screen.getByRole('button', { name: 'Allow access' }));
  expect(await screen.findByText(/Approved. Return/)).toBeInTheDocument();
  expect(request.mock.calls[1][0]).toBe('/connections/approve');
});

it('clears reviewed permissions when the code changes', async () => {
  request.mockResolvedValue({ clientName: 'ChatGPT', scopes: ['todos:read'], expiresAt: Date.now() + 60000 });
  render(<ThemeProvider><ChatGptApproval /></ThemeProvider>);
  const input = screen.getByLabelText('Connection code');
  await userEvent.type(input, 'first-code');
  await userEvent.click(screen.getByRole('button', { name: 'Review connection' }));
  expect(await screen.findByRole('button', { name: 'Allow access' })).toBeInTheDocument();
  await userEvent.type(input, '-changed');
  expect(screen.queryByRole('button', { name: 'Allow access' })).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});
