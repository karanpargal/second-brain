/**
 * Ad-hoc sign the bundled .app so macOS will actually launch it.
 *
 * `tauri build` leaves the bundle linker-signed: a random signing identifier,
 * an unbound Info.plist and no sealed resources. LaunchServices refuses that
 * (`spctl`: "code has no resources but signature indicates they must be
 * present"), so double-clicking the app silently does nothing while running
 * the inner binary from a shell works. TCC also keys the Accessibility grant
 * to the signing identity, so the random identifier could never hold a grant.
 *
 * Re-signing binds Info.plist, seals resources, and gives the bundle its real
 * identifier (com.local.second-brain).
 *
 * No-op off macOS. For distribution, sign with a Developer ID and notarize
 * instead — see scripts/macos-signing.md.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

if (process.platform !== "darwin") {
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(
  ROOT,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
);

if (!existsSync(bundleDir)) {
  console.warn(`[sign-macos] no bundle at ${bundleDir} — skipping`);
  process.exit(0);
}

const apps = readdirSync(bundleDir).filter((n) => n.endsWith(".app"));
if (apps.length === 0) {
  console.warn("[sign-macos] no .app in bundle dir — skipping");
  process.exit(0);
}

for (const app of apps) {
  const appPath = join(bundleDir, app);
  console.log(`[sign-macos] signing ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  execFileSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { stdio: "inherit" },
  );
}

console.log(
  "[sign-macos] done. Ad-hoc signatures change on every rebuild, so macOS " +
    "drops the Accessibility grant each time — re-approve Second Brain in " +
    "System Settings after a rebuild.",
);
