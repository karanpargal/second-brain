/**
 * Single entry: start core, then floating desktop widget (not browser).
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const require = createRequire(join(ROOT, "package.json"));

function loadEnvPort() {
  const envPath = join(ROOT, ".env");
  let port = 3000;
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*PORT\s*=\s*(.+)\s*$/);
      if (m) {
        port = Number(String(m[1]).replace(/['"]/g, "").trim()) || 3000;
      }
    }
  }
  return port;
}

const PORT = Number(process.env.PORT ?? loadEnvPort());
const HOST = process.env.HOST ?? "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
function defaultDataDir() {
  if (process.env.BRAIN_DATA_DIR) return process.env.BRAIN_DATA_DIR;
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "second-brain",
    );
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "second-brain");
  }
  return join(homedir(), ".local", "share", "second-brain");
}

const PID_FILE = join(defaultDataDir(), "core.pid");

async function health() {
  try {
    const res = await fetch(`${BASE}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function resolveNode() {
  return process.execPath;
}

function resolveTsx() {
  try {
    return require.resolve("tsx/cli");
  } catch {
    return join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  }
}

function startCore() {
  const tsx = resolveTsx();
  const cli = join(ROOT, "packages", "worker", "src", "cli.ts");
  const child = spawn(resolveNode(), [tsx, cli, "daemon"], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, PORT: String(PORT), HOST },
  });
  child.unref();
  try {
    writeFileSync(PID_FILE, String(child.pid ?? ""));
  } catch {
    /* */
  }
  return child.pid;
}

function findDesktopExe() {
  const names =
    process.platform === "darwin"
      ? [
          "Second Brain.app/Contents/MacOS/second-brain-desktop",
          "second-brain-desktop",
        ]
      : process.platform === "win32"
        ? ["second-brain-desktop.exe", "Second Brain.exe"]
        : ["second-brain-desktop"];
  const dirs = [
    join(ROOT, "apps", "desktop", "src-tauri", "target", "release"),
    join(ROOT, "apps", "desktop", "src-tauri", "target", "release", "bundle", "macos"),
    join(ROOT, "apps", "desktop", "src-tauri", "target", "debug"),
    process.env.CARGO_TARGET_DIR
      ? join(process.env.CARGO_TARGET_DIR, "release")
      : null,
    process.env.CARGO_TARGET_DIR
      ? join(process.env.CARGO_TARGET_DIR, "debug")
      : null,
  ].filter(Boolean);

  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function startDesktopWidget() {
  const exe = findDesktopExe();
  if (exe) {
    const child = spawn(exe, [], {
      cwd: dirname(exe),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { mode: "exe", path: exe };
  }

  const cargoToml = join(ROOT, "apps", "desktop", "src-tauri", "Cargo.toml");
  if (existsSync(cargoToml)) {
    const targetDir = join(ROOT, "apps", "desktop", "src-tauri", "target");
    const child = spawn(
      "cargo",
      ["run", "--manifest-path", cargoToml],
      {
        cwd: join(ROOT, "apps", "desktop", "src-tauri"),
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: targetDir,
        },
      },
    );
    child.unref();
    return { mode: "cargo", path: cargoToml };
  }

  return null;
}

async function waitForHealthy(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h = await health();
    if (h?.ok) return h;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

function openUrl(url) {
  const { exec } = require("node:child_process");
  if (process.platform === "win32") {
    exec(`start "" "${url}"`, { windowsHide: true });
  } else if (process.platform === "darwin") {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

function webUiStale() {
  const distIndex = join(ROOT, "apps", "web", "dist", "index.html");
  const srcDir = join(ROOT, "apps", "web", "src");
  if (!existsSync(distIndex)) return true;
  if (!existsSync(srcDir)) return false;
  const newest = (dir) => {
    let m = 0;
    const walk = (d) => {
      let entries;
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name === "node_modules" || name === "dist") continue;
        const p = join(d, name);
        try {
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else if (st.mtimeMs > m) m = st.mtimeMs;
        } catch {
          /* */
        }
      }
    };
    walk(dir);
    return m;
  };
  return newest(srcDir) > newest(join(ROOT, "apps", "web", "dist")) + 500;
}

async function ensureWebUi() {
  if (!webUiStale()) return;
  console.warn("[second-brain] building UI (source newer than dist)…");
  const build = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "-w", "@second-brain/web"],
    { cwd: ROOT, stdio: "inherit", shell: true },
  );
  await new Promise((resolve) => {
    build.on("exit", () => resolve());
  });
}

async function main() {
  process.chdir(ROOT);

  let h = await health();
  if (!h?.ok) {
    console.log(`[second-brain] starting core on ${BASE}…`);
    startCore();
    h = await waitForHealthy(120_000);
    if (!h?.ok) {
      console.error("[second-brain] core failed to start");
      process.exit(1);
    }
  } else {
    console.log(`[second-brain] core already running`);
  }

  // Daemon also rebuilds on boot; this covers already-running cores + missing dist.
  await ensureWebUi();

  const desktop = startDesktopWidget();
  if (desktop) {
    console.log(
      `[second-brain] floating widget starting (${desktop.mode})`,
    );
    console.log("  Tip: Ctrl+Shift+Space toggles the widget");
  } else {
    console.warn(
      "[second-brain] desktop widget not available — falling back to browser /widget",
    );
    openUrl(`${BASE}/widget`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
