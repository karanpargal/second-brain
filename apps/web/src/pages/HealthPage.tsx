import { useEffect, useState } from "react";
import { api, type JobsPayload } from "../lib/api";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function HealthPage() {
  const [data, setData] = useState<JobsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .jobs()
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="text-sm text-bad">{err}</div>;
  if (!data) return <div className="text-sm text-ink-500">Loading…</div>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Health</h1>
        <p className="mt-1 text-sm text-ink-400">
          Sources, jobs, Ollama, spool.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Open loops", data.counts.openLoops],
          ["Observations", data.counts.observations],
          ["Items", data.counts.items],
          ["Spool", formatBytes(data.spool.bytes)],
        ].map(([k, v]) => (
          <div key={String(k)} className="card p-4">
            <div className="text-[11px] uppercase tracking-wide text-ink-500">
              {k}
            </div>
            <div className="mt-1 text-2xl font-semibold text-ink-100">{v}</div>
          </div>
        ))}
      </div>

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-medium text-ink-200">Ollama</h2>
        <div className="text-sm">
          <span
            className={
              data.ollama.ok ? "text-good" : "text-bad"
            }
          >
            {data.ollama.ok ? "online" : "offline"}
          </span>
          {data.ollama.models.length > 0 && (
            <span className="ml-2 text-ink-500">
              {data.ollama.models.slice(0, 8).join(", ")}
            </span>
          )}
        </div>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-medium text-ink-200">Sources</h2>
        <ul className="space-y-2 text-sm">
          {data.sources.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between border-b border-white/5 pb-2"
            >
              <span>
                <span className="text-ink-100">{s.name}</span>
                <span className="ml-2 text-xs text-ink-500">{s.kind}</span>
              </span>
              <span className="text-xs text-ink-500">
                {s.lastError ? (
                  <span className="text-bad">{s.lastError}</span>
                ) : s.lastRunAt ? (
                  new Date(s.lastRunAt).toLocaleString()
                ) : (
                  "never"
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-medium text-ink-200">Recent jobs</h2>
        <ul className="space-y-1 font-mono text-xs">
          {data.jobs.map((j) => (
            <li key={j.id} className="flex justify-between gap-2 text-ink-400">
              <span>
                <span
                  className={
                    j.status === "ok"
                      ? "text-good"
                      : j.status === "error"
                        ? "text-bad"
                        : "text-warn"
                  }
                >
                  {j.status}
                </span>{" "}
                {j.job}
              </span>
              <span className="text-ink-600">
                {new Date(j.startedAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
