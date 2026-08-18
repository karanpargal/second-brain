/**
 * Trading / futures UI coaching — missing TP/SL, unprotected positions, etc.
 * Surfaces: trench.ag, TradingView, Binance, Bybit, Hyperliquid, brokers, …
 */

export type TradingActionScore = {
  score: number; // 0..1
  kind: "promise" | "awaiting_reply" | "unfinished" | "decision" | "deadline";
  who?: string; // ticker / symbol
  actionTitle: string;
  reason: string;
  venue?: string;
};

const TRADING_HOST_RE =
  /\b(trench\.ag|tradingview\.com|binance\.com|bybit\.com|okx\.com|hyperliquid\.xyz|dydx\.exchange|coinbase\.com|kraken\.com|robinhood\.com|webull\.com|tastytrade\.com|thinkorswim|interactivebrokers|ibkr\.com|futures\.|perp\.|dexscreener\.com|gmgn\.ai|axiom\.trade|photon-sol|bloxroute|jupiter\.ag)\b/i;

const TRADING_APP_RE =
  /\b(trench|tradingview|binance|bybit|okx|hyperliquid|robinhood|webull|tastytrade|thinkorswim|ibkr|interactive brokers|coinbase|kraken|tos|ninjatrader|tradovate|mt4|mt5|metatrader)\b/i;

/** UI chrome that strongly implies a trading desk */
const TRADING_UI_RE =
  /\b(open interest|unrealized pn[l]|cross margin|iso(lated)? margin|funding(\/countdown)?|oracle price|take profit|stop[- ]?loss|tp\/sl|liquidation|mark price|avail(able)? margin|cross account leverage|positions?\b|long\b|short\b)\b/i;

const CREATE_TP_SL_RE =
  /\+\s*create\s*tp\/?sl|create\s*tp\/?sl|\bedit\s*tp\/?sl\b/i;
const TP_EMPTY_RE = /\btp\s*[—–-]{1,2}\b|\btp\s*--\b|\bno\s*take[- ]?profit\b/i;
const SL_EMPTY_RE = /\bsl\s*[—–-]{1,2}\b|\bsl\s*--\b|\bno\s*stop[- ]?loss\b/i;

const HAS_SL_RE =
  /\bsl\s*\$?\s*[\d,.]+|stop[- ]?loss\s*[:\s]*\$?[\d,.]+|sl\s*[:=]\s*\$?[\d,.]+/i;

const HAS_TP_RE =
  /\btp\s*\$?\s*[\d,.]+|take[- ]?profit\s*[:\s]*\$?[\d,.]+|tp\s*[:=]\s*\$?[\d,.]+/i;

const POSITION_SIDE_RE = /\b(long|short)\b/i;

const HEAVY_LOSS_RE =
  /(-\s*\$?\d[\d,.]*\s*\(-\s*\d{2,}(?:\.\d+)?%\))|(-\s*\d{2,}(?:\.\d+)?%\b)/;

/** Common equity / crypto tickers + $TICKER / BTC-PERP style */
const TICKER_RE =
  /\b(?:\$)?([A-Z]{2,6})(?:[-_/]?(?:PERP|USD|USDT|USDC))?\b/g;

const NOISE_TICKERS = new Set([
  "TP",
  "SL",
  "PNL",
  "USD",
  "USDT",
  "USDC",
  "PERP",
  "LONG",
  "SHORT",
  "ISO",
  "CROSS",
  "OCR",
  "API",
  "HTTP",
  "HTTPS",
  "THE",
  "AND",
  "FOR",
  "YOU",
  "ALL",
  "NEW",
  "OPEN",
  "SIZE",
  "SIDE",
  "ENTRY",
  "VALUE",
  "MARK",
  "ORACLE",
  "VOLUME",
  "INTEREST",
  "FUNDING",
  "MARGIN",
  "RATIO",
  "LEVERAGE",
  "CREATE",
  "MARKET",
  "LIMIT",
  "ORDER",
  "BUY",
  "SELL",
  "POS",
  "EDIT",
  "CHROME",
  "GOOGLE",
  "EDGE",
  "BRAVE",
  "FIREFOX",
  "TRENCH",
  "WINDOWS",
  "DESKTOP",
]);

export function isTradingSurface(input: {
  app?: string | null;
  exe?: string | null;
  windowTitle?: string | null;
  url?: string | null;
  text?: string | null;
}): boolean {
  const meta = [input.app, input.exe, input.windowTitle, input.url]
    .filter(Boolean)
    .join(" ");
  const text = input.text ?? "";
  // Messaging apps can mention “Trench” in a chat title — not a desk
  if (/\b(whatsapp|telegram|slack|discord|signal|teams)\b/i.test(meta)) {
    const uiHits = (text.match(TRADING_UI_RE) ?? []).length;
    return uiHits >= 2 && POSITION_SIDE_RE.test(text);
  }
  if (TRADING_HOST_RE.test(meta) || TRADING_APP_RE.test(meta)) return true;
  if (!text) return false;
  const uiHits = (text.match(TRADING_UI_RE) ?? []).length;
  return uiHits >= 2 && POSITION_SIDE_RE.test(text);
}

export function guessVenue(input: {
  app?: string | null;
  windowTitle?: string | null;
  url?: string | null;
}): string | undefined {
  const blob = [input.app, input.windowTitle, input.url].filter(Boolean).join(" ");
  const m = blob.match(TRADING_APP_RE) ?? blob.match(TRADING_HOST_RE);
  if (!m?.[0]) return undefined;
  const raw = m[0].toLowerCase().replace(/\.(com|ag|xyz|exchange)$/i, "");
  if (raw.includes("trench")) return "Trench";
  if (raw.includes("tradingview")) return "TradingView";
  if (raw.includes("binance")) return "Binance";
  if (raw.includes("bybit")) return "Bybit";
  if (raw.includes("hyperliquid")) return "Hyperliquid";
  if (raw.includes("robinhood")) return "Robinhood";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Prefer tickers that appear near Long/Short or Create TP/SL.
 */
export function guessTickers(text: string, limit = 4): string[] {
  const upper = text.toUpperCase();
  const nearPos: string[] = [];
  const lines = upper.split(/\r?\n/);
  for (const line of lines) {
    if (
      !POSITION_SIDE_RE.test(line) &&
      !CREATE_TP_SL_RE.test(line) &&
      !TP_EMPTY_RE.test(line) &&
      !SL_EMPTY_RE.test(line) &&
      !/\b(POSITIONS?|UNREALIZED)\b/.test(line)
    ) {
      continue;
    }
    TICKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TICKER_RE.exec(line)) !== null) {
      const t = m[1].toUpperCase();
      if (NOISE_TICKERS.has(t)) continue;
      if (t.length < 2 || t.length > 6) continue;
      if (!nearPos.includes(t)) nearPos.push(t);
    }
  }
  if (nearPos.length > 0) return nearPos.slice(0, limit);

  const all: string[] = [];
  TICKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TICKER_RE.exec(upper)) !== null) {
    const t = m[1].toUpperCase();
    if (NOISE_TICKERS.has(t)) continue;
    if (!all.includes(t)) all.push(t);
  }
  return all.slice(0, limit);
}

function hasPositionRisk(text: string): boolean {
  return (
    POSITION_SIDE_RE.test(text) &&
    /\b(positions?|entry|unrealized|size|leverage)\b/i.test(text)
  );
}

/**
 * Score whether trading OCR shows a risk the user should act on.
 */
export function scoreTradingAction(input: {
  app?: string | null;
  exe?: string | null;
  windowTitle?: string | null;
  url?: string | null;
  text: string;
}): TradingActionScore | null {
  if (!isTradingSurface(input)) return null;
  const text = [input.text, input.windowTitle, input.app]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text.length < 6) return null;

  let score = 0;
  const reasons: string[] = [];
  const venue = guessVenue(input);
  const ticker =
    guessTickers(text, 3)[0] ??
    guessTickers([input.windowTitle, input.app].filter(Boolean).join(" "), 2)[0];

  const editWithoutLevels =
    /\bedit\s*tp\/?sl\b/i.test(text) && !HAS_TP_RE.test(text) && !HAS_SL_RE.test(text);
  const createBoth = CREATE_TP_SL_RE.test(text) || editWithoutLevels;
  const hasSl = HAS_SL_RE.test(text);
  const hasTp = HAS_TP_RE.test(text);
  const tpEmpty = TP_EMPTY_RE.test(text) && !hasTp;
  const slEmpty = (SL_EMPTY_RE.test(text) || createBoth) && !hasSl;
  const needSl = createBoth || slEmpty || (hasPositionRisk(text) && !hasSl);
  const needTp = createBoth || tpEmpty || (hasPositionRisk(text) && !hasTp && hasSl);
  const hasPosition = hasPositionRisk(text);
  const heavyLoss = HEAVY_LOSS_RE.test(text);

  const titleOnlyDesk =
    !!ticker &&
    TRADING_APP_RE.test(
      [input.app, input.windowTitle, input.url].filter(Boolean).join(" "),
    ) &&
    !createBoth &&
    !hasSl &&
    !hasTp;

  if (createBoth) {
    score += 0.7;
    reasons.push("missing_tp_sl");
  } else if (needSl) {
    score += 0.6;
    reasons.push("no_stop");
  } else if (needTp) {
    score += 0.5;
    reasons.push("no_take_profit");
  } else if (titleOnlyDesk) {
    score += 0.55;
    reasons.push("focused_symbol");
  }
  if (heavyLoss && needSl) {
    score += 0.25;
    reasons.push("heavy_unrealized_loss");
  }
  if (/\bliquidat/i.test(text) && hasPosition) {
    score += 0.2;
    reasons.push("liq_risk");
  }
  if (ticker && (needSl || needTp || titleOnlyDesk)) {
    score += 0.1;
  }

  score = Math.min(1, score);
  if (score < 0.5) return null;

  let actionTitle = "Review open trade risk";
  if (createBoth || (needSl && needTp) || titleOnlyDesk) {
    actionTitle = ticker
      ? `Set TP/SL on ${ticker}`
      : "Set take-profit / stop-loss on open position";
  } else if (needSl) {
    actionTitle = ticker
      ? `Set stop-loss on ${ticker}`
      : "Set stop-loss on open position";
  } else if (needTp) {
    actionTitle = ticker
      ? `Set take-profit on ${ticker}`
      : "Set take-profit on open position";
  } else if (heavyLoss) {
    actionTitle = ticker
      ? `Review losing ${ticker} position`
      : "Review losing open position";
  }

  return {
    score,
    kind: heavyLoss || needSl || titleOnlyDesk ? "deadline" : "unfinished",
    who: ticker,
    actionTitle: actionTitle.slice(0, 160),
    reason: reasons.join("+") || "trading",
    venue,
  };
}

/** Evidence that exits were set / position gone — for auto-close */
export function tradingExitEvidence(text: string, ticker?: string | null): boolean {
  const t = text.toLowerCase();
  if (
    /\b(position closed|closed position|flattened|flat|tp hit|sl hit|stopped out|take profit (hit|filled)|order filled)\b/i.test(
      text,
    )
  ) {
    if (!ticker) return true;
    return t.includes(ticker.toLowerCase());
  }
  if (ticker && t.includes(ticker.toLowerCase())) {
    if (
      HAS_TP_RE.test(text) &&
      HAS_SL_RE.test(text) &&
      !CREATE_TP_SL_RE.test(text)
    ) {
      return true;
    }
  }
  return false;
}
