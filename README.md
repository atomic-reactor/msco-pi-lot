# msco-pi-lot

Microsoft Copilot provider extension for `pi`.

<img width="1094" height="1200" alt="image" src="https://github.com/user-attachments/assets/fb12fb42-bc43-4e18-b77d-4f1d27ababe1" />
<img width="1441" height="1187" alt="Screenshot 2026-03-23 152210" src="https://github.com/user-attachments/assets/3b6b7552-74b7-4931-bf39-9b3c83dbff74" />



## Install

Install directly from GitHub:

```bash
pi install https://github.com/atomic-reactor/msco-pi-lot
```

You can also pin a ref:

```bash
pi install https://github.com/atomic-reactor/msco-pi-lot@main
```

After install, restart `pi` and select the `microsoft-copilot/copilot` model.

For interactive use, log in once from inside `pi`:

```text
/login microsoft-copilot
```

**New improved experience**:

- The login flow will attempt to **automatically capture** your token by launching a browser and sniffing the live session (requires `playwright`).
- If Playwright is not installed it falls back gracefully.
- You can paste **almost anything**: raw token, `Bearer xxx`, full `wss://...accessToken=...` URL, cURL command, `fetch(...)` snippet, or a JSON payload. It extracts the token for you.

After login `pi` stores the credential in `~/.pi/agent/auth.json`. Remove it with:

```text
/logout microsoft-copilot
```

To enable the automatic browser capture (recommended):

```bash
# after pi install
npm install playwright   # (or it may be pulled via optionalDependencies)
npx playwright install chromium
```

Then just `/login microsoft-copilot`. A browser window appears — complete sign-in and use Copilot briefly. The token is captured automatically from live connections.

Force the old paste-only flow:

```bash
MICROSOFT_COPILOT_AUTH_MODE=manual pi ...
# or export it
```

## Configuration

The best way is `/login microsoft-copilot` (see above).

For headless or non-interactive/CI use, set credentials via env or `.env`:

```dotenv
MICROSOFT_COPILOT_ACCESS_TOKEN=
MICROSOFT_COPILOT_COOKIE=
MICROSOFT_COPILOT_CONVERSATION_ID=
MICROSOFT_COPILOT_CLIENT_SESSION_ID=
MICROSOFT_COPILOT_MODE=reasoning
MICROSOFT_COPILOT_TRACE=0
MICROSOFT_COPILOT_TRACE_FILE=logs/copilot-session.ndjson
```

Legacy `COPILOT_*` names are accepted.

Only the access token is required for auth. Cookies are optional transport enhancements.

## Behavior

- Registers one `pi` model: `microsoft-copilot/copilot`
- Maps `pi` thinking levels to Copilot modes:
  - `off`, `minimal`, `low` -> `smart`
  - `medium`, `high`, `xhigh` -> `reasoning`
- Bootstraps a Copilot conversation over HTTP when needed
- Persists conversation state per `pi` session
- Supports local tool use through a prompt-mediated tool loop
- Uses Copilot server config to size prompts conservatively against the live `maxTextMessageLength`

## Known Issues

- This is still a basic integration. It gets Microsoft Copilot working inside `pi`, but it is not yet on par with a full agentic coding agent.
- Microsoft Copilot will sometimes fail to respond at all. In those cases the request may stall or end without a useful answer, and retrying is often the only workaround.
- Microsoft Copilot will sometimes behave as if it is running in a browser context. When that happens it may try to inspect browser tabs or page state that do not exist in `pi`, which can cause the response to stall or go off track.

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

For local extension loading during development:

```bash
pi -e ./src/index.ts
```

## Tracing

Enable websocket and bootstrap tracing with:

```dotenv
MICROSOFT_COPILOT_TRACE=1
MICROSOFT_COPILOT_TRACE_FILE=logs/copilot-session.ndjson
```

Trace output is masked, but you should still treat it as sensitive and keep it out of git.

## Bookmarklet for manual token copy (no Playwright)

If you prefer not to use the automated flow, drag this to your bookmarks bar and click it while on https://copilot.microsoft.com (after signing in and sending a chat message):

```js
javascript:(function(){try{const u=new URL(location.href);let t=u.searchParams.get('accessToken');if(!t){const m=performance.getEntries().map(e=>e.name).join(' ').match(/accessToken=([^&]+)/);if(m)t=decodeURIComponent(m[1]);} if(!t){for(let k of Object.keys(localStorage)){if(/token|auth/i.test(k)){t=localStorage[k];break;}}} if(t){prompt('Token (copied to clipboard too):',t);navigator.clipboard.writeText(t);}else{alert('Could not auto-detect. Use DevTools Network -> look for accessToken in WS or Authorization header.');}}catch(e){alert('Error: '+e);}})();
```

(Bookmarklets are one of many options — the playwright flow is strongly preferred.)
