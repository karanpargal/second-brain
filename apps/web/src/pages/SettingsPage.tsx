import { useEffect, useState } from "react";
import { api, type SettingsPayload } from "../lib/api";

export function SettingsPage() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [pattern, setPattern] = useState("");
  const [ruleType, setRuleType] = useState("block_exe");
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    api.settings().then(setData).catch((e) => setMsg(String(e)));
  };

  useEffect(() => {
    load();
  }, []);

  const toggles =
    (data?.settings["capture.toggles"] as {
      window?: boolean;
      browser?: boolean;
      ocr?: boolean;
    }) ?? { window: true, browser: true, ocr: true };

  const setToggle = async (key: "window" | "browser" | "ocr", v: boolean) => {
    const next = { ...toggles, [key]: v };
    await api.patchSetting("capture.toggles", next);
    load();
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Settings</h1>
        <p className="mt-1 text-sm text-ink-400">
          Capture tiers, privacy blocks, pause.
        </p>
      </header>

      {msg && <div className="text-sm text-bad">{msg}</div>}

      <section className="card space-y-3 p-4">
        <h2 className="text-sm font-medium text-ink-200">Capture tiers</h2>
        {(
          [
            ["window", "Foreground window titles"],
            ["browser", "Chrome / Edge history"],
            ["ocr", "Active-window OCR (never saved as image)"],
          ] as const
        ).map(([key, label]) => (
          <label
            key={key}
            className="flex cursor-pointer items-center justify-between text-sm"
          >
            <span className="text-ink-300">{label}</span>
            <input
              type="checkbox"
              checked={!!toggles[key]}
              onChange={(e) => void setToggle(key, e.target.checked)}
            />
          </label>
        ))}
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={async () => {
              const r = await api.pause(60);
              setMsg(`Paused until ${r.paused_until}`);
              load();
            }}
          >
            Pause 1 hour
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={async () => {
              const r = await api.pause(15);
              setMsg(`Paused until ${r.paused_until}`);
              load();
            }}
          >
            Pause 15 min
          </button>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="text-sm font-medium text-ink-200">Blocklist</h2>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!pattern.trim()) return;
            await api.addRule(ruleType, pattern.trim());
            setPattern("");
            load();
          }}
        >
          <select
            className="input w-auto"
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value)}
          >
            <option value="block_exe">block exe</option>
            <option value="block_domain">block domain</option>
          </select>
          <input
            className="input flex-1"
            placeholder="1Password.exe or banking.example.com"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
          <button type="submit" className="btn-primary">
            Add
          </button>
        </form>
        <ul className="space-y-1 text-sm">
          {(data?.rules ?? []).map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between rounded-lg border border-white/5 px-3 py-2"
            >
              <span>
                <span className="badge mr-2 bg-white/10 text-ink-400">
                  {r.ruleType}
                </span>
                <span className="font-mono text-ink-200">{r.pattern}</span>
              </span>
              <button
                type="button"
                className="btn-danger text-xs"
                onClick={async () => {
                  await api.deleteRule(r.id);
                  load();
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
