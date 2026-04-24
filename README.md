# Chatterbro

Chatterbro is a local Kick OAuth dashboard with a React frontend and a Kotlin/Ktor backend.

## What It Does

- Connects a Kick account through official Kick OAuth 2.1.
- Persists OAuth access and refresh tokens locally for profile-level authentication.
- Opens a browser only for the OAuth sign-in flow.
- Keeps using the saved token after sign-in without any background browser bridge.
- Shows the connected Kick profile in the UI while the token is valid.
- Maintains a local tracked-channel watchlist with live/offline status and stream metadata.
- Sends chat messages through Kick's official `chat:write` API when that scope is granted.
- Surfaces current Kick Public API limits explicitly instead of falling back to website scraping.

## Stack

- Kotlin 2.3.20
- Ktor 3.4.2
- React 19
- Vite 8
- Playwright 1.59.1
- Gradle wrapper 9.4.1

## Project Layout

.
|- bridge/
|  `- kick-bridge.mjs
|- docs/
|  |- kick-integration.md
|  `- mvp-commit-plan.md
|- frontend/
|  |- src/
|  `- package.json
|- gradle/wrapper/
|- src/main/kotlin/com/chatterbro/
|  |- api/
|  |- data/
|  `- domain/
|- build.gradle.kts
|- package.json
`- settings.gradle.kts

## Prerequisites

- Windows with PowerShell
- Java 17+
- Node.js 20+
- A Kick developer app if you want to enable official OAuth login

## OAuth Setup

Values získáš v Kick portálu takto:

1. Otevři Kick account settings.
2. Zapni 2FA.
3. Jdi na `Developer` tab.
4. Vytvoř appku.
5. Z ní vezmi `Client ID`, `Client Secret` a nastav tam svůj `Redirect URL`.

Tyto hodnoty pak zapiš buď do systémových environment proměnných, nebo jednoduše do `.env` souboru v rootu projektu. V repu je připravený vzor v [.env.example](.env.example).

Backend čte tyto hodnoty:

- `KICK_CLIENT_ID`
- `KICK_CLIENT_SECRET`
- `KICK_REDIRECT_URI`
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `TWITCH_REDIRECT_URI`
- `CHATTERBRO_FRONTEND_URL` optional, defaults to `http://localhost:8080`
- `KICK_OAUTH_SCOPES` optional, defaults to `user:read channel:read chat:write`
- `TWITCH_OAUTH_SCOPES` optional, defaults to `user:read:follows chat:read chat:edit user:read:emotes`

Doporučené lokální hodnoty:

- `KICK_REDIRECT_URI=http://localhost:8080/api/auth/callback`
- `TWITCH_REDIRECT_URI=http://localhost:8080/api/twitch/auth/callback`
- `CHATTERBRO_FRONTEND_URL=http://localhost:8080` when Ktor serves the built frontend
- `CHATTERBRO_FRONTEND_URL=http://localhost:5173` when you run the Vite dev server

If OAuth variables are not configured, the app stays in a disabled token-only state and will not fall back to any browser bridge login flow.

## Local Development

1. Install root dependencies with `npm install`.
2. Install frontend dependencies with `npm --prefix frontend install`.
3. Start the backend with `./gradlew.bat run`.
4. In a second terminal, start the frontend with `npm --prefix frontend run dev`.
5. Open `http://localhost:5173`.

The backend listens on `http://localhost:8080` and the Vite frontend listens on `http://localhost:5173`.

## Production-Style Preview

1. Build the frontend with `npm --prefix frontend run build`.
2. Start the backend with `./gradlew.bat run`.
3. Open `http://localhost:8080`.

When `frontend/dist` exists, Ktor serves the built React app directly.
The Gradle `run` task now rebuilds the frontend bundle first, so backend preview runs do not accidentally serve an outdated `frontend/dist`.

## Kick Session Flow

1. Click the connect button in the UI.
2. Complete the Kick OAuth 2.1 flow in your browser.
3. Let the backend store the OAuth access token, refresh token, expiry, and profile.
4. Close the browser after sign-in.
5. The app keeps using the saved token until it expires or is revoked.

OAuth session artifacts are kept under `bridge/session/` and are intentionally ignored by git.

## API Overview

- `GET /api/bridge/status` returns bridge state, token status, expiry, and connected profile.
- `POST /api/bridge/start` returns `501` because the browser bridge is disabled in token-only mode.
- `GET /api/auth/login` starts the official Kick OAuth flow.
- `GET /api/auth/callback` completes the OAuth callback and persists the local session.
- `GET /api/following/live` currently returns `501` because Kick Public API does not expose the authenticated account's followed-channel list.
- `GET /api/channels/tracked` returns tracked channels with live/offline status, viewer count, tags, and available stream metadata.
- `GET /api/chat/{channelSlug}` currently returns `501` because Kick Public API does not expose chat-history reads.
- `POST /api/chat/{channelSlug}/messages` sends a chat message through Kick's official chat endpoint when the token has `chat:write`.

## Twitch Mode

- The provider switcher in the React UI now opens a separate Twitch dashboard without changing the existing Kick flow.
- `GET /api/twitch/auth/status` returns the local Twitch OAuth status using the same status shape as the Kick status endpoint.
- `GET /api/twitch/auth/login` starts the Twitch OAuth flow.
- `GET /api/twitch/auth/callback` completes the Twitch OAuth callback and persists the local Twitch session.
- `GET /api/twitch/following/live` loads live followed Twitch channels through Helix.
- `GET /api/twitch/channels/tracked` resolves tracked Twitch logins through Helix and merges them into the local watchlist.
- `GET /api/twitch/chat/{channelSlug}` returns the local Twitch IRC chat buffer for the opened channel.
- `GET /api/twitch/chat/{channelSlug}/emotes` returns merged Twitch global, channel, and user emotes when scopes allow it.
- `POST /api/twitch/chat/{channelSlug}/messages` sends a message through the authenticated Twitch chat session when the token has `chat:edit`.

## Notes

Kick's official Public API now handles authentication, profile reads, tracked channel status, and chat sending, but it still does not expose read endpoints for followed channels, recent chat history, or the chatroom target needed for reliable live chat reads. This project intentionally refuses to start any hidden browser session for those unsupported reads.

See `docs/kick-integration.md` for the bridge strategy and `docs/mvp-commit-plan.md` for the implementation plan.
