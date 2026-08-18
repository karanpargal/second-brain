import { useEffect, useMemo, useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  onNavigate: (path: string) => void;
};

const COMMANDS = [
  { id: "now", label: "Go to Now", path: "/" },
  { id: "timeline", label: "Go to Timeline", path: "/timeline" },
  { id: "loops", label: "Go to Loops", path: "/loops" },
  { id: "ask", label: "Ask memory", path: "/ask" },
  { id: "settings", label: "Settings", path: "/settings" },
  { id: "health", label: "Health", path: "/health" },
];

export function CommandPalette({ open, onClose, onNavigate }: Props) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return COMMANDS;
    return COMMANDS.filter((c) => c.label.toLowerCase().includes(s));
  }, [q]);

  useEffect(() => {
    if (!open) {
      setQ("");
      setIdx(0);
    }
  }, [open]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="input rounded-none border-0 border-b border-white/10 bg-transparent"
          placeholder="Jump to…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(filtered.length - 1, i + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            }
            if (e.key === "Enter" && filtered[idx]) {
              onNavigate(filtered[idx]!.path);
            }
          }}
        />
        <ul className="max-h-72 overflow-auto p-1">
          {filtered.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                className={
                  "flex w-full rounded-lg px-3 py-2 text-left text-sm " +
                  (i === idx ? "bg-white/10 text-white" : "text-ink-300 hover:bg-white/5")
                }
                onMouseEnter={() => setIdx(i)}
                onClick={() => onNavigate(c.path)}
              >
                {c.label}
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-4 text-sm text-ink-500">No matches</li>
          )}
        </ul>
      </div>
    </div>
  );
}
