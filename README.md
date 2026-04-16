# Chatterbro

React frontend with a local Kotlin backend for managing Kick session bridging and live following data.

## Stack

- Kotlin 2.3.20 backend
- Ktor 3.4.2 local API server
- React 19 + Vite 8 frontend
- Playwright 1.59.1 bridge attached to a local Chrome or Edge session
- Gradle wrapper 9.4.1

## Structure

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

## Run

1. `npm install`
2. Ensure Google Chrome or Microsoft Edge is installed locally.
3. `npm --prefix frontend install`
4. `./gradlew.bat run`
5. `npm --prefix frontend run dev`

The backend runs on `http://localhost:8080` and the Vite frontend runs on `http://localhost:5173`.

## Production-style preview

1. `npm --prefix frontend run build`
2. `./gradlew.bat run`

When `frontend/dist` exists, the Kotlin backend serves the built React app directly.

## Notes

The Kick login bridge prefers a normal local Chrome or Edge process over Playwright's bundled Chromium because Kick can block the bundled browser immediately.
The bridge now uses `bridge/browser-profile-cdp` for its browser profile so it does not reuse the older Playwright Chromium profile.

See `docs/kick-integration.md` for the bridge strategy and `docs/mvp-commit-plan.md` for the branch and commit plan.
