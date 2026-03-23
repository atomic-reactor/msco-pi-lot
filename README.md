# msco-pi-lot

Microsoft Copilot provider extension for `pi`.

<img width="1094" height="1200" alt="image" src="https://github.com/user-attachments/assets/fb12fb42-bc43-4e18-b77d-4f1d27ababe1" />


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

Paste your Microsoft Copilot access token when prompted. `pi` stores the credential in `~/.pi/agent/auth.json`. You can remove it later with:

```text
/logout microsoft-copilot
```

## Configuration

Interactive login only supports pasting an access token. For headless or non-interactive use, you can still set Copilot credentials in your shell or in a local `.env` file next to the installed package:

```dotenv
MICROSOFT_COPILOT_ACCESS_TOKEN=
MICROSOFT_COPILOT_COOKIE=
MICROSOFT_COPILOT_CONVERSATION_ID=
MICROSOFT_COPILOT_CLIENT_SESSION_ID=
MICROSOFT_COPILOT_MODE=reasoning
MICROSOFT_COPILOT_TRACE=0
MICROSOFT_COPILOT_TRACE_FILE=logs/copilot-session.ndjson
```

Legacy `COPILOT_*` variable names are still accepted.

Only `MICROSOFT_COPILOT_ACCESS_TOKEN` is required. Cookie-based settings remain optional transport tweaks, not a login method.

## Behavior

- Registers one `pi` model: `microsoft-copilot/copilot`
- Maps `pi` thinking levels to Copilot modes:
  - `off`, `minimal`, `low` -> `smart`
  - `medium`, `high`, `xhigh` -> `reasoning`
- Bootstraps a Copilot conversation over HTTP when needed
- Persists conversation state per `pi` session
- Supports local tool use through a prompt-mediated tool loop
- Uses Copilot server config to size prompts conservatively against the live `maxTextMessageLength`

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
