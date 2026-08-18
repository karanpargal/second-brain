import { useState } from "react";
import { api, type AskResult } from "../lib/api";
import { MarkdownBrief } from "../components/MarkdownBrief";

const SUGGESTIONS = [
  "What did I promise to send by Friday?",
  "What should I focus on right now?",
  "Where did I leave off on my main project?",
  "What open loops am I quietly avoiding?",
];

export function AskPage() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (question: string) => {
    if (!question.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api.ask(question.trim());
      setResult(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Ask</h1>
        <p className="mt-1 text-sm text-ink-400">
          Chat over local memory via Ollama.
        </p>
      </header>

      <form
        className="card flex flex-col gap-2 p-3 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(q);
        }}
      >
        <input
          className="input flex-1"
          placeholder="What did I promise…?"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>

      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="btn-ghost text-xs"
            onClick={() => {
              setQ(s);
              void submit(s);
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {err && <div className="text-sm text-bad">{err}</div>}

      {result && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="card p-5 lg:col-span-2">
            <MarkdownBrief markdown={result.answer} />
          </div>
          <div className="card p-4">
            <h2 className="mb-2 text-sm font-medium text-ink-200">Sources</h2>
            <ul className="space-y-2 text-xs text-ink-400">
              {result.sources.map((s, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-white/5 p-2"
                >
                  {s.text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
