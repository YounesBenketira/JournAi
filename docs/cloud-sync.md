# Account sync and sharing

JournAi uses one account server on the owner's VPS. Sign in from Settings on each device.
The local SQLCipher database remains available offline. Sign-in uploads existing local records;
another account cannot attach to the same local database and upload its contents.

## Data and ownership

- Local durable records: SQLite tables `entries`, `todos`, and `sticky_notes`.
- Local pending writes: `sync_state`; unresolved concurrent edits: `sync_conflicts`.
- Account binding, sharing epoch and download cursor: `account_sync_meta`.
- Server revisions seen by this device: `account_sync_revisions`.
- Todo creation-time sharing state: `todo_sharing_origin`. Missing state means private historical data.
- Session and journal encryption key: OS secure storage under `journai.account.session.v1`.
- VPS durable storage: `/var/lib/journai/journai.db`, managed by `journai.service`.
- Server records are keyed by `owner_id, collection, id`. Every API request derives the owner from a validated session.
- Shared todos are held only in React memory, never written into the viewer's local todo table.
  Failed refreshes, sign-out, app lock, and offline events remove that view. Previously seen content cannot be recalled.

## Encryption

The client derives independent login and journal keys from the account password using PBKDF2 and HKDF.
Only the login proof is sent to the server, where a salted scrypt hash is stored.
Journal payloads use AES-256-GCM; neither the journal key nor plaintext journal is uploaded.
Todos and sticky notes are readable by the authenticated account service so ChatGPT can use them while devices are off.
They are not available to other accounts except through the explicit future-todo sharing grant.
Password recovery is not implemented. Keep the password and a local export safe.

## Sync behavior

Sign-in, startup, reconnect, focus, a 30-second interval, and debounced local changes trigger sync.
Uploads carry the last known server revision. The server checks and updates this revision in one SQLite transaction.
A stale update returns the current server record; the app preserves both copies for explicit conflict resolution.
Download pages use a server-generated monotonic revision cursor. Deletes remain tombstones.
A local transaction checks that the row and its sync state have not changed before applying a download.
Edits made during an upload stay dirty for the next cycle. Retries compare decrypted content to recover a lost response.
Calendar views refresh after sync; downloaded journal changes refresh the entries view.

## Sharing

1. The owner enters the recipient's JournAi account email and creates an invitation.
2. The owner sends the random code directly to the recipient. There is no automatic email message.
3. The recipient signs in and accepts the code. Codes expire after 24 hours and are single-use.
4. Acceptance atomically creates a directional, read-only share with a server timestamp and a new sharing epoch.
5. The owner's devices learn the new epoch on their next sync. Newly created todos capture it locally.
6. The server returns a todo only when both its original creation time and creation epoch meet the share cutoff.

Older todos stay private after edits, imports, later uploads, or a new pairing.
A device that has not learned the pairing keeps its new todos private until it next syncs.
Journal entries and sticky notes are never shared. Either person can end the connection.
Reconnecting starts a fresh cutoff and does not expose the previous connection's todos.

## ChatGPT

The same service exposes `/mcp` with OAuth discovery, dynamic client registration, S256 PKCE,
CSRF-protected consent, one-use codes, audience-bound tokens, scoped tools and refresh-token rotation.
Tools list/create/update the signed-in user's todos and sticky notes and list view-only shared todos.
There are no journal or sharing-administration tools. Settings can revoke ChatGPT access.

## Migration from Google Drive

The account settings replace provider selection. Existing local data is uploaded on first sign-in.
Old Google Drive data and secrets are not deleted. The previous provider modules remain dormant for recovery;
the active app context does not call them. Before upgrading a device whose latest data exists only in Drive,
use the previous app version to download it or import an export into the local journal.
The old Drive implementation uploaded a raw encryption key in its manifest; the account server does not use that format.

## Operation and verification

See [the server guide](../server/README.md) for deployment, backups and connection instructions.
Install the root dependencies with `bun install --frozen-lockfile` and server dependencies with `npm ci --prefix server`.
Use Node 22.13 or later. Run `npm test --prefix server` for server integration checks.
Run `npx vitest run src/services/account/__tests__/sync.test.ts` for two-device HTTP/SQLite checks.
The user explicitly waived shared quality gates for this feature; functional and permission checks remain required.
Native release, DNS/Tunnel routing, and actual ChatGPT account connection need live verification.
