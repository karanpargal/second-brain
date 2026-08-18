/**
 * Widget voice from the morning brief's Focus section.
 * Pure — no DB.
 */
export function extractFocusVoice(
  markdown: string,
  maxLen = 320,
): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Focus\s*$/i.test(line));
  if (start < 0) return null;
  const bullets: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break;
    const text = line
      .replace(/^\s*[-*]\s+/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (text.length > 2 && !/^\*?none\b/i.test(text)) {
      bullets.push(text);
    }
    if (bullets.length >= 3) break;
  }
  if (!bullets.length) return null;
  return bullets.join(" · ").slice(0, maxLen);
}
