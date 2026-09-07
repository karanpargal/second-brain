/**
 * Distro-aware `tauri build` for Linux.
 *
 * tauri's AppImage path shells out to linuxdeploy, whose bundled binutils
 * cannot strip Arch's DT_RELR binaries and whose GTK plugin assumes
 * gdk-pixbuf loaders at pkg-config paths that Arch no longer ships — so a
 * plain `tauri build` (targets "all") always fails on Arch-based distros.
 * Arch users are served natively via packaging/arch/PKGBUILD instead, and
 * CI builds the AppImage on Ubuntu where the toolchain works.
 *
 * Usage: node scripts/build-desktop.mjs [extra tauri args...]
 *   - Linux + Arch-based (/etc/os-release ID/ID_LIKE ~ arch): --bundles deb,rpm
 *   - Linux otherwise: default targets (deb, rpm, appimage)
 *   - Other OSes: default targets, untouched.
 * Explicit --bundles from the caller always wins.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);

function isArchLinux() {
  if (process.platform !== "linux") return false;
  try {
    const os = readFileSync("/etc/os-release", "utf8");
    const get = (k) => (os.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").toLowerCase().replace(/["']/g, "");
    const id = get("ID");
    const like = get("ID_LIKE").split(/\s+/);
    return id === "arch" || like.includes("arch");
  } catch {
    return false;
  }
}

const finalArgs = [...args];
const hasBundles = args.some(
  (a) => a === "--bundles" || a.startsWith("--bundles="),
);
if (process.platform === "linux" && isArchLinux() && !hasBundles) {
  finalArgs.push("--bundles", "deb,rpm");
  console.log("[build-desktop] Arch-based distro: bundling deb+rpm (AppImage needs an Ubuntu build host; Arch installs via packaging/arch/PKGBUILD)");
}

const r = spawnSync("npm", ["run", "tauri", "build", "-w", "@second-brain/desktop", "--", ...finalArgs], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
