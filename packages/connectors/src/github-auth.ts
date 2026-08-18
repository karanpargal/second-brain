import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { config, getSecret, setSecret, deleteSecret, log } from "@second-brain/core";

const execFileAsync = promisify(execFile);
const SECRET_KEY = "github_token";

function findGhBinary(): string {
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const local = process.env["LOCALAPPDATA"] ?? "";
    const candidates = [
      `${pf}\\GitHub CLI\\gh.exe`,
      `${local}\\Programs\\GitHub CLI\\gh.exe`,
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }
  return "gh";
}

/** Resolve a GitHub token without requiring it in .env */
export function resolveGithubToken(): string | undefined {
  const fromEnv = (config.github.token || process.env.GITHUB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const fromSecret = getSecret(SECRET_KEY)?.trim();
  if (fromSecret) return fromSecret;
  return undefined;
}

export async function tryLoadGhCliToken(): Promise<string | null> {
  const gh = findGhBinary();
  try {
    const { stdout } = await execFileAsync(gh, ["auth", "token"], {
      windowsHide: true,
      timeout: 15_000,
      env: process.env,
    });
    const token = stdout.trim();
    if (token && token.length > 10) {
      setSecret(SECRET_KEY, token);
      (config.github as { token: string }).token = token;
      log.info("GitHub token loaded from gh CLI (stored encrypted)");
      return token;
    }
  } catch {
    /* gh missing or not logged in */
  }
  return null;
}

export async function githubStatus(): Promise<{
  connected: boolean;
  source: "env" | "secret" | "gh" | "none";
  ghInstalled: boolean;
}> {
  const envTok = (process.env.GITHUB_TOKEN || "").trim();
  if (envTok) {
    return { connected: true, source: "env", ghInstalled: await isGhInstalled() };
  }
  if (getSecret(SECRET_KEY)?.trim()) {
    return { connected: true, source: "secret", ghInstalled: await isGhInstalled() };
  }
  const ghTok = await tryLoadGhCliToken();
  if (ghTok) {
    return { connected: true, source: "gh", ghInstalled: true };
  }
  return { connected: false, source: "none", ghInstalled: await isGhInstalled() };
}

async function isGhInstalled(): Promise<boolean> {
  const gh = findGhBinary();
  try {
    await execFileAsync(gh, ["--version"], { windowsHide: true, timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open GitHub CLI browser login (`gh auth login -w`).
 * No PAT paste — user authorizes in the browser.
 */
export async function runGithubGhAuthLogin(): Promise<{
  ok: boolean;
  message: string;
  needsInstall?: boolean;
  commands?: string[];
}> {
  const gh = findGhBinary();
  if (!(await isGhInstalled())) {
    return {
      ok: false,
      needsInstall: true,
      message: "GitHub CLI is not installed. Install it from https://cli.github.com then Connect GitHub again.",
      commands: [],
    };
  }

  try {
    await execFileAsync(
      gh,
      [
        "auth",
        "login",
        "-h",
        "github.com",
        "-p",
        "https",
        "-w",
        "-s",
        "notifications,read:user,repo",
      ],
      {
        windowsHide: true,
        timeout: 300_000,
        env: process.env,
      },
    );
  } catch (e) {
    log.warn("gh auth login finished with status", {
      err: e instanceof Error ? e.message : String(e),
    });
  }

  const token = await tryLoadGhCliToken();
  if (token) {
    return { ok: true, message: "GitHub connected via gh CLI" };
  }
  return {
    ok: false,
    message:
      "Browser login did not finish. Click Connect GitHub again and authorize in the browser.",
    commands: [],
  };
}

/** Attempt silent winget install of GitHub CLI (Windows). */
export async function installGithubCli(): Promise<{
  ok: boolean;
  message: string;
  commands?: string[];
}> {
  if (await isGhInstalled()) {
    return { ok: true, message: "GitHub CLI is already installed." };
  }
  if (process.platform !== "win32") {
    return {
      ok: false,
      message: "Install GitHub CLI from https://cli.github.com then reconnect.",
      commands: ["brew install gh", "gh auth login -w"],
    };
  }
  try {
    await execFileAsync(
      "winget",
      ["install", "--id", "GitHub.cli", "-e", "--accept-package-agreements", "--accept-source-agreements"],
      { windowsHide: true, timeout: 600_000, env: process.env },
    );
  } catch (e) {
    return {
      ok: false,
      message:
        "Automatic install failed. Run this in PowerShell (Admin if needed), then reconnect:",
      commands: [
        "winget install --id GitHub.cli -e",
        "gh auth login -h github.com -p https -w",
      ],
    };
  }
  if (await isGhInstalled()) {
    return {
      ok: true,
      message: "GitHub CLI installed. Click Connect GitHub to sign in.",
    };
  }
  return {
    ok: false,
    message: "Install may need a new terminal. Close and reopen the app, then:",
    commands: [
      "winget install --id GitHub.cli -e",
      "gh auth login -h github.com -p https -w",
    ],
  };
}

export function clearGithubToken(): void {
  deleteSecret(SECRET_KEY);
  (config.github as { token: string }).token = "";
}
