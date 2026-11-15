// Run: node --test --experimental-strip-types supabase/functions/fetch-prices/feed.test.mjs   (Node 22.6 or later)
import test from "node:test";
import assert from "node:assert/strict";
import { historySource, istanbulDay, parseFeed, pickQuotes, plausible } from "./feed.ts";

const FEED = {
  Update_Date: "2026-11-15 11:45:03",
  USD: { Buying: 50.3596, Selling: 50.3716, Change: 0.22, Type: "Currency" },
  GRA: { Buying: 6279.53, Selling: 6280.54, Change: 0.32, Type: "Gold", Name: "GRAMALTIN" },
  YIA: { Buying: 5736.33, Selling: 5944.79, Change: 0.53, Type: "Gold" },
  GUMUS: { Buying: 79.1, Selling: 79.18, Change: -2.04, Type: "Gold" },
  ONS: { Buying: 0, Selling: 0, Change: 0.1, Type: "Gold" },
  XU100: { Selling: 11842.82, Change: 0.27, Type: "Gold" },
};
const ASSETS = [
  { code: "GRA", price_code: null, grp: "Altın" }, { code: "YIA", price_code: null, grp: "Altın" },
  { code: "22AYAR", price_code: "YIA", grp: "Altın" }, { code: "USD", price_code: null, grp: "Döviz" },
  { code: "TRY", price_code: null, grp: "Nakit" }, { code: "CEYREKALTIN", price_code: null, grp: "Altın" },
  { code: "ONS", price_code: null, grp: "Diğer" },
];

test("a whole feed is read as is", () => {
  assert.deepEqual(parseFeed(JSON.stringify(FEED)), FEED);
});

test("a cut-off feed is used up to its last whole entry", () => {
  const text = JSON.stringify(FEED);
  const cut = text.slice(0, text.indexOf('"GUMUS"') + 25);   // cut in the middle of GUMUS
  const feed = parseFeed(cut);
  assert.equal(feed.GRA.Buying, 6279.53);
  assert.equal(feed.YIA.Selling, 5944.79);
  assert.equal(feed.GUMUS, undefined);
});

test("nothing readable throws", () => {
  assert.throws(() => parseFeed("<html>502 Bad Gateway</html>"));
  assert.throws(() => parseFeed(""));
});

test("quotes: priced as another code, zero prices and TRY are left out", () => {
  const q = pickQuotes(FEED, ASSETS);
  assert.deepEqual([...q.keys()].sort(), ["22AYAR", "GRA", "USD", "YIA"]);
  assert.deepEqual(q.get("22AYAR"), q.get("YIA"));
  assert.deepEqual(q.get("GRA"), { buy: 6279.53, sell: 6280.54, change: 0.32 });
  assert.equal(q.has("ONS"), false);          // 0 / 0
  assert.equal(q.has("CEYREKALTIN"), false);  // not in the feed
  assert.equal(q.has("TRY"), false);
});

test("a missing buying price takes the selling price and the other way round", () => {
  const q = pickQuotes({ GRA: { Selling: 100 }, USD: { Buying: 50 } }, ASSETS);
  assert.deepEqual(q.get("GRA"), { buy: 100, sell: 100, change: 0 });
  assert.deepEqual(q.get("USD"), { buy: 50, sell: 50, change: 0 });
});

test("a jump no market makes is refused, then believed after two days", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  const prev = { buy: 6000, fetchedAt: now - 3600_000 };
  assert.equal(plausible(undefined, { buy: 1, sell: 1, change: 0 }, now), true);
  assert.equal(plausible(prev, { buy: 6300, sell: 6300, change: 0 }, now), true);    // +5%
  assert.equal(plausible(prev, { buy: 5400, sell: 5400, change: 0 }, now), true);    // -10%
  assert.equal(plausible(prev, { buy: 60000, sell: 60000, change: 0 }, now), false); // shifted decimal
  assert.equal(plausible(prev, { buy: 600, sell: 600, change: 0 }, now), false);
  assert.equal(plausible({ buy: 6000, fetchedAt: now - 3 * 86_400_000 }, { buy: 9000, sell: 9000, change: 0 }, now), true);
});

test("the day is the Istanbul day", () => {
  assert.equal(istanbulDay(Date.parse("2026-11-15T20:59:59Z")), "2026-11-15");
  assert.equal(istanbulDay(Date.parse("2026-11-15T21:00:00Z")), "2026-11-16");
  assert.equal(istanbulDay(Date.parse("2026-11-15T00:00:00Z")), "2026-11-15");
});

test("history source", () => {
  assert.equal(historySource("Döviz"), "truncgil");
  assert.equal(historySource("Altın"), "kapalicarsi");
});
