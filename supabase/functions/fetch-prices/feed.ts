// The price feed (finans.truncgil.com) and what to take from it. Pure functions, no network: tested in feed.test.mjs.
//
// The feed is one JSON object: "Update_Date" and one entry per code, each {Buying, Selling, Change, Type, ...}.
// A zero (or missing) price means "no price". The file is often served cut off: a cut-off file is used up to its
// last whole entry (gold and currencies come first).

export type Quote = { buy: number; sell: number; change: number };
export type AssetRow = { code: string; price_code: string | null; grp: string };
export type Feed = Record<string, unknown> & { Update_Date?: string };

/** The feed, or when it came cut off, everything up to its last whole entry. Throws when nothing can be read. */
export function parseFeed(text: string): Feed {
  try {
    return JSON.parse(text);
  } catch (err) {
    let cut = text.lastIndexOf("},");
    for (let i = 0; cut > 0 && i < 6; i++, cut = text.lastIndexOf("},", cut - 1)) {
      try {
        return JSON.parse(text.slice(0, cut + 1) + "}");
      } catch (_ignored) {
        // cut further back
      }
    }
    throw err;
  }
}

/** One quote per asset code that the feed has a price for (TRY is never priced). */
export function pickQuotes(feed: Feed, assets: AssetRow[]): Map<string, Quote> {
  const out = new Map<string, Quote>();
  for (const a of assets) {
    if (a.code === "TRY") continue;
    const p = feed[a.price_code ?? a.code] as { Buying?: unknown; Selling?: unknown; Change?: unknown } | undefined;
    if (!p || typeof p !== "object") continue;
    const buy = Number(p.Buying) || Number(p.Selling) || 0;
    const sell = Number(p.Selling) || Number(p.Buying) || 0;
    if (!(buy > 0) || !(sell > 0)) continue;
    out.set(a.code, { buy, sell, change: Number(p.Change) || 0 });
  }
  return out;
}

/**
 * Whether a new price may replace the kept one. A feed gone wrong (a shifted decimal, a swapped entry) shows as a
 * jump no market makes in a day; those are refused for two days, after which a real move is believed.
 */
export function plausible(prev: { buy: number; fetchedAt: number } | undefined, next: Quote, now: number): boolean {
  if (!prev) return true;
  if (now - prev.fetchedAt > 2 * 86_400_000) return true;
  const r = next.buy / prev.buy;
  return r > 0.75 && r < 1.34;
}

/** yyyy-mm-dd in Istanbul, which is the day the prices belong to. */
export function istanbulDay(ms: number): string {
  return new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10);   // Turkey has been on UTC+3 all year since 2016
}

/** What a price row in price_history says about where it came from. */
export function historySource(group: string): string {
  return group === "Döviz" ? "truncgil" : "kapalicarsi";
}
