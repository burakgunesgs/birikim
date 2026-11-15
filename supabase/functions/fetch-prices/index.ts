// fetch-prices: fetches the price feed, keeps the last good prices (prices_latest) and today's closing price
// (price_history). Called every ten minutes by pg_cron (0003_cron.sql) with the header x-cron-secret.
//
// Secrets (supabase secrets set): CRON_SECRET. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// When the feed does not answer, the last good prices stay and the call answers 502 (the cron job shows it).

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { type AssetRow, historySource, istanbulDay, parseFeed, pickQuotes, plausible } from "./feed.ts";

const FEED = "https://finans.truncgil.com/v4/today.json";

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function fetchFeed() {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(FEED, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return parseFeed(await res.text());
      last = new Error("HTTP " + res.status);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || !sameSecret(req.headers.get("x-cron-secret") ?? "", secret)) return json({ error: "unauthorized" }, 401);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  let feed;
  try {
    feed = await fetchFeed();
  } catch (err) {
    console.error("feed failed:", String(err));
    return json({ error: "feed unavailable" }, 502);
  }

  const { data: assets, error: e1 } = await db.from("assets").select("code, price_code, grp");
  if (e1) return json({ error: e1.message }, 500);
  const { data: prev, error: e2 } = await db.from("prices_latest").select("code, buy, fetched_at");
  if (e2) return json({ error: e2.message }, 500);
  const kept = new Map((prev ?? []).map((p) => [p.code, { buy: Number(p.buy), fetchedAt: Date.parse(p.fetched_at) }]));

  const now = Date.now(), nowIso = new Date(now).toISOString(), day = istanbulDay(now);
  const quotes = pickQuotes(feed, assets as AssetRow[]);
  const group = new Map((assets as AssetRow[]).map((a) => [a.code, a.grp]));
  const latest: Record<string, unknown>[] = [], history: Record<string, unknown>[] = [], refused: string[] = [];
  for (const [code, q] of quotes) {
    if (!plausible(kept.get(code), q, now)) {
      refused.push(code);
      continue;
    }
    latest.push({ code, buy: q.buy, sell: q.sell, change: q.change, fetched_at: nowIso, feed_updated: feed.Update_Date ?? "" });
    history.push({ day, code, buy: q.buy, sell: q.sell, source: historySource(group.get(code) ?? ""), estimated: false });
  }
  if (refused.length) console.error("refused implausible prices:", refused.join(","));
  if (!latest.length) return json({ error: "no usable prices", refused }, 502);

  const r1 = await db.from("prices_latest").upsert(latest, { onConflict: "code" });
  if (r1.error) return json({ error: r1.error.message }, 500);
  const r2 = await db.from("price_history").upsert(history, { onConflict: "code,day" });
  if (r2.error) return json({ error: r2.error.message }, 500);
  return json({ updated: latest.length, refused, day, feed: feed.Update_Date ?? "" });
});
