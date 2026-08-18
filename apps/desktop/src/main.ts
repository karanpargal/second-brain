import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";

const statusEl = document.getElementById("status")!;
const btnPause = document.getElementById("btn-pause")!;
const btnResume = document.getElementById("btn-resume")!;
const btnOpen = document.getElementById("btn-open")!;

async function refreshStatus() {
  try {
    const s = await invoke<{
      capturing: boolean;
      paused_until: string | null;
      last_obs: string | null;
      spool_dir: string;
    }>("capture_status");
    const paused =
      s.paused_until && new Date(s.paused_until).getTime() > Date.now();
    statusEl.className = "status " + (paused ? "bad" : "ok");
    statusEl.textContent = paused
      ? `Paused until ${s.paused_until}`
      : `Capturing · last ${s.last_obs ?? "—"}`;
  } catch (e) {
    statusEl.className = "status bad";
    statusEl.textContent = `Capture status error: ${e}`;
  }
}

btnPause.addEventListener("click", async () => {
  await invoke("pause_capture", { minutes: 60 });
  await refreshStatus();
});

btnResume.addEventListener("click", async () => {
  await invoke("resume_capture");
  await refreshStatus();
});

btnOpen.addEventListener("click", async () => {
  try {
    await open("http://127.0.0.1:5173");
  } catch {
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  }
});

setInterval(() => {
  void refreshStatus();
}, 5000);
void refreshStatus();
