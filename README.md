# 📓 JournAi

A private journaling app built with Tauri v2, React 19, and Rust. Work offline, or sign in to sync through your JournAi server. Journal entries are encrypted on the client before sync; todos and sticky notes support account sharing and ChatGPT access.

![Platform](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20iOS%20%7C%20Android-blue)
![Built With](https://img.shields.io/badge/built%20with-Tauri%20v2%20%2B%20React%2019%20%2B%20Rust-orange)

### Account sync, sharing, and ChatGPT

- Sign in on each device to sync through one self-hosted server.
- Invite a partner to view only todos created after the connection begins.
- Use ChatGPT to read and write your own todos and sticky notes through authenticated MCP tools.
- Keep journal entries encrypted separately from shared todos.

See [account sync](docs/cloud-sync.md) and [server deployment](server/README.md).

### Download

| Platform | Link |
| -------- | ---- |
| macOS (Universal) | [JournAi-macOS.dmg](https://github.com/MuslimSoftware/JournAi/releases/latest/download/JournAi-macOS.dmg) |
| Windows | [JournAi-Windows-setup.exe](https://github.com/MuslimSoftware/JournAi/releases/latest/download/JournAi-Windows-setup.exe) |
| Linux (AppImage, self-updating) | [JournAi-Linux.AppImage](https://github.com/MuslimSoftware/JournAi/releases/latest/download/JournAi-Linux.AppImage) |
| Linux (Deb package) | [JournAi-Linux.deb](https://github.com/MuslimSoftware/JournAi/releases/latest/download/JournAi-Linux.deb) |

Linux note: use the AppImage if you want in-app updates. Deb installs are updated through your system package installer, so the app downloads the latest Deb instead of silently replacing system-owned files.

---

## ✨ Features

### 📝 Journaling

- Rich text editor with cursor tracking and content change detection
- Full-text search powered by SQLite FTS5 with BM25 ranking
- Cursor-based pagination for smooth infinite scrolling
- Focus mode for distraction-free writing

### ✅ Todos & Sticky Notes

- Task management with date scheduling, completion tracking, and ordering
- Quick sticky notes organized by date
- Calendar integration showing entries, todos, and sticky notes per day

### 📅 Calendar

- Visual month/year navigation with per-day content indicators
- Quick date jumping and mobile-optimized week strip view

### 🤖 AI Assistant

- **Conversational chat** with multi-turn context and streaming responses
- **Two specialized tools** the AI can invoke:
  - `query_insights` — aggregated emotions, people, and sentiment analytics
  - `query_entries` — full-text and semantic search over your journal
- **Automatic entry analysis** extracts emotions (with intensity & triggers), people (with relationships & sentiment), and source citations
- **Hybrid RAG search** combining BM25 keyword search (40%) + vector similarity (60%) via Reciprocal Rank Fusion
- **Embeddings** via `text-embedding-3-small` with sentence-aware chunking (400 tokens, 80-token overlap)
- **Context compaction** when conversation approaches 75% of model limits
- **4 model options**: GPT-5.2, GPT-5.1, GPT-4.1 Mini, GPT-4.1 Nano

### 📊 Insights & Analytics

- Emotion frequency, intensity trends, and trigger analysis
- People analytics with relationship and sentiment tracking
- Flexible filtering: last 7/30/90 days, week, month, year, or all time
- Group by entity, category, sentiment, or date

### 📱 Mobile

- Auto-switching layout: sidebar on desktop, bottom nav on mobile
- Safe area handling for notches and home indicators
- Swipe gestures, haptic feedback, and 48px touch targets
- Soft keyboard detection with auto-adjusting UI
- Bottom sheet modals, swipeable list items, and stack navigation
- Virtual scrolling via TanStack React Virtual

### 🎨 Theming

- Dark, light, and system-follow modes
- Full design token system with themed primitives (Button, Card, Text, Container)
- Smooth transitions with Framer Motion

### 📦 Import & Export

- **Export**: JSON bundle (versioned schema) or CSV folder (entries, todos, sticky notes)
- **Import**: Smart parser auto-detects format, normalizes dates, previews before committing

### 🔄 Auto-Updates

- GitHub Releases integration with cryptographic signature verification
- Download progress tracking, auto-install, and app relaunch for supported installers
- Linux AppImage self-updates when the AppImage directory is user-writable; Linux Deb installs download the latest Deb for your system installer
- Checks on startup and every 4 hours

### ⌨️ Keyboard Shortcuts

- Centralized `useKeyPress` hook with modifier key support
- `Esc` to exit focus mode / close modals
- `Ctrl+Shift+F` / `Cmd+Shift+F` to toggle focus mode
- Input-field aware — won't trigger while you're typing

---

## 🔒 Security

JournAi stores data locally in an encrypted database. Account sync sends encrypted journal payloads and readable todos and sticky notes to your authenticated JournAi server. Shared accounts can view only eligible future todos. ChatGPT tools cannot access journal entries.

### 🗄️ Encrypted Database

- SQLite encrypted with **SQLCipher** — your entire database is encrypted at rest
- Database file (`journai.db`) is unreadable without the correct key
- Automatic corruption detection with backup and recovery workflow

### 🔑 App Lock

- **Password-protected lock screen** gates access to all journal data
- Key derivation uses **Argon2id** — the gold standard memory-hard KDF resistant to GPU/ASIC attacks
  - Desktop: 64 MiB memory cost · 3 iterations
  - Mobile: 32 MiB memory cost · 3 iterations (tuned for device constraints)
- **AES-256-GCM** key wrapping: a Key Encryption Key (KEK) derived from your passphrase wraps a random Data Encryption Key (DEK)
- Configurable auto-lock timeout (immediate, 5 minutes, or manual)
- Locks on app background/minimize and closes the database connection

### 🔐 Secure Storage

- API keys and secrets stored in your **OS-native credential manager**:
  - 🍎 macOS → Apple Keychain
  - 🪟 Windows → Windows Credential Manager
  - 🐧 Linux → Secret Service (encrypted persistent storage)
  - 📱 Mobile → iOS Keychain / Android Keystore
- Runtime availability probing — gracefully disables AI features if credential storage is unavailable
- API keys are **never stored in plain-text config files**

### 🛡️ API Key Protection

- Password-masked input with toggle visibility
- Format validation (`sk-` prefix pattern matching)
- Only the last 4 characters shown in the UI
- Event-driven change notifications for downstream consumers

### 🏠 Local-First Privacy

- **All data stored locally by default** — no telemetry and no JournAi-hosted accounts
- Optional cloud sync stores encrypted app data in your own provider account
- The only AI connection is to OpenAI (for chat, embeddings, and analysis) using your own API key
- API keys never appear in logs or get transmitted to anyone other than OpenAI
- You own your data — export it anytime as JSON or CSV

### 🔧 Database Resilience

- Serialized operations prevent race conditions
- Exponential backoff retry logic (up to 10 retries) for lock contention
- Automatic backup on corruption detection before recovery
- Secure random generation via Rust's `OsRng`

---

## 🛠️ Tech Stack

| Layer           | Technology                              |
| --------------- | --------------------------------------- |
| Framework       | Tauri v2 (Rust backend)                 |
| Frontend        | React 19 + TypeScript + Vite            |
| Database        | SQLite + SQLCipher + FTS5               |
| Crypto          | Argon2id + AES-256-GCM                  |
| AI              | OpenAI API (GPT-5.x / GPT-4.1)          |
| Package Manager | Bun                                     |
| Platforms       | macOS · Windows · Linux · iOS · Android |

---

## 🚀 Getting Started

```bash
# Install dependencies
bun install

# Run in development
bun run tauri dev

# Build for production
bun run tauri build
```

### iPhone Development

iOS Tauri commands must run on macOS with Xcode installed. On Fedora/Linux, `tauri ios ...` is not available and fails with `unrecognized subcommand 'ios'`. The connected iPhone should be unlocked, trusted, and visible to Xcode.

```bash
# First time only, if the iOS project has not been generated
bun run tauri ios init

# Run on a connected iPhone or simulator
bun run tauri:dev:ios

# Run on a specific device by name
bun run tauri ios dev "Your iPhone Name"

# Force choosing the network host used by the phone to reach Vite
bun run tauri ios dev --force-ip-prompt
```

For physical devices, Tauri sets `TAURI_DEV_HOST`; `vite.config.ts` already uses that value so the dev server listens on the address the iPhone can reach.

#### Troubleshooting

**Blank white screen after granting local network permission**

iOS asks for local network access on first launch. If you grant it but the app stays blank, force-close the app and reopen it — iOS requires a fresh launch to apply the permission.

**`Port 1420 is already in use` / `beforeDevCommand` fails**

A previous Vite dev server is still holding the ports. Kill it before retrying:

```bash
kill $(lsof -ti:1420,1421) 2>/dev/null
bun run tauri ios dev
```

**`Connection refused` in the "Build Rust Code" Xcode script phase**

This happens when the tauri CLI's WebSocket server never started (usually because `beforeDevCommand` failed due to the port conflict above). Fix the port conflict first, then if the error persists, clear Xcode's cached build scripts:

```bash
rm -rf ~/Library/Developer/Xcode/DerivedData/journai-*
bun run tauri ios dev
```

**`Entitlements file was modified during the build`**

Add `CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION = YES` to the iOS target's build settings in `src-tauri/gen/apple/journai.xcodeproj/project.pbxproj`. This is already set in the committed project file.

**`@tauri-apps/plugin-deep-link` not found**

Run `bun install` — the package may not have been installed despite being listed in `package.json`.

Desktop release builds are sourced from the repository root. The GitHub release workflow runs Tauri from the root, so shipped desktop artifacts use `src/` and `src-tauri/`. The separate `apps/desktop/` package only matters when running the explicit desktop scripts such as `tauri:dev:desktop`, `tauri:build:desktop`, `dev:desktop`, or `build:desktop`.

---

## 📂 Project Structure

```
src/
├── pages/          # Route-level components
├── components/     # Reusable UI + themed primitives + mobile
├── contexts/       # React contexts (theme, entries, calendar, etc.)
├── hooks/          # Custom hooks (keyboard, gestures, chat, etc.)
├── services/       # Business logic and data operations
├── ai/             # AI agent runtime, prompts, providers
├── lib/            # DB, store, secure storage infrastructure
├── styles/         # CSS per feature
├── theme/          # Design tokens
└── types/          # TypeScript interfaces
src-tauri/
├── src/lib.rs      # Tauri commands (app lock, secure storage)
└── src/main.rs     # App launcher
apps/desktop/       # Separate desktop package for explicit desktop scripts only
evals/              # AI agent evaluation framework
```
