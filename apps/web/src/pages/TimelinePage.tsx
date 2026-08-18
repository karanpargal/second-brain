import { useEffect, useState } from "react";
import { api, type TimelinePayload } from "../lib/api";

function formatDwell(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function TimelinePage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<TimelinePayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    setErr(null);
    api
      .timeline(date)
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, [date]);

  const selectedBlock = data?.blocks.find((b) => b.id === selected);
  const relatedObs =
    data && selectedBlock
      ? data.observations.filter(
          (o) =>
            o.ts >= selectedBlock.startAt &&
            o.ts <= selectedBlock.endAt &&
            (o.app === selectedBlock.app ||
              o.windowTitle === selectedBlock.title),
        )
      : [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Timeline</h1>
          <p className="mt-1 text-sm text-ink-400">
            Activity blocks from PC capture.
          </p>
        </div>
        <input
          type="date"
          className="input w-auto"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </header>

      {err && (
        <div className="card p-4 text-sm text-bad">{err}</div>
      )}

      {!data ? (
        <div className="text-sm text-ink-500">Loading…</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="card p-4 lg:col-span-3">
            {data.blocks.length === 0 ? (
              <p className="text-sm text-ink-500">No blocks for this day.</p>
            ) : (
              <ol className="relative space-y-0 border-l border-white/10 pl-4">
                {data.blocks.map((b) => (
                  <li key={b.id} className="mb-4">
                    <div className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border border-ink-950 bg-accent" />
                    <button
                      type="button"
                      className="w-full rounded-lg border border-transparent px-2 py-1.5 text-left hover:border-white/10 hover:bg-white/[0.03]"
                      onClick={() => setSelected(b.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-ink-500">
                          {new Date(b.startAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          {" – "}
                          {new Date(b.endAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span className="text-[11px] text-ink-500">
                          {formatDwell(b.dwellMs)} · {b.obsCount} obs
                        </span>
                      </div>
                      <div className="text-sm text-ink-100">
                        {b.summary || b.title || b.app || "activity"}
                      </div>
                      {b.app && (
                        <div className="text-xs text-ink-500">{b.app}</div>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="card p-4 lg:col-span-2">
            <h2 className="mb-3 text-sm font-medium text-ink-200">Evidence</h2>
            {!selectedBlock ? (
              <p className="text-sm text-ink-500">
                Select a block to see related observations.
              </p>
            ) : relatedObs.length === 0 ? (
              <p className="text-sm text-ink-500">No observation rows matched.</p>
            ) : (
              <ul className="max-h-[70vh] space-y-2 overflow-auto text-xs">
                {relatedObs.map((o) => (
                  <li
                    key={o.id}
                    className="rounded-lg border border-white/5 bg-white/[0.02] p-2"
                  >
                    <div className="text-ink-500">
                      {new Date(o.ts).toLocaleTimeString()} · {o.source}
                    </div>
                    <div className="text-ink-200">
                      {o.windowTitle || o.app || o.url}
                    </div>
                    {o.text && (
                      <div className="mt-1 line-clamp-4 text-ink-400">
                        {o.text}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
