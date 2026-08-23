import { useEffect, useState } from "react";
import { api, type SettingsPayload } from "../lib/api";

type McpServerRow = {
  id: string;
  label: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  secretKeys?: string[];
};

export function SettingsPage() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [pattern, setPattern] = useState("");
  const [ruleType, setRuleType] = useState("block_exe");
  const [msg, setMsg] = useState<string | null>(null);
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [cartesiaKey, setCartesiaKey] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);

  const [hosted, setHosted] = useState({
    url: "",
    model: "gpt-4o-mini",
    useForAsk: false,
    configured: false,
    fromEnv: false,
  });
  const [hostedUrl, setHostedUrl] = useState("");
  const [hostedModel, setHostedModel] = useState("gpt-4o-mini");
  const [hostedKey, setHostedKey] = useState("");
  const [hostedAsk, setHostedAsk] = useState(false);
  const [hostedBusy, setHostedBusy] = useState(false);

  const [mcpServers, setMcpServers] = useState<McpServerRow[]>([]);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpId, setMcpId] = useState("");
  const [mcpLabel, setMcpLabel] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"stdio" | "http">("stdio");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpSecretKey, setMcpSecretKey] = useState("TOKEN");
  const [mcpSecretVal, setMcpSecretVal] = useState("");
  const [mcpTestOut, setMcpTestOut] = useState<string | null>(null);

  const loadMcp = () => {
    api
      .listMcpServers()
      .then((r) => setMcpServers(r.servers as McpServerRow[]))
      .catch((e) => setMsg(String(e)));
  };

  const load = () => {
    api.settings().then(setData).catch((e) => setMsg(String(e)));
    api
      .voiceStatus()
      .then((r) => setVoiceConfigured(!!r.configured))
      .catch(() => setVoiceConfigured(false));
    api
      .hostedLlmStatus()
      .then((r) => {
        setHosted(r);
        setHostedUrl(r.url);
        setHostedModel(r.model);
        setHostedAsk(r.useForAsk);
      })
      .catch(() => undefined);
    loadMcp();
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

  const saveCartesia = async () => {
    if (!cartesiaKey.trim()) return;
    setVoiceBusy(true);
    setMsg(null);
    try {
      await api.saveCartesiaKey(cartesiaKey.trim());
      setCartesiaKey("");
      setVoiceConfigured(true);
      setMsg("Cartesia voice key saved (encrypted on this PC).");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setVoiceBusy(false);
    }
  };

  const saveHosted = async () => {
    setHostedBusy(true);
    setMsg(null);
    try {
      const r = await api.saveHostedLlm({
        url: hostedUrl.trim(),
        model: hostedModel.trim() || "gpt-4o-mini",
        apiKey: hostedKey.trim() || undefined,
        useForAsk: hostedAsk,
      });
      setHosted(r);
      setHostedUrl(r.url);
      setHostedModel(r.model);
      setHostedAsk(r.useForAsk);
      setHostedKey("");
      setMsg(
        r.configured && r.useForAsk
          ? `Ask will use ${r.model}.`
          : r.configured
            ? "Saved. Turn on “Use this for Ask” when you want the cloud model."
            : "Saved URL/model — add an API key to enable.",
      );
    } catch (e) {
      setMsg(String(e));
    } finally {
      setHostedBusy(false);
    }
  };

  const saveMcp = async () => {
    const id = mcpId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!id) {
      setMsg("MCP server id required (e.g. notion).");
      return;
    }
    if (mcpTransport === "stdio" && !mcpCommand.trim()) {
      setMsg("stdio servers need a command (shown before enable).");
      return;
    }
    if (mcpTransport === "http" && !mcpUrl.trim()) {
      setMsg("http servers need a URL.");
      return;
    }
    setMcpBusy(true);
    setMsg(null);
    setMcpTestOut(null);
    try {
      const args = mcpArgs
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const secrets =
        mcpSecretKey.trim() && mcpSecretVal.trim()
          ? { [mcpSecretKey.trim()]: mcpSecretVal.trim() }
          : undefined;
      await api.saveMcpServer({
        id,
        label: mcpLabel.trim() || id,
        transport: mcpTransport,
        command: mcpTransport === "stdio" ? mcpCommand.trim() : undefined,
        args: mcpTransport === "stdio" && args.length ? args : undefined,
        url: mcpTransport === "http" ? mcpUrl.trim() : undefined,
        enabled: true,
        secretKeys: secrets ? Object.keys(secrets) : undefined,
        secrets,
      });
      setMcpId("");
      setMcpLabel("");
      setMcpCommand("");
      setMcpArgs("");
      setMcpUrl("");
      setMcpSecretVal("");
      setMsg(
        `Saved MCP server "${id}". Command/URL is used only when you enable or test it — nothing is auto-installed.`,
      );
      loadMcp();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setMcpBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Settings</h1>
        <p className="mt-1 text-sm text-ink-400">
          Capture tiers, privacy blocks, pause, voice, MCP tools.
        </p>
      </header>

      {msg && <div className="text-sm text-bad">{msg}</div>}

      <section className="card space-y-3 p-4">
        <h2 className="text-sm font-medium text-ink-200">Voice (Cartesia)</h2>
        <p className="text-xs text-ink-400">
          Speech goes to Cartesia for STT/TTS. Ask answers can be local Ollama
          or a cloud model you set below. The API key is encrypted locally.
        </p>
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              voiceConfigured ? "bg-emerald-400" : "bg-zinc-500"
            }`}
          />
          <span className="text-ink-300">
            {voiceConfigured ? "Voice ready" : "Not configured"}
          </span>
        </div>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveCartesia();
          }}
        >
          <input
            className="input flex-1"
            type="password"
            autoComplete="off"
            placeholder="Cartesia API key (sk_car_…)"
            value={cartesiaKey}
            onChange={(e) => setCartesiaKey(e.target.value)}
          />
          <button
            type="submit"
            className="btn-primary"
            disabled={voiceBusy || !cartesiaKey.trim()}
          >
            {voiceBusy ? "Saving…" : "Save key"}
          </button>
        </form>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="text-sm font-medium text-ink-200">
          Ask model (optional cloud)
        </h2>
        <p className="text-xs text-ink-400">
          Loops and capture stay on local Ollama. Ask (mic + text) can use any
          OpenAI-compatible API — OpenAI, Groq, OpenRouter, etc. The key is
          encrypted on this PC. Ask context (open loops) is sent to that
          provider when this is on.
        </p>
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              hosted.configured && hosted.useForAsk
                ? "bg-emerald-400"
                : hosted.configured
                  ? "bg-amber-400"
                  : "bg-zinc-500"
            }`}
          />
          <span className="text-ink-300">
            {hosted.configured && hosted.useForAsk
              ? `Ask uses ${hosted.model}`
              : hosted.configured
                ? "Key saved — enable for Ask below"
                : "Using local Ollama"}
          </span>
        </div>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveHosted();
          }}
        >
          <input
            className="input w-full font-mono text-xs"
            placeholder="https://api.openai.com/v1"
            value={hostedUrl}
            onChange={(e) => setHostedUrl(e.target.value)}
            disabled={hosted.fromEnv}
          />
          <div className="flex flex-wrap gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              placeholder="model (gpt-4o-mini, llama-3.1-70b-versatile, …)"
              value={hostedModel}
              onChange={(e) => setHostedModel(e.target.value)}
              disabled={hosted.fromEnv}
            />
            <input
              className="input flex-1"
              type="password"
              autoComplete="off"
              placeholder="API key"
              value={hostedKey}
              onChange={(e) => setHostedKey(e.target.value)}
              disabled={hosted.fromEnv}
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-300">
            <input
              type="checkbox"
              checked={hostedAsk}
              onChange={(e) => setHostedAsk(e.target.checked)}
              disabled={hosted.fromEnv}
            />
            Use this for Ask (voice and text)
          </label>
          <button
            type="submit"
            className="btn-primary"
            disabled={hostedBusy || hosted.fromEnv}
          >
            {hostedBusy ? "Saving…" : "Save"}
          </button>
          {hosted.fromEnv && (
            <p className="text-xs text-ink-500">
              Configured via environment variables — edit your .env to change.
            </p>
          )}
        </form>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="text-sm font-medium text-ink-200">
          MCP servers (read-only tools)
        </h2>
        <p className="text-xs text-ink-400">
          Point Second Brain at third-party MCP servers (Notion, Linear, Slack,
          …). The advisor calls them live while reasoning. Only read-only tools
          enter the catalog. Tokens stay in the encrypted local store. You type
          the command yourself — nothing is auto-installed.
        </p>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveMcp();
          }}
        >
          <div className="flex flex-wrap gap-2">
            <input
              className="input w-32"
              placeholder="id (notion)"
              value={mcpId}
              onChange={(e) => setMcpId(e.target.value)}
            />
            <input
              className="input flex-1"
              placeholder="Label"
              value={mcpLabel}
              onChange={(e) => setMcpLabel(e.target.value)}
            />
            <select
              className="input w-auto"
              value={mcpTransport}
              onChange={(e) =>
                setMcpTransport(e.target.value === "http" ? "http" : "stdio")
              }
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </div>
          {mcpTransport === "stdio" ? (
            <div className="flex flex-wrap gap-2">
              <input
                className="input flex-1 font-mono text-xs"
                placeholder="command (npx)"
                value={mcpCommand}
                onChange={(e) => setMcpCommand(e.target.value)}
              />
              <input
                className="input flex-1 font-mono text-xs"
                placeholder="args (-y @notionhq/notion-mcp-server)"
                value={mcpArgs}
                onChange={(e) => setMcpArgs(e.target.value)}
              />
            </div>
          ) : (
            <input
              className="input w-full font-mono text-xs"
              placeholder="https://…"
              value={mcpUrl}
              onChange={(e) => setMcpUrl(e.target.value)}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <input
              className="input w-40 font-mono text-xs"
              placeholder="secret env key"
              value={mcpSecretKey}
              onChange={(e) => setMcpSecretKey(e.target.value)}
            />
            <input
              className="input flex-1"
              type="password"
              autoComplete="off"
              placeholder="token (encrypted)"
              value={mcpSecretVal}
              onChange={(e) => setMcpSecretVal(e.target.value)}
            />
            <button
              type="submit"
              className="btn-primary"
              disabled={mcpBusy}
            >
              {mcpBusy ? "Saving…" : "Add / update"}
            </button>
          </div>
        </form>
        {mcpTestOut && (
          <pre className="max-h-40 overflow-auto rounded-lg bg-black/30 p-2 text-[11px] text-ink-300">
            {mcpTestOut}
          </pre>
        )}
        <ul className="space-y-2 text-sm">
          {mcpServers.map((s) => (
            <li
              key={s.id}
              className="rounded-lg border border-white/5 px-3 py-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        s.enabled ? "bg-sky-400" : "bg-zinc-500"
                      }`}
                    />
                    <span className="font-medium text-ink-200">{s.label}</span>
                    <span className="badge bg-white/10 text-ink-400">
                      {s.transport}
                    </span>
                    <span className="font-mono text-[11px] text-ink-500">
                      {s.id}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-ink-500">
                    {s.transport === "stdio"
                      ? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ")
                      : s.url}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    disabled={mcpBusy}
                    onClick={async () => {
                      setMcpBusy(true);
                      setMcpTestOut(null);
                      try {
                        const r = await api.testMcpServer(s.id);
                        if (!r.ok) {
                          setMcpTestOut(r.error ?? "test failed");
                          return;
                        }
                        const lines = (r.tools ?? []).map(
                          (t) =>
                            `${t.readOnly ? "✓ read" : "✗ write"}  ${t.name}${
                              t.description ? ` — ${t.description.slice(0, 80)}` : ""
                            }`,
                        );
                        setMcpTestOut(
                          [
                            `${s.label}: ${(r.readOnly ?? []).length} read-only of ${(r.tools ?? []).length} tools`,
                            ...lines,
                          ].join("\n"),
                        );
                      } catch (e) {
                        setMcpTestOut(String(e));
                      } finally {
                        setMcpBusy(false);
                      }
                    }}
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    disabled={mcpBusy}
                    onClick={async () => {
                      await api.saveMcpServer({
                        id: s.id,
                        label: s.label,
                        transport: s.transport,
                        command: s.command,
                        args: s.args,
                        url: s.url,
                        enabled: !s.enabled,
                        secretKeys: s.secretKeys,
                      });
                      loadMcp();
                    }}
                  >
                    {s.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    className="btn-danger text-xs"
                    disabled={mcpBusy}
                    onClick={async () => {
                      await api.deleteMcpServer(s.id);
                      loadMcp();
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </li>
          ))}
          {mcpServers.length === 0 && (
            <li className="text-xs text-ink-500">No MCP servers configured.</li>
          )}
        </ul>
      </section>

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
