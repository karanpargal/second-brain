import { useEffect, useState } from "react";
import { api, type NowPayload } from "../lib/api";
import { Link } from "react-router-dom";

function fmtConfidence(c: number) {
  return `${Math.round(c * 100)}%`;
}

function kindColor(kind: string) {
  switch (kind) {
    case "promise":
      return "bg-accent/20 text-accent-bright";
    case "awaiting_reply":
      return "bg-warn/20 text-warn";
    case "deadline":
      return "bg-bad/20 text-bad";
    case "decision":
      return "bg-good/20 text-good";
    default:
      return "bg-white/10 text-ink-300";
  }
}

export function NowPage() {
  const [data, setData] = useState<NowPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .now()
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) {
    return (
      <div className="card p-6 text-sm text-bad">
        API unreachable. Reopen the Desktop app.
        <div className="mt-2 text-ink-500">{err}</div>
      </div>
    );
  }

  if (!data) {
    return <div className="text-sm text-ink-500">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Now
        </h1>
        <p className="mt-1 text-sm text-ink-400">
          Open loops and where you left off.
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-5">
        <div className="card p-4 lg:col-span-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink-200">Open loops</h2>
            <Link to="/loops" className="text-xs text-accent-bright hover:underline">
              All loops
            </Link>
          </div>
          {data.loops.length === 0 ? (
            <p className="text-sm text-ink-500">
              No open loops yet. Capture a while, then they show up here.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.loops.map((l) => (
                <li
                  key={l.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`badge ${kindColor(l.kind)}`}>{l.kind}</span>
                      <span className="text-sm text-ink-100">{l.title}</span>
                    </div>
                    {(l.who || l.dueHint) && (
                      <div className="mt-1 text-xs text-ink-500">
                        {l.who ? `with ${l.who}` : ""}
                        {l.who && l.dueHint ? " · " : ""}
                        {l.dueHint ? `due ${l.dueHint}` : ""}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 font-mono text-[11px] text-ink-500">
                    {fmtConfidence(l.confidence)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-4 lg:col-span-2">
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-medium text-ink-200">
              Where you left off
            </h2>
            {data.resume.length === 0 ? (
              <p className="text-sm text-ink-500">
                No artifacts yet — desktop capture builds this over time.
              </p>
            ) : (
              <ul className="space-y-3">
                {data.resume.map(({ artifact, openLoops }) => (
                  <li key={artifact.id} className="text-sm">
                    <div className="font-medium text-ink-100">
                      {artifact.title}
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-500">
                      {artifact.kind} ·{" "}
                      {new Date(artifact.lastTouchedAt).toLocaleString()}
                      {openLoops.length > 0
                        ? ` · ${openLoops.length} loop(s)`
                        : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data.calendar.length > 0 && (
            <div className="card p-4">
              <h2 className="mb-3 text-sm font-medium text-ink-200">
                Today on calendar
              </h2>
              <ul className="space-y-2 text-sm">
                {data.calendar.map((c) => (
                  <li key={c.id} className="text-ink-300">
                    <span className="font-mono text-[11px] text-ink-500">
                      {new Date(c.startAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>{" "}
                    {c.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
