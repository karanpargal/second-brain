export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel =
  LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;

function ts(): string {
  return new Date().toISOString();
}

function write(level: LogLevel, msg: string, meta?: unknown): void {
  if (LEVELS[level] < minLevel) return;
  const line =
    meta !== undefined
      ? `[${ts()}] ${level.toUpperCase()} ${msg} ${safeJson(meta)}`
      : `[${ts()}] ${level.toUpperCase()} ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (msg: string, meta?: unknown) => write("debug", msg, meta),
  info: (msg: string, meta?: unknown) => write("info", msg, meta),
  warn: (msg: string, meta?: unknown) => write("warn", msg, meta),
  error: (msg: string, meta?: unknown) => write("error", msg, meta),
};
