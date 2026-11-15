// tv-holdings: what the TV reads. Answers the same JSON the Apps Script web app gave at ?api=1:
//   { updated, holdings: [{ code, name, unit, qty, cost }], realized, count }
// The TV keeps {"url": ".../functions/v1/tv-holdings", "key": "<TV_TOKEN>"} in birikim.json and calls
// url?api=1&k=<key>; "Authorization: Bearer <TV_TOKEN>" works too.
//
// Secrets (supabase secrets set): TV_TOKEN (a long random string), TV_HOUSEHOLD_ID (the household whose holdings
// the TV shows). It only reads. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const token = Deno.env.get("TV_TOKEN") ?? "", household = Deno.env.get("TV_HOUSEHOLD_ID") ?? "";
  if (!token || !household) return json({ error: "not configured" }, 500);
  const url = new URL(req.url);
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || url.searchParams.get("k") || "";
  if (!sameSecret(given, token)) return json({ error: "unauthorized" }, 401);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data, error } = await db.rpc("api_tv_holdings", { p_household: household });
  if (error) return json({ error: error.message }, 500);
  return json(data);
});
