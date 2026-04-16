# Kick integration strategy

## What was verified

Direct requests from a generic HTTP client to Kick HTML pages and likely JSON endpoints were blocked by the Kick security layer. That makes a plain unauthenticated scraper a weak base for the real following list.

## Chosen approach

The project now uses a hybrid Kick integration instead of a browser-only auth flow:

1. React handles the user-facing UI.
2. A local Kotlin backend exposes stable API endpoints to the frontend.
3. Official Kick OAuth 2.1 is used for login, token refresh, and profile-level authentication when app credentials are configured.
4. The browser bridge launches a normal local Chrome or Edge process and attaches over CDP only for unsupported website reads.
5. Live followed channels and recent chat history are still fetched through that attached local browser session, because those reads are not available in the documented Public API.

## Why this is the safer MVP path

- Official OAuth removes the need to rely on undocumented website auth for initial account connection.
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

The bridge is still required for followed-channel and chat-history reads because the current documented Public API does not expose those read endpoints. The backend and frontend are now set up so official OAuth handles supported auth concerns, while website-specific adjustments stay localized to the bridge script instead of forcing another full rewrite.

