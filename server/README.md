# JournAi server

One account service for device sync, view-only future-todo sharing, and ChatGPT MCP tools.
Requires Node 22.13 or later. No OpenAI API key is needed.

## Run locally

Run `npm ci` in this directory, set `JOURNAI_ORIGIN=http://127.0.0.1:4391`, and run `npm start`.
For browser development, set `JOURNAI_ALLOWED_ORIGINS=http://localhost:1420` and build the app with
`VITE_JOURNAI_SERVER_URL=http://127.0.0.1:4391`. Native release builds require the production HTTPS origin in their CSP.
Run `npm test` for real HTTP, sharing, revision, OAuth and MCP integration checks using disposable data.

## VPS deployment

Install this directory, including `package-lock.json`, into an immutable release under
`/opt/journai/releases/<release>/`, run `npm ci --omit=dev`, and point `/opt/journai/current` to it.
Install `deployment/journai.service` into `/etc/systemd/system/` and configure
`/etc/journai/server.env` using `deployment/server.env.example`. The service binds only loopback port 4391.
Install the backup service and timer from `deployment/`; enable the service and timer with systemd.
The service owns durable SQLite data in `/var/lib/journai`, outside the release. Never replace this directory during deployment.

Route the exact public hostname through Cloudflare Tunnel to `http://127.0.0.1:4391`.
If routing through the existing Caddy listener instead, import `deployment/journai.caddy`
inside its public route before the fallback, validate Caddy, and reload it.
Keep unrelated routes intact. Use managed DNS/Tunnel credentials; do not expose the backend port.
Verify `/health` locally and over public HTTPS, and verify unauthenticated `/mcp` returns 401 with discovery metadata.
Rollback by restoring the previous release symlink and restarting only `journai.service`.

Daily backups use SQLite's backup API and verify integrity. Backups contain private account data and must remain protected.
Copy backups to a separate secured host for disaster recovery. No automatic pruning is configured.
Restore with the service stopped, preserving a copy of the current database and its WAL before replacement.

## Accounts and permissions

Users create accounts in JournAi. The client derives separate login and journal-encryption keys from
the password using PBKDF2-SHA256 (600,000 iterations) and HKDF. The server receives the login proof,
stores a salted scrypt hash, and never receives the journal key. Password recovery is not implemented;
keep the password and local export safe. Email is an account identifier, not verified email delivery.
Invites require both the intended account and a random single-use code, supplied directly by the inviter.

Sessions are opaque, hashed in SQLite, and expire after 30 days. OAuth access tokens expire after one hour;
refresh tokens rotate. Sign-out revokes that app session. Revoke ChatGPT access removes all MCP access and refresh tokens for the account.

Todos and sticky notes are readable by this service; journals are stored as authenticated ciphertext.
The MCP resource cannot read journal entries or perform sharing administration. Only owners can mutate records.
Sharing is directional and read-only. Acceptance records a server timestamp and advances the owner's sharing epoch.
Todos capture the epoch known on their creating device. Both epoch and original creation time must pass
the server's cutoff. Imports and unsynced historical records default to epoch zero and remain private.
Stopping and later restarting sharing creates a new cutoff. No shared records are saved in the viewer's local database.

## ChatGPT

In ChatGPT Plugins, add a custom MCP server using `https://<hostname>/mcp` and OAuth.
Dynamic client registration permits only the documented ChatGPT callback paths on `chatgpt.com`.
Sign in and approve access in the browser. Authorization requires S256 PKCE, bound redirect URI,
resource audience, state forwarding, an expiring CSRF-protected consent request and a one-use code.
Tools list and create/update own todos and sticky notes and list shared todos. Journal entries are never tools.
Creation tools take a UUID request ID so retries do not duplicate a task. Updates require a fresh revision.

## Scope of verification

Automated integration checks use isolated accounts and an in-memory database. They do not prove that
a particular ChatGPT account has connected, that native app installers have been released, or that DNS is deployed.
Those require separate live verification.
