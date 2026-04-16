# Chatterbro

Chatterbro is a local dashboard for viewing live followed Kick channels through a React frontend, a Kotlin/Ktor backend, and a browser-backed Kick bridge.

## What It Does

- Opens a real Kick login flow in Chrome or Edge.
- Captures and persists the authenticated Kick session locally.
- Shows the connected Kick profile in the UI while the token is valid.
- Loads live followed channels without asking for a username.
- Uses a background browser context for Kick API calls that are blocked from plain backend HTTP.

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
- Google Chrome or Microsoft Edge installed locally

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

## Kick Session Flow

1. Click the connect button in the UI.
2. Sign in through the Kick window opened in a real local browser profile.
3. Let the bridge capture the session token, expiry, and profile.
4. Reload live followed channels through the saved authenticated session.

Session and browser artifacts are kept under `bridge/session/` and `bridge/browser-profile-cdp/`, and are intentionally ignored by git.

## API Overview

- `GET /api/bridge/status` returns bridge state, token status, expiry, and connected profile.
- `POST /api/bridge/start` starts the login bridge.
- `GET /api/following/live` returns the authenticated account's live followed channels.

## Notes

Kick blocks some plain server-side requests even with a valid captured token, so the project deliberately performs authenticated follow queries from a background browser context.

See `docs/kick-integration.md` for the bridge strategy and `docs/mvp-commit-plan.md` for the implementation plan.
