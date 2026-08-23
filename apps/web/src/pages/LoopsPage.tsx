import { useEffect, useState } from "react";
import { api, type OpenLoop, type LoopEvidence } from "../lib/api";

export function LoopsPage() {
  const [status, setStatus] = useState("open");
  const [loops, setLoops] = useState<OpenLoop[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<LoopEvidence[]>([]);
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    api
      .loops(status)
      .then((r) => setLoops(r.loops))
      .catch((e) => setErr(String(e)));
  };

  useEffect(() => {
    load();
  }, [status]);

  useEffect(() => {
    if (!selected) {
      setEvidence([]);
      return;
    }
    api
      .loop(selected)
      .then((r) => setEvidence(r.evidence))
      .catch(() => setEvidence([]));
  }, [selected]);

  const act = async (id: string, s: string) => {
    await api.patchLoop(id, s);
    load();
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Loops</h1>
          <p className="mt-1 text-sm text-ink-400">
            Open work with evidence trails.
          </p>
        </div>
        <div className="flex gap-1">
          {["open", "closed", "snoozed", "dismissed", "all"].map((s) => (
            <button
              key={s}
              type="button"
              className={
                status === s ? "btn-primary text-xs" : "btn-ghost text-xs"
              }
              onClick={() => setStatus(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </header>

      <form
        className="card flex flex-wrap gap-2 p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          await api.createLoop({ title: title.trim() });
          setTitle("");
          load();
        }}
      >
        <input
          className="input flex-1"
          placeholder="Add a manual open loop…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" className="btn-primary">
          Add
        </button>
      </form>

      {err && <div className="text-sm text-bad">{err}</div>}

      <div className="grid gap-4 lg:grid-cols-5">
        <ul className="space-y-2 lg:col-span-3">
          {loops.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => setSelected(l.id)}
                className={
                  "card w-full px-4 py-3 text-left " +
                  (selected === l.id ? "ring-1 ring-accent/50" : "")
                }
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm text-ink-100">{l.title}</div>
                    <div className="mt-1 text-[11px] text-ink-500">
                      {l.kind} · {l.origin} ·{" "}
                      {Math.round(l.confidence * 100)}%
                      {l.who ? ` · ${l.who}` : ""}
                      {l.dueAt
                        ? (() => {
                            const ms = Date.parse(l.dueAt);
                            if (Number.isNaN(ms)) return "";
                            const due = new Date(ms);
                            const today = new Date();
                            today.setHours(0, 0, 0, 0);
                            const dueDay = new Date(due);
                            dueDay.setHours(0, 0, 0, 0);
                            const days = Math.round(
                              (dueDay.getTime() - today.getTime()) / 86_400_000,
                            );
                            if (days < 0)
                              return ` · Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`;
                            if (days === 0) return " · Due today";
                            if (days === 1) return " · Due tomorrow";
                            return ` · Due ${due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
                          })()
                        : ""}
                    </div>
                  </div>
                  <span className="badge bg-white/10 text-ink-400">
                    {l.status}
                  </span>
                </div>
                {l.status === "open" && (
                  <div className="mt-2 flex gap-1">
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        void act(l.id, "closed");
                      }}
                    >
                      Close
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        void act(l.id, "snoozed");
                      }}
                    >
                      Snooze
                    </button>
                    <button
                      type="button"
                      className="btn-danger text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        void act(l.id, "dismissed");
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </button>
            </li>
          ))}
          {loops.length === 0 && (
            <li className="text-sm text-ink-500">No loops for this filter.</li>
          )}
        </ul>

        <div className="card p-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-medium text-ink-200">Evidence</h2>
          {!selected ? (
            <p className="text-sm text-ink-500">Select a loop.</p>
          ) : evidence.length === 0 ? (
            <p className="text-sm text-ink-500">No evidence rows.</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {evidence.map((e) => (
                <li
                  key={e.id}
                  className="rounded-lg border border-white/5 p-2"
                >
                  <div className="badge bg-white/10 text-ink-400">{e.role}</div>
                  <div className="mt-1 text-ink-300">{e.note || "—"}</div>
                  <div className="mt-1 text-ink-600">
                    {new Date(e.createdAt).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
