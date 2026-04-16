# Kick integration strategy

## What was verified

Direct requests from a generic HTTP client to Kick HTML pages and likely JSON endpoints were blocked by the Kick security layer. That makes a plain unauthenticated scraper a weak base for the real following list.

## Chosen approach

The project now uses a browser-backed bridge instead of relying on raw HTTP requests alone:

1. React handles the user-facing UI.
2. A local Kotlin backend exposes stable API endpoints to the frontend.
3. The bridge launches a normal local Chrome or Edge process and attaches over CDP instead of relying on Playwright's bundled Chromium.
4. The bridge stores browser session data and reuses it for subsequent data collection.
5. Live followed channels are fetched through that attached local browser session, not through a brittle direct HTTP-only scraper.

## Why this is the safer MVP path

- Cloudflare-style checks are better handled by a real browser session.
- Kick can block Playwright's bundled Chromium before the login page appears, so the bridge now prefers an installed local Chrome or Edge binary.
- React stays isolated from Kick-specific scraping details.
- Kotlin stays responsible for orchestration, API stability, and future business rules.
- If Kick changes its page structure or endpoint shape, the blast radius stays mostly inside `bridge/kick-bridge.mjs`.

## Current boundaries

- `domain`: channel models and use cases
- `data`: bridge runner, status persistence, repository implementations
- `api`: Ktor routes for the React frontend
- `frontend`: React UI shell and API client
- `bridge`: Playwright login and live-following extraction

## Important caveat

The bridge is real and usable, but Kick can still change DOM structure or navigation paths. The backend and frontend are set up so that those adjustments stay localized to the bridge script instead of forcing a full rewrite.

