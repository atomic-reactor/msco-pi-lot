import type { OAuthLoginCallbacks } from "@mariozechner/pi-ai";

/**
 * Extracts a Microsoft Copilot access token from a wide variety of user-provided inputs.
 * Supports:
 * - Raw token
 * - "Bearer xxx" or "Authorization: Bearer xxx"
 * - Full wss://... or https://... URLs containing accessToken=...
 * - cURL commands (curl -H 'Authorization: ...' or url with ?accessToken)
 * - "copy as fetch" snippets
 * - JSON blobs with accessToken / token fields
 * - Headers blocks
 */
function cleanToken(t: string): string {
  if (!t) return "";
  return t
    .trim()
    .replace(/^['"`]|['"`]$/g, "")
    .replace(/^bearer\s+/i, "")
    .replace(/^authorization\s*:\s*/i, "")
    .trim();
}

export function extractAccessToken(input: string | undefined): string {
  if (!input) return "";

  const trimmed = input.trim();
  if (!trimmed) return "";

  // 1. Try to find accessToken= in any URL-like string (WS urls, request urls, etc)
  const urlMatch = trimmed.match(/[?&]accessToken=([^&\s"'`>)]+)/i);
  if (urlMatch) {
    return cleanToken(decodeURIComponent(urlMatch[1]));
  }

  // 2. Try Authorization: Bearer ... anywhere
  const authMatch = trimmed.match(/authorization\s*:\s*bearer\s+([^\s"'`>)]+)/i);
  if (authMatch) {
    return cleanToken(authMatch[1]);
  }

  // 3. Raw "Bearer xxx" prefix
  const bearerMatch = trimmed.match(/^bearer\s+([^\s"'`>)]+)/i);
  if (bearerMatch) {
    return cleanToken(bearerMatch[1]);
  }

  // 4. Try to parse as JSON and look for common fields
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      const candidates = [
        parsed?.accessToken,
        parsed?.access_token,
        parsed?.token,
        parsed?.authorization?.replace(/^bearer\s+/i, ""),
        parsed?.headers?.authorization?.replace(/^bearer\s+/i, ""),
        parsed?.headers?.Authorization?.replace(/^bearer\s+/i, ""),
      ].filter(Boolean);
      if (candidates.length > 0) {
        return cleanToken(String(candidates[0]));
      }
      if (parsed?.url) {
        const m = String(parsed.url).match(/[?&]accessToken=([^&]+)/i);
        if (m) return cleanToken(decodeURIComponent(m[1]));
      }
    } catch {
      // not json, fall through
    }
  }

  // 5. cURL style -H 'Authorization: Bearer xxx'
  const curlAuth = trimmed.match(/-H\s+['"](?:authorization|Authorization):\s*Bearer\s+([^'"\s]+)/i);
  if (curlAuth) {
    return cleanToken(curlAuth[1]);
  }

  // 6. fetch('https://...accessToken=...
  const fetchUrlMatch = trimmed.match(/fetch\s*\(\s*['"`]([^'"`]*accessToken=[^'"`]*)/i);
  if (fetchUrlMatch) {
    const m = fetchUrlMatch[1].match(/[?&]accessToken=([^&'"]+)/i);
    if (m) return cleanToken(decodeURIComponent(m[1]));
  }

  // 7. Last resort: if the input after cleaning is non-empty, treat it as the token.
  // (We are permissive here because the user explicitly pasted something in /login.
  // Real tokens are long; tests and simple usage may use short placeholders.)
  const cleaned = cleanToken(trimmed);
  if (cleaned.length > 0) {
    return cleaned;
  }

  return "";
}

/** Current callbacks shape used by pi for login */
export interface LoginCallbacks extends OAuthLoginCallbacks {
  onProgress?: (message: string) => void;
  onDeviceCode?: (info: { userCode: string; verificationUri: string }) => void;
  signal?: AbortSignal;
}

/**
 * Attempt to capture a live access token by driving a browser session.
 * Returns the token string or null if not possible / cancelled.
 *
 * This is the "magic" path. Requires `playwright` to be installed.
 */
export async function attemptBrowserTokenCapture(callbacks: LoginCallbacks): Promise<string | null> {
  // Fast exit in test / CI or when user explicitly wants the old manual flow
  const mode = (process.env.MICROSOFT_COPILOT_AUTH_MODE || "").toLowerCase();
  if (mode === "manual" || mode === "prompt") return null;

  if (process.env.VITEST || process.env.NODE_ENV === "test" || process.env.CI === "true") {
    return null;
  }

  let playwright: any;
  try {
    playwright = await import("playwright");
  } catch (err: any) {
    callbacks.onProgress?.(
      "Playwright not installed. For automatic login run: npm install playwright && npx playwright install chromium"
    );
    return null;
  }

  const { chromium } = playwright;

  callbacks.onProgress?.("Launching browser for Microsoft Copilot authentication...");
  callbacks.onAuth?.({
    url: "https://copilot.microsoft.com",
    instructions:
      "A browser window will open (or is opening). Sign in to Microsoft Copilot if needed, then open or start a chat. The token will be captured automatically."
  });

  const browser = await chromium.launch({
    headless: false, // Headed so user can complete login / 2FA / consent
    channel: undefined, // default bundled chromium; user can have chrome too
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-default-browser-check"
    ]
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    viewport: { width: 1280, height: 900 }
  });

  const page = await context.newPage();

  let capturedToken: string | null = null;

  // Listen for WebSocket connections (primary way the token is used)
  page.on("websocket", (ws) => {
    const url = ws.url();
    if (url.includes("copilot.microsoft.com") && url.includes("accessToken=")) {
      const m = url.match(/[?&]accessToken=([^&]+)/);
      if (m) {
        const tok = decodeURIComponent(m[1]);
        if (tok && tok.length > 20) {
          capturedToken = cleanToken(tok);
          callbacks.onProgress?.("Captured access token from WebSocket connection.");
        }
      }
    }
  });

  // Also listen to normal requests for Authorization headers (conversation create, config)
  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("copilot.microsoft.com")) return;

    const auth = req.headers()["authorization"] || req.headers()["Authorization"];
    if (auth && /^bearer\s+/i.test(auth)) {
      const tok = auth.replace(/^bearer\s+/i, "").trim();
      if (tok.length > 20) {
        capturedToken = cleanToken(tok);
        callbacks.onProgress?.("Captured access token from Authorization header.");
      }
    }

    // Sometimes the token shows in the request URL for other calls
    if (url.includes("accessToken=")) {
      const m = url.match(/[?&]accessToken=([^&]+)/);
      if (m) {
        capturedToken = cleanToken(decodeURIComponent(m[1]));
        callbacks.onProgress?.("Captured access token from request URL.");
      }
    }
  });

  try {
    callbacks.onProgress?.("Navigating to https://copilot.microsoft.com ...");
    await page.goto("https://copilot.microsoft.com", {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    callbacks.onProgress?.(
      "Waiting for you to sign in (if required) and start a chat. Token will be captured from the live session."
    );

    // Poll for capture or user action. Give generous time for login + first interaction.
    const start = Date.now();
    const maxWait = 1000 * 60 * 4; // 4 minutes is generous for MFA etc.

    while (!capturedToken && Date.now() - start < maxWait) {
      if (callbacks.signal?.aborted) break;

      // Heuristic: if the chat input area is visible, nudge the user once
      if ((Date.now() - start) > 8000) {
        try {
          const hasChat = await page
            .locator('textarea, [contenteditable="true"], input[placeholder*="Ask"]')
            .first()
            .isVisible({ timeout: 500 })
            .catch(() => false);
          if (hasChat && !capturedToken) {
            callbacks.onProgress?.("Chat interface detected. Send a test message or just wait — background connections often reveal the token.");
          }
        } catch {}
      }

      await page.waitForTimeout(800);
    }

    if (capturedToken) {
      callbacks.onProgress?.("Token captured successfully! Closing helper browser...");
    } else {
      callbacks.onProgress?.("Did not auto-detect token yet. You can paste one manually.");
    }
  } catch (err: any) {
    callbacks.onProgress?.(`Browser capture encountered an issue: ${err?.message || err}`);
  } finally {
    // Give a moment for final events
    await new Promise((r) => setTimeout(r, 300));
    await browser.close().catch(() => {});
  }

  return capturedToken ? cleanToken(capturedToken) : null;
}

/**
 * Full featured login suitable for use as the oauth.login implementation.
 * Tries browser capture first when possible, falls back to prompt.
 */
export async function loginWithBestEffort(callbacks: LoginCallbacks): Promise<OAuthCredentials> {
  const NON_REFRESHING_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 365 * 10;

  callbacks.onProgress?.("Starting Microsoft Copilot login...");

  // Fast path: user may have pre-set an env var we can read as convenience
  const envToken = process.env.MICROSOFT_COPILOT_ACCESS_TOKEN || process.env.COPILOT_ACCESS_TOKEN;
  if (envToken) {
    const extracted = extractAccessToken(envToken);
    if (extracted) {
      callbacks.onProgress?.("Using MICROSOFT_COPILOT_ACCESS_TOKEN from environment.");
      const tok = extracted;
      return {
        access: tok,
        refresh: tok,
        expires: Date.now() + NON_REFRESHING_TOKEN_TTL_MS
      };
    }
  }

  // Attempt automated browser capture
  const browserToken = await attemptBrowserTokenCapture(callbacks);
  if (browserToken) {
    return {
      access: browserToken,
      refresh: browserToken,
      expires: Date.now() + NON_REFRESHING_TOKEN_TTL_MS
    };
  }

  // Manual / fallback path with excellent instructions
  callbacks.onProgress?.("Falling back to manual token entry.");
  const instructions = [
    "How to get your token (easiest ways):",
    "",
    "1. In your browser go to https://copilot.microsoft.com and make sure you're signed in.",
    "2. Open DevTools (F12) → Network tab.",
    "3. In the filter box type: copilot or chat or accessToken",
    "4. Start or continue a chat.",
    "5. Find a request to /c/api/... or the WebSocket (wss://copilot.microsoft.com/...)",
    "   - Copy the request URL (it will contain accessToken=...)",
    "   - OR right-click → Copy → Copy as fetch / Copy request headers",
    "6. Come back here and paste the URL, the whole curl/fetch, the header, or just the raw token.",
    "",
    "You can also paste a full copied network request. We will extract the token automatically."
  ].join("\n");

  const raw = await callbacks.onPrompt({
    message: "Paste Microsoft Copilot access token / URL / curl / fetch block:",
    placeholder: "https://copilot...accessToken=... or Bearer ... or raw token",
    allowEmpty: false
  });

  const token = extractAccessToken(raw);
  if (!token) {
    // Last desperate attempt: maybe they pasted something that normalize would have caught
    const fallback = cleanToken(raw || "");
    if (fallback.length < 15) {
      throw new Error("No valid access token found in the provided input. Please try again or paste the full request URL.");
    }
    return {
      access: fallback,
      refresh: fallback,
      expires: Date.now() + NON_REFRESHING_TOKEN_TTL_MS
    };
  }

  return {
    access: token,
    refresh: token,
    expires: Date.now() + NON_REFRESHING_TOKEN_TTL_MS
  };
}
