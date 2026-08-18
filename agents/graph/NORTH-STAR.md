# North star — Personal AI agent for the desktop

This is the only product we are building. Every feature in a graph run is judged against it.

## What the user opens

**One double-click.** Tray + floating widget. Core, capture, and UI start themselves. No terminals, no browser as the primary surface.

## What the agent is

A **personal** assistant that lives on this PC and:

1. **Watches** what you work on (windows, browser, on-screen text) without leaving the machine.
2. **Ingests** the accounts you connect (Gmail, Calendar, GitHub — read-only, propose-only). Chat apps are **not** connected accounts — the desktop already sees their windows.
3. **Surfaces** unfinished work: today's todos, deadlines, follow-ups, long-term reminders.
4. **Helps you get better** — upskill / "improve yourself" from what you actually do, not generic advice.
5. **Talks to you** on the widget: what matters now, what to ignore (spam), where you left off.
6. **Stays local** — Ollama on this machine. Secrets encrypted. OCR bitmaps never saved.

## What it is not

- A multi-tenant SaaS or a team workspace.
- A trading desk, a chat-app **scraper** (no QR, no OAuth, no OCR of message bodies), or a generic "second brain" wiki.
- A product that requires `npm run` for daily use.
- An agent that sends mail, comments on PRs, or mutates external accounts.

## Four pillars (current scope)

| Pillar | Meaning |
|--------|---------|
| Today's work | Urgent / today / to-do from mail, calendar, GitHub, browsing |
| Long-term reminders | Snooze that wakes; calendar lead time; things that should come back |
| Upskill | Insights from real activity, not empty profile prompts |
| Spam / noise | Hide what is not yours to track; learn from "spam" / "not tracking" |

Sources: **Gmail, Calendar, GitHub, browser history, PC capture**. Chat apps (WhatsApp / Telegram / Slack / Discord / Signal / Teams) are **window-title only, zero friction** — no connect flow. OCR of chat bodies stays off. Contact names are not Improve topics.

## Verdict vocabulary (every feature)

| Verdict | Meaning |
|---------|---------|
| **KEEP** | Needed for the north star and working as intended |
| **FIX** | Needed, built, but not working as intended |
| **CUT** | Moot — does not serve a personal desktop agent (or fights it) |
| **MISSING** | Needed, not built (or only a stub) |

Ask three questions, in order:

1. **Need?** Does a personal desktop AI agent require this?
2. **Built?** Is there real code, not just a schema comment?
3. **Working?** Would a user who only opens the .exe get the intended behavior?
