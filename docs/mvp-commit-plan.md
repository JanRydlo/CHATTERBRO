# MVP commit plan

## Branch workflow

- Keep `main` releasable.
- Create all work on `feature/*` branches.
- Keep one concern per commit.
- Merge only after local smoke validation.

## Suggested branch and commit sequence

### 1. feature/react-foundation

- `chore: bootstrap kotlin api backend and react frontend`
- `docs: record kick bridge constraints and architecture`

### 2. feature/bridge-login

- `feat: add playwright kick login bridge`
- `feat: expose bridge status endpoints in ktor`

### 3. feature/live-following

- `feat: fetch live followings through the bridge`
- `test: cover repository parsing and fallback behavior`

### 4. feature/react-dashboard

- `feat: add react dashboard for bridge state and live channels`
- `feat: wire frontend proxy and production build flow`

### 5. feature/chat-window

- `feat: add separate chat launcher from the react dashboard`
- `chore: define channel and chat open behavior`

### 6. feature/preferences

- `feat: persist last profile and bridge preferences`

### 7. feature/release-hardening

- `test: add startup smoke tests and bridge contract checks`
- `chore: finalize build and release notes`
