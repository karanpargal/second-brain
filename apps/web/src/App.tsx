import { useEffect, useState, useCallback } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { NowPage } from "./pages/NowPage";
import { TimelinePage } from "./pages/TimelinePage";
import { LoopsPage } from "./pages/LoopsPage";
import { AskPage } from "./pages/AskPage";
import { SettingsPage } from "./pages/SettingsPage";
import { HealthPage } from "./pages/HealthPage";
import { WidgetPage } from "./pages/WidgetPage";
import { CommandPalette } from "./components/CommandPalette";

const NAV = [
  { to: "/", label: "Now", end: true },
  { to: "/timeline", label: "Timeline" },
  { to: "/loops", label: "Loops" },
  { to: "/ask", label: "Ask" },
  { to: "/settings", label: "Settings" },
  { to: "/health", label: "Health" },
];

export function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const isWidget = location.pathname === "/widget";

  const onKey = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setPaletteOpen((v) => !v);
    }
  }, []);

  useEffect(() => {
    if (isWidget) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey, isWidget]);

  if (isWidget) {
    return (
      <Routes>
        <Route path="/widget" element={<WidgetPage />} />
      </Routes>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl gap-6 px-4 py-5 md:px-6">
      <aside className="hidden w-44 shrink-0 flex-col gap-1 md:flex">
        <div className="mb-4 px-3">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-bright">
            Second Brain
          </div>
          <div className="mt-1 text-[11px] text-ink-500">
            local ambient memory
          </div>
        </div>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              clsx("nav-link", isActive && "nav-link-active")
            }
          >
            {n.label}
          </NavLink>
        ))}
        <button
          type="button"
          className="nav-link mt-4 text-left text-ink-500"
          onClick={() => setPaletteOpen(true)}
        >
          Command <span className="kbd ml-1">Ctrl K</span>
        </button>
      </aside>

      <main className="min-w-0 flex-1 pb-12">
        <div className="mb-4 flex items-center justify-between md:hidden">
          <div className="text-sm font-semibold text-accent-bright">
            Second Brain
          </div>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => setPaletteOpen(true)}
          >
            Ctrl K
          </button>
        </div>
        <nav className="mb-4 flex gap-1 overflow-x-auto md:hidden">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                clsx("nav-link whitespace-nowrap", isActive && "nav-link-active")
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>

        <Routes>
          <Route path="/" element={<NowPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/loops" element={<LoopsPage />} />
          <Route path="/ask" element={<AskPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/widget" element={<WidgetPage />} />
        </Routes>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(p) => {
          navigate(p);
          setPaletteOpen(false);
        }}
      />
    </div>
  );
}
