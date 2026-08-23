/**
 * Rebuild the SPA when source is newer than dist (or dist is missing).
 * Runs on daemon boot so the Tauri one-click path never ships a stale UI.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { config, log } from "@second-brain/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");
const WEB_SRC = join(REPO_ROOT, "apps", "web", "src");
const WEB_ROOT = join(REPO_ROOT, "apps", "web");

function newestMtime(root: string, filter?: (name: string) => boolean): number {
  if (!existsSync(root)) return 0;
  let newest = 0;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name === ".git") continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
      } else if (!filter || filter(name)) {
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  };
  walk(root);
  return newest;
}

function configMtime(): number {
  let m = 0;
  for (const f of [
    "index.html",
    "vite.config.ts",
    "vite.config.js",
    "tailwind.config.js",
    "tailwind.config.ts",
    "postcss.config.js",
    "tsconfig.json",
    "package.json",
  ]) {
    const p = join(WEB_ROOT, f);
    if (!existsSync(p)) continue;
    try {
      const t = statSync(p).mtimeMs;
      if (t > m) m = t;
    } catch {
      /* */
    }
  }
  return m;
}

export function webBuildIsStale(): boolean {
  const indexHtml = join(config.webDist, "index.html");
  if (!existsSync(indexHtml)) return true;
  if (!existsSync(WEB_SRC)) return false; // packaged install — no sources
  const srcNewest = Math.max(newestMtime(WEB_SRC), configMtime());
  const distNewest = newestMtime(config.webDist, (n) =>
    /\.(js|css|html|svg|woff2?)$/i.test(n),
  );
  return srcNewest > distNewest + 500; // 500ms skew tolerance
}

export async function ensureWebBuild(): Promise<{ built: boolean; skipped: boolean }> {
  if (process.env.BRAIN_SKIP_WEB_BUILD === "1") {
    return { built: false, skipped: true };
  }
  if (!existsSync(WEB_SRC)) {
    return { built: false, skipped: true };
  }
  if (!webBuildIsStale()) {
    return { built: false, skipped: false };
  }

  log.info("Web UI source newer than dist — rebuilding…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const code = await new Promise<number>((resolve) => {
    const child = spawn(npm, ["run", "build", "-w", "@second-brain/web"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: true,
      env: { ...process.env },
    });
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  if (code !== 0) {
    log.warn("Web UI rebuild failed", { code });
    return { built: false, skipped: false };
  }
  log.info("Web UI rebuild complete");
  return { built: true, skipped: false };
}
