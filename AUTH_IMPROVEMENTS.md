# Microsoft Copilot Auth UX Improvements

Current pain: users must manually open browser → copilot.microsoft.com → start chat → hunt in DevTools for the `accessToken` (either in WS query param or `Authorization: Bearer` header) → paste into `/login`.

This document captures what was implemented + everything still on the table (as of 2026-06).

## What was shipped (biggest wins)

1. **Smart paste parser** (`extractAccessToken`)
   - Accepts raw token, `Bearer xxx`, `Authorization: Bearer ...`
   - Full request/WS URLs containing `?accessToken=...`
   - cURL commands, `fetch("...")` snippets
   - JSON objects with `accessToken` / `token` / `headers.authorization`
   - Users can literally "Copy → Copy as fetch" or copy the WS URL from Network tab and paste the whole thing.

2. **Playwright-driven automatic capture** inside the OAuth `login()` handler
   - bare `/login` then select Microsoft Copilot from menu → triggers our OAuth login (which can launch/attach browser)
   - Listens for WebSocket connections + HTTP requests on copilot.microsoft.com
   - Grabs the token the moment the page makes an authenticated call
   - Progress feedback via the pi login UI
   - Graceful fallback when playwright not present
   - Skips automatically in tests/CI or when `MICROSOFT_COPILOT_AUTH_MODE=manual`

3. **Much better messaging and escape hatches**
   - Clear instructions in the manual fallback
   - `MICROSOFT_COPILOT_AUTH_MODE=manual`
   - Optional playwright declared so `pi install` + `npx playwright install` gives magic

4. **Bookmarklet** (last resort, no deps)

## Other high-value options still on the table

| Option | Difficulty | UX | Notes / Tradeoffs |
|--------|------------|----|-------------------|
| **Connect to running browser via CDP** (`chromium.connectOverCDP("http://127.0.0.1:9222")`) | Low-Medium | Excellent | User starts Edge/Chrome with `--remote-debugging-port=9222`. Extension attaches to existing session/tabs, steals token from live requests. No new browser window. |
| **Persistent real profile** (`launchPersistentContext("~/Library/Application Support/.../Chrome/Default")`) | Medium | Magical | Reuses the user's actual logged-in cookies + storage. Profile locking issues on macOS when Chrome is open. Can copy the dir or use temporary. |
| **Local capture HTTP server** (port 17891 or random) + "Export to Pi" bookmarklet / injected script | Medium | Very good | Login flow starts tiny server. Bookmarklet on copilot page does `fetch("http://127.0.0.1:17891/capture", {method:'POST', body: JSON.stringify({token})})`. Works even without playwright. |
| **Tiny companion browser extension** ("Pi Copilot Token Bridge") | Medium-High | Best for frequent users | Adds a floating button or context menu on copilot.microsoft.com. "Send current session to pi". Can talk over native messaging or localhost. Can be auto-installed or documented. |
| **Device code / proper first-party OAuth** | High (may be impossible) | Great if it works | Discover the internal client_id + scopes that copilot.microsoft.com uses and implement a real device-code or auth code + PKCE flow using MSAL or raw. Many first-party web experiences hard-code secrets or are not intended for this. |
| **Cookie-only / hybrid bootstrap** | Medium | Good | Some endpoints work with cookies alone. We already support `MICROSOFT_COPILOT_COOKIE`. Could try to create conversation using only cookies then extract/derive a token, or use cookies + a bootstrap request that returns a fresh short-lived token. |
| **System webview (Electron / Tauri / WKWebView helper)** | High | Good | Ship or recommend a tiny signed macOS helper that uses the system browser engine + keychain, extracts token, and hands it back (clipboard, unix socket, HTTP). Avoids node playwright footprint. |
| **One-time "import from browser" using native cookie access** | High (brittle) | Good | On macOS read Chrome SQLite cookies (encrypted with keychain), Edge, Safari. Very fragile across updates, requires keychain access prompts. |
| **Graph / Entra device login for similar audiences** | Medium | Good | If the user also has M365 Copilot / work account, different token acquisition paths exist (and are more "official"). Separate from consumer copilot.microsoft.com. |
| **Headless + human-in-loop screenshots / guided steps** | Low | Better than today | Even without full auto-extraction, drive a headed browser + use `onProgress` + `page.screenshot()` (if pi supports showing images) + very explicit "click here" guidance. |

## Recommendations / priorities

1. **Shipped changes** already move us from "painful ritual" to "mostly automatic or one-paste".
2. Next best quick wins: CDP attach support + persistent profile flag.
3. For power / enterprise users: companion extension or small Go helper binary.
4. Proper OAuth is the dream but may never be public for the consumer surface.

## Security & trust notes

- Any flow that drives a browser or reads cookies is powerful. The code runs with the user's full permissions.
- We never send tokens anywhere except to the legitimate copilot.microsoft.com endpoints.
- Playwright contexts are isolated by default.
- Users on shared machines or with strict policies should prefer the manual paste or `MICROSOFT_COPILOT_AUTH_MODE=manual`.

## How to test the new flow locally (dev)

```bash
# from the msco-pi-lot dir
npm install
npx playwright install chromium

# run pi against the extension
pi -e ./src/index.ts

# in pi
/login
# then select "Microsoft Copilot" from the OAuth selector
```

Set `MICROSOFT_COPILOT_TRACE=1` + trace file to watch what tokens/headers are sent.

---

Nothing was considered off the table during exploration.
