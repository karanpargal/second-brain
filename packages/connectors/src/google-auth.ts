import http from "node:http";
import { URL } from "node:url";
import { google } from "googleapis";
import {
  config,
  getSecret,
  setSecret,
  log,
} from "@second-brain/core";

const TOKEN_KEY = "google_tokens";

export type GoogleTokens = {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string;
  token_type?: string | null;
  expiry_date?: number | null;
};

export function createOAuthClient() {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required. See .env.example",
    );
  }
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

export function getStoredTokens(): GoogleTokens | null {
  const raw = getSecret(TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GoogleTokens;
  } catch {
    return null;
  }
}

export function storeTokens(tokens: GoogleTokens): void {
  const prev = getStoredTokens() ?? {};
  // always keep existing refresh_token if new response omits it
  setSecret(
    TOKEN_KEY,
    JSON.stringify({
      ...prev,
      ...tokens,
      refresh_token: tokens.refresh_token ?? prev.refresh_token,
    }),
  );
}

export async function getAuthedClient() {
  const client = createOAuthClient();
  const tokens = getStoredTokens();
  if (!tokens?.refresh_token && !tokens?.access_token) {
    throw new Error(
      "Google is not connected. Use Connect Gmail / Calendar in the widget.",
    );
  }
  client.setCredentials(tokens);
  client.on("tokens", (t) => {
    storeTokens(t as GoogleTokens);
  });
  return client;
}

/**
 * Interactive localhost OAuth (read-only scopes).
 * Note: apps in Google Cloud "testing" mode may expire refresh tokens every 7 days.
 * Add yourself as a test user and re-auth when needed; publishing the app removes that limit.
 */
export async function runGoogleAuthFlow(): Promise<void> {
  const client = createOAuthClient();
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...config.google.scopes],
  });

  const redirect = new URL(config.google.redirectUri);
  const port = Number(redirect.port || 3456);
  const path = redirect.pathname || "/oauth/callback";

  log.info("Open this URL in your browser to authorize Google (read-only):");
  console.log("\n" + authUrl + "\n");

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        if (!req.url) return;
        const u = new URL(req.url, `http://127.0.0.1:${port}`);
        if (u.pathname !== path) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const err = u.searchParams.get("error");
        if (err) {
          res.writeHead(400);
          res.end(`Auth error: ${err}`);
          reject(new Error(err));
          server.close();
          return;
        }
        const c = u.searchParams.get("code");
        if (!c) {
          res.writeHead(400);
          res.end("Missing code");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Google connected</h1><p>You can close this tab and return to Second Brain.</p>",
        );
        resolve(c);
        server.close();
      } catch (e) {
        reject(e);
        server.close();
      }
    });
    server.listen(port, "127.0.0.1");
    // try open browser
    import("node:child_process").then(({ exec }) => {
      const cmd =
        process.platform === "win32"
          ? `start "" "${authUrl}"`
          : process.platform === "darwin"
            ? `open "${authUrl}"`
            : `xdg-open "${authUrl}"`;
      exec(cmd);
    });
  });

  const { tokens } = await client.getToken(code);
  storeTokens(tokens as GoogleTokens);
  log.info("Google OAuth tokens stored (encrypted)");
  log.warn(
    "If the Google Cloud OAuth app is in Testing mode, refresh tokens may expire every 7 days — reconnect Gmail from the widget.",
  );
}

export async function googleStatus(): Promise<{
  connected: boolean;
  hasRefresh: boolean;
  expiry?: number | null;
}> {
  const t = getStoredTokens();
  return {
    connected: Boolean(t?.access_token || t?.refresh_token),
    hasRefresh: Boolean(t?.refresh_token),
    expiry: t?.expiry_date,
  };
}
