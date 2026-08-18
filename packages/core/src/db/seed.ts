import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, getSqlite } from "./client.js";
import {
  horizons,
  sources,
  goals,
  captureRules,
  settings,
  userProfiles,
} from "./schema.js";
import { migrate } from "./migrate.js";
import { log } from "../log.js";
import { exportCaptureRulesFile } from "../capture-rules-export.js";

/**
 * Default horizons until onboarding customizes the profile.
 * Keep generic so they work for any user before personalization.
 */
const DEFAULT_HORIZONS = [
  {
    id: "horizon-work",
    name: "Work",
    slug: "work",
    weight: 1.2,
    color: "#3b82f6",
    description: "Job, career, and professional projects",
  },
  {
    id: "horizon-life",
    name: "Life",
    slug: "life",
    weight: 1.0,
    color: "#10b981",
    description: "Health, relationships, home, and personal admin",
  },
  {
    id: "horizon-learning",
    name: "Learning",
    slug: "learning",
    weight: 1.1,
    color: "#8b5cf6",
    description: "Skills, reading, courses, and deliberate practice",
  },
];

const DEFAULT_SOURCES = [
  { id: "src-gmail", kind: "gmail", name: "Gmail" },
  { id: "src-gcal", kind: "gcal", name: "Google Calendar" },
  { id: "src-github", kind: "github", name: "GitHub" },
  { id: "src-capture", kind: "capture", name: "PC Capture" },
];

const DEFAULT_GOALS = [
  {
    horizonId: "horizon-work",
    title: "Ship meaningful work",
    description: "Make steady progress on professional priorities",
  },
  {
    horizonId: "horizon-life",
    title: "Protect life bandwidth",
    description: "Keep personal commitments visible and manageable",
  },
  {
    horizonId: "horizon-learning",
    title: "Grow deliberately",
    description: "Invest consistent time in skills that compound",
  },
];

const DEFAULT_BLOCK_EXES = [
  "1Password.exe",
  "1Password for Windows desktop.exe",
  "Bitwarden.exe",
  "KeePass.exe",
  "KeePassXC.exe",
  "LastPass.exe",
  "CredentialUIBroker.exe",
  "WindowsHelloFaceServer.exe",
];

const DEFAULT_BLOCK_DOMAINS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "auth0.com",
  "id.apple.com",
  "banking.",
  "paypal.com",
];

/**
 * Chat connectors (Slack/Telegram/WhatsApp) were removed from the product.
 * Existing installs still carry their source rows — drop them so the app
 * never reports connectors it no longer has.
 */
function dropRetiredChatSources(): void {
  const sqlite = getSqlite();
  try {
    sqlite.exec(
      `DELETE FROM sources
       WHERE kind IN ('slack','telegram','whatsapp')
         AND id NOT IN (SELECT DISTINCT source_id FROM items)
         AND id NOT IN (SELECT DISTINCT source_id FROM raw_events)`,
    );
  } catch (e) {
    log.warn("Could not drop retired chat sources", { err: String(e) });
  }
}

export function seed(): void {
  migrate();
  const db = getDb();

  dropRetiredChatSources();

  for (const h of DEFAULT_HORIZONS) {
    const existing = db
      .select()
      .from(horizons)
      .where(eq(horizons.slug, h.slug))
      .get();
    if (!existing) {
      db.insert(horizons).values(h).run();
    }
  }

  for (const s of DEFAULT_SOURCES) {
    const existing = db.select().from(sources).where(eq(sources.id, s.id)).get();
    if (!existing) {
      db.insert(sources)
        .values({
          id: s.id,
          kind: s.kind,
          name: s.name,
          configJson: "{}",
          enabled: true,
        })
        .run();
    }
  }

  for (const g of DEFAULT_GOALS) {
    const rows = db.select().from(goals).all();
    if (!rows.some((r) => r.title === g.title && r.horizonId === g.horizonId)) {
      db.insert(goals)
        .values({
          id: randomUUID(),
          horizonId: g.horizonId,
          title: g.title,
          description: g.description,
        })
        .run();
    }
  }

  const rules = db.select().from(captureRules).all();
  if (rules.length === 0) {
    for (const pattern of DEFAULT_BLOCK_EXES) {
      db.insert(captureRules)
        .values({
          id: randomUUID(),
          ruleType: "block_exe",
          pattern,
          note: "seed password / auth UI block",
        })
        .run();
    }
    for (const pattern of DEFAULT_BLOCK_DOMAINS) {
      db.insert(captureRules)
        .values({
          id: randomUUID(),
          ruleType: "block_domain",
          pattern,
          note: "seed sensitive domain block",
        })
        .run();
    }
  }

  const pause = db
    .select()
    .from(settings)
    .where(eq(settings.key, "capture.paused_until"))
    .get();
  if (!pause) {
    db.insert(settings)
      .values({ key: "capture.paused_until", valueJson: "null" })
      .run();
  }
  const toggles = db
    .select()
    .from(settings)
    .where(eq(settings.key, "capture.toggles"))
    .get();
  if (!toggles) {
    db.insert(settings)
      .values({
        key: "capture.toggles",
        valueJson: JSON.stringify({
          window: true,
          browser: true,
          ocr: true,
        }),
      })
      .run();
  }

  const tradingInterest = db
    .select()
    .from(settings)
    .where(eq(settings.key, "interests.trading"))
    .get();
  if (!tradingInterest) {
    db.insert(settings)
      .values({ key: "interests.trading", valueJson: "false" })
      .run();
  }

  const profile = db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.id, "local"))
    .get();
  if (!profile) {
    db.insert(userProfiles)
      .values({
        id: "local",
        goalsJson: "[]",
        workHoursJson: '{"start":"09:00","end":"18:00"}',
        interestsJson: "[]",
        interestPacksJson: "[]",
        contactsJson: "[]",
        onboardingDone: false,
      })
      .run();
  }

  log.info("Seed complete");
  try {
    exportCaptureRulesFile();
  } catch {
    /* ok */
  }
}

const isMain =
  process.argv[1] &&
  (process.argv[1].includes("seed") || process.argv[1].endsWith("seed.ts"));
if (isMain) {
  seed();
}
