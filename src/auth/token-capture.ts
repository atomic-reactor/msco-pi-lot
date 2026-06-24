import type { OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import os from "node:os";
import path from "node:path";

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
      "Playwright not installed. Run: npm install playwright && npx playwright install msedge (or chromium)"
    );
    return null;
  }

  const { chromium } = playwright;

  const cdpUrl = process.env.MICROSOFT_COPILOT_CDP_URL ||
    (process.env.MICROSOFT_COPILOT_ATTACH_TO_RUNNING_BROWSER ? "http://localhost:9222" : null);

  const usingAttach = !!cdpUrl;

  if (usingAttach) {
    callbacks.onProgress?.("Attach mode requested (CDP). To use the regular Playwright launch instead, unset MICROSOFT_COPILOT_CDP_URL and MICROSOFT_COPILOT_ATTACH_TO_RUNNING_BROWSER.");
  }

  callbacks.onProgress?.(
    usingAttach
      ? "Attaching to your running browser for Microsoft Copilot authentication..."
      : "Launching browser for Microsoft Copilot authentication..."
  );

  // Determine which browser to use.
  // By default we try to launch your real Edge if possible.
  // Set MICROSOFT_COPILOT_BROWSER_CHANNEL=chrome or leave undefined to use bundled Chromium.
  const requestedChannel = process.env.MICROSOFT_COPILOT_BROWSER_CHANNEL || "msedge";
  const useRealProfile = process.env.MICROSOFT_COPILOT_USE_REAL_PROFILE === "1";

  let browser: any;
  let context: any;
  let page: any;
  let isCdpConnection = false;

  const commonArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-default-browser-check"
  ];

  const commonUserAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";

  if (cdpUrl) {
    callbacks.onProgress?.(`Connecting to your running browser at ${cdpUrl}...`);
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      isCdpConnection = true;

      const contexts = browser.contexts();
      // Prefer a context that already has a Copilot page
      let targetContext = contexts.find((c: any) =>
        c.pages().some((p: any) => p.url().includes("copilot.microsoft.com"))
      ) || contexts[0];

      if (!targetContext) {
        targetContext = await browser.newContext();
      }

      // Reuse existing Copilot tab if present (non-destructive)
      const existingCopilotPage = targetContext.pages().find((p: any) =>
        p.url().includes("copilot.microsoft.com")
      );

      if (existingCopilotPage) {
        page = existingCopilotPage;
        callbacks.onProgress?.("Found open Copilot tab in your browser. Attaching listeners...");
      } else {
        page = await targetContext.newPage();
        callbacks.onProgress?.("Opening a new Copilot tab in your running browser...");
      }

      // We deliberately do NOT call onAuth here in attach mode, because pi's
      // reaction to onAuth can open an extra browser/window. We are already
      // controlling a page in the running browser.
      // callbacks.onAuth?.({ url: ..., instructions: ... });
    } catch (err: any) {
      const msg = err?.message || String(err);
      callbacks.onProgress?.(
        `Could not connect to running browser at ${cdpUrl} (${msg}). ` +
        "Falling back to launching a new window. " +
        "Make sure you started Edge/Chrome with: open -a \"Microsoft Edge\" --args --remote-debugging-port=9222"
      );
    }
  }

  if (!page) {
    if (usingAttach) {
      // Attach mode was requested. We either got a page from the running browser above,
      // or the connect failed. In either case, do not auto-launch a fresh browser window.
      // The user explicitly wanted to reuse their existing session.
      callbacks.onProgress?.("Attach-to-running-browser mode active — skipping fresh browser launch.");
      // Return early so we don't fall into any later launch or navigation that could open more.
      return null;
    } else {
      callbacks.onAuth?.({
        url: "https://copilot.microsoft.com",
        instructions:
          "A browser window will open using Microsoft Edge (if available). Sign in if needed. Once the main interface loads, a background request will carry your token."
      });

      callbacks.onProgress?.(
        `Launching ${requestedChannel === "msedge" ? "Microsoft Edge" : requestedChannel || "Chromium"}...`
      );

      const edgeProfilePath = path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Microsoft Edge",
        "Default"
      );

      if (useRealProfile) {
        // Try to reuse your actual Edge profile (cookies, logins, etc.).
        // This only works well if your main Edge is closed.
        callbacks.onProgress?.(`Attempting to reuse your real Edge profile...`);
        try {
          context = await chromium.launchPersistentContext(edgeProfilePath, {
            channel: requestedChannel,
            headless: false,
            args: commonArgs,
          });
          browser = context.browser();
        } catch (err: any) {
          callbacks.onProgress?.(
            `Failed to open real Edge profile (${err?.message || err}). ` +
            `Your main Edge may be running, or permissions are an issue. Falling back to a fresh window.`
          );
        }
      }

      if (!context) {
        // Fresh launch (either by choice or because persistent failed).
        // Using channel 'msedge' will open your installed Microsoft Edge instead of bundled Chromium.
        browser = await chromium.launch({
          headless: false,
          channel: requestedChannel,
          args: commonArgs,
        });
        context = await browser.newContext({
          userAgent: commonUserAgent,
          viewport: { width: 1280, height: 900 }
        });
      }

      page = await context.newPage();
    }
  }

  if (!page) {
    // No page was obtained. This happens in attach mode when connect failed.
    // Return null so loginWithBestEffort falls through to the manual prompt
    // instead of crashing on page.on(...) or navigation.
    return null;
  }

  let capturedToken: string | null = null;
  let resolveCaptured: ((token: string) => void) | null = null;
  const tokenPromise = new Promise<string>((resolve) => {
    resolveCaptured = resolve;
  });

  function setCaptured(tok: string, message: string) {
    if (capturedToken) return;
    capturedToken = cleanToken(tok);
    callbacks.onProgress?.(message);
    if (resolveCaptured) {
      resolveCaptured(capturedToken);
    }
  }

  // Listen for WebSocket connections (primary way the token is used)
  page.on("websocket", (ws) => {
    const url = ws.url();
    if (url.includes("copilot.microsoft.com") && url.includes("accessToken=")) {
      const m = url.match(/[?&]accessToken=([^&]+)/);
      if (m) {
        const tok = decodeURIComponent(m[1]);
        if (tok && tok.length > 20) {
          setCaptured(tok, "Captured access token from WebSocket connection.");
        }
      }
    }
  });

  // Listen to normal requests for Authorization headers.
  // The /c/api/conversations?types=... request is especially useful because it fires
  // automatically on page load once you're signed in (no chat needed).
  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("copilot.microsoft.com")) return;

    const auth = req.headers()["authorization"] || req.headers()["Authorization"];
    if (auth && /^bearer\s+/i.test(auth)) {
      const tok = auth.replace(/^bearer\s+/i, "").trim();
      if (tok.length > 20) {
        const msg = url.includes("/c/api/conversations")
          ? "Captured access token from the conversations list request (automatic on load)."
          : "Captured access token from Authorization header.";
        setCaptured(tok, msg);
      }
    }

    // Sometimes the token shows in the request URL for other calls
    if (url.includes("accessToken=")) {
      const m = url.match(/[?&]accessToken=([^&]+)/);
      if (m) {
        setCaptured(m[1], "Captured access token from request URL.");
      }
    }
  });

  try {
    // Only navigate if we don't already have a loaded Copilot page from an existing tab (CDP mode)
    const alreadyOnCopilot = page.url().includes("copilot.microsoft.com");
    if (!alreadyOnCopilot) {
      callbacks.onProgress?.("Navigating to https://copilot.microsoft.com ...");
      await page.goto("https://copilot.microsoft.com", {
        waitUntil: "domcontentloaded",
        timeout: 45000
      });
    } else {
      callbacks.onProgress?.("Using existing Copilot page. You can interact or refresh the tab to trigger capture if needed.");
    }

    if (!page.url().includes("copilot.microsoft.com")) {
      callbacks.onProgress?.(
        "Waiting for the initial conversations load. When signed in, Copilot automatically requests your conversation list — this is where we grab the Bearer token."
      );
    }

    // Wait for capture (instant via promise when a listener fires) or user action.
    // The conversations list request often provides the token automatically once signed in.
    const start = Date.now();
    const maxWait = 1000 * 60 * 4; // 4 minutes is generous for MFA etc.

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, maxWait);
    });

    await Promise.race([
      tokenPromise,
      timeoutPromise
    ]);

    // Fallback polling only if we haven't captured yet (for the locator hint and abort check)
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
            callbacks.onProgress?.("Chat interface visible. The token is often captured earlier from the automatic conversations list request — waiting...");
          }
        } catch {}
      }

      await page.waitForTimeout(250);
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
    if (!isCdpConnection) {
      try {
        if (context && useRealProfile) {
          await context.close();
        } else if (browser) {
          await browser.close();
        }
      } catch {}
    }
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
    "3. In the filter box type: copilot or conversations or accessToken",
    "4. Just let the page load (or refresh). The key request is GET /c/api/conversations?types=... — it fires automatically and carries the Bearer token.",
    "5. Find that request (or any other /c/api request or the WebSocket).",
    "   - Copy the request URL, or right-click → Copy → Copy as fetch / Copy request headers",
    "6. Come back here and paste the URL, the whole curl/fetch, the header block, or just the raw token.",
    "",
    "We will extract the token automatically from almost anything you paste."
  ].join("\n");

  const raw = await callbacks.onPrompt({
    message: "Paste Microsoft Copilot access token / URL / curl / fetch block (the /conversations request works great):",
    placeholder: "https://copilot.../conversations?types=... or Authorization: Bearer ...",
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
