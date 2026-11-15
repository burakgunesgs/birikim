import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
const REPO = new URL('../supabase', import.meta.url).pathname;
const db = new PGlite();
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('  FAIL:', m); } };
const q = async (sql, params) => (await db.query(sql, params)).rows;

// ---- Supabase stand-ins: the auth schema, the roles
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);
for (const f of ['0001_schema.sql', '0002_logic.sql', '0004_value_at.sql']) { await db.exec(fs.readFileSync(`${REPO}/migrations/${f}`, 'utf8')); }
console.log('migrations applied');
await db.exec(fs.readFileSync(`${REPO}/seed/price_history.sql`, 'utf8'));
ok((await q('select count(*)::int n from public.price_history'))[0].n === 15351, 'seed row count');

const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222', U3 = '33333333-3333-3333-3333-333333333333';
const H1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', H2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
await db.exec(`
  insert into auth.users values ('${U1}','a@x'),('${U2}','b@x'),('${U3}','c@x');
  insert into public.households values ('${H1}','Aile 1', now()), ('${H2}','Aile 2', now());
  insert into public.household_members (household_id,user_id) values ('${H1}','${U1}'), ('${H1}','${U2}'), ('${H2}','${U3}');
  insert into public.prices_latest values ('GRA', 6279.53, 6280.54, 0.32, now(), '2026-11-15 11:45:03'), ('USD', 50.36, 50.37, 0.22, now(), '2026-11-15 11:45:03');
`);

// run a call as a user (JWT claim) and role
async function as(uid, fn) {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid || ''}', false)`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); }
}
const rpc = async (uid, fn, args = []) => as(uid, async () => {
  const ph = args.map((_, i) => `$${i + 1}`).join(',');
  return (await q(`select public.${fn}(${ph}) as r`, args))[0].r;
});
const fails_with = async (p, re, m) => { try { await p; ok(false, m + ' (no error)'); } catch (e) { ok(re.test(e.message), `${m}: got "${e.message}"`); } };

// ---- 1. access
console.log('1. access');
await fails_with(rpc(null, 'api_boot'), /permission denied/, 'anon cannot call api_boot');
await fails_with(rpc(null, 'api_add', [JSON.stringify({})]), /permission denied/, 'anon cannot call api_add');
await fails_with(as(U1, () => q(`insert into public.transactions (household_id,tx_date,kind,asset_code,qty) values ('${H1}','2026-01-01','Aldım','GRA',1)`)), /permission denied/, 'no direct insert');
await fails_with(as(U1, () => q(`update public.prices_latest set buy = 1`)), /permission denied/, 'no price write');
await fails_with(as(U1, () => q(`select app.replay('${H1}')`)).then(r => { throw new Error('should not matter'); }), /./, 'noop').catch(() => {});
const noHouse = '44444444-4444-4444-4444-444444444444';
await db.exec(`insert into auth.users values ('${noHouse}','d@x')`);
await fails_with(rpc(noHouse, 'api_boot'), /bir aileye bağlı değil/, 'user without household');
await fails_with(rpc(noHouse, 'api_add', [{ kind: 'Aldım', code: 'GRA', qty: 1, price: 1 }]), /Yetkisiz/, 'no household cannot add');

// ---- 2. add / sell / validation
console.log('2. transactions');
let b = await rpc(U1, 'api_boot');
ok(b.transactions.length === 0 && b.summary.holdings.length === 0 && b.summary.count === 0, 'empty boot');
ok(b.assets.length === 22 && b.assets[0].code === 'GRA' && b.assets[0].group === 'Altın', 'assets in boot');
ok(b.prices.TRY.buy === 1 && b.prices.GRA.buy === 6279.53 && b.prices.fetchedAt > 0 && b.prices.updated.startsWith('2026-11-15'), 'prices shape');
const add = (uid, tx) => rpc(uid, 'api_add', [tx]);
await add(U1, { kind: 'Aldım', code: 'GRA', qty: 10, price: 3000, date: '2025-01-10', note: 'ilk' });
await add(U2, { kind: 'Aldım', code: 'GRA', qty: 10, price: 5000, date: '2025-06-10' });          // second member, same household
b = await add(U1, { kind: 'Sattım', code: 'GRA', qty: 5, price: 6000, date: '2025-08-01' });      // avg cost 4000 -> gain 5*(6000-4000)
let g = b.summary.holdings.find(h => h.code === 'GRA');
ok(g.qty === 15 && g.cost === 80000 - 20000 && b.summary.realized === 10000 && b.summary.count === 3, `avg-cost replay: ${JSON.stringify(b.summary)}`);
b = await add(U1, { kind: 'Hediye aldım', code: 'USD', qty: 100, price: 0, date: '2025-09-01' });
b = await add(U1, { kind: 'Hediye verdim', code: 'USD', qty: 40, price: 0, date: '2025-09-02' });
ok(b.summary.holdings.find(h => h.code === 'USD').qty === 60 && b.summary.realized === 10000, 'gift given does not count as gain');
ok(b.transactions[0].kind === 'Hediye verdim' && b.transactions[0].id.length === 36 && b.transactions[0].name === 'Dolar', 'newest first, id and name');
await fails_with(add(U1, { kind: 'Sattım', code: 'GRA', qty: 15.1, price: 6000 }), /Elinde 15 gram Gram Altın var/, 'oversell');
await fails_with(add(U1, { kind: 'Sattım', code: 'CEYREKALTIN', qty: 1, price: 1 }), /Elinde 0 adet Çeyrek Altın var/, 'sell nothing held');
await fails_with(add(U1, { kind: 'Aldım', code: 'XXX', qty: 1, price: 1 }), /Bilinmeyen varlık/, 'unknown asset');
await fails_with(add(U1, { kind: 'Yedim', code: 'GRA', qty: 1, price: 1 }), /Bilinmeyen işlem/, 'unknown kind');
await fails_with(add(U1, { kind: 'Aldım', code: 'GRA', qty: 0, price: 1 }), /Miktar sıfırdan büyük/, 'zero qty');
await fails_with(add(U1, { kind: 'Aldım', code: 'GRA', qty: 'abc', price: 1 }), /okunamadı/, 'bad qty');
await fails_with(add(U1, { kind: 'Aldım', code: 'GRA', qty: 1, price: -1 }), /Fiyat negatif/, 'negative price');
await fails_with(add(U1, { kind: 'Aldım', code: 'GRA', qty: 1, price: 1, date: '2099-01-01' }), /ileri olamaz/, 'future date');
await fails_with(add(U1, { kind: 'Aldım', code: 'GRA', qty: 1, price: 1, date: 'nope' }), /okunamadı/, 'bad date');

// ---- 3. households are separate; delete
console.log('3. households and delete');
const b3 = await rpc(U3, 'api_boot');
ok(b3.transactions.length === 0, 'other household sees nothing');
const mine = (await rpc(U1, 'api_boot')).transactions;
await fails_with(rpc(U3, 'api_delete', [mine[0].id]), /Kayıt bulunamadı/, 'cannot delete another household\'s row');
const visible = await as(U3, () => q('select count(*)::int n from public.transactions'));
ok(visible[0].n === 0, 'RLS hides rows');
const visible2 = await as(U2, () => q('select count(*)::int n from public.transactions'));
ok(visible2[0].n === 5, 'member sees household rows');
const after = await rpc(U2, 'api_delete', [mine[0].id]);
ok(after.transactions.length === 4 && after.summary.count === 4, 'delete by a member of the same household');

// ---- 4. price at a date
console.log('4. price_at');
let p = await rpc(U1, 'api_price_at', ['GRA', '2026-11-15']);
ok(p.buy === 6279.53 && p.note === 'Kapalıçarşı, şimdi', 'price today');
p = await rpc(U1, 'api_price_at', ['GRA', null]); ok(p.buy === 6279.53, 'null date = today');
p = await rpc(U1, 'api_price_at', ['CEYREKALTIN', '2026-11-15']); ok(p === null, 'no live price -> null');
p = await rpc(U1, 'api_price_at', ['GRA', '2026-11-10']); ok(p.note === 'Kapalıçarşı, 10.11.2026' && p.buy > 6000, 'real day: ' + JSON.stringify(p));
p = await rpc(U1, 'api_price_at', ['GRA', '2025-03-19']); ok(/^Kapalıçarşı, 19\.03\.2025$/.test(p.note) && p.buy === 3726.47, 'kuyumaltin day: ' + JSON.stringify(p));
p = await rpc(U1, 'api_price_at', ['CEYREKALTIN', '2025-03-19']); ok(p.note === 'Yaklaşık, 19.03.2025', 'estimated day: ' + JSON.stringify(p));
p = await rpc(U1, 'api_price_at', ['USD', '2025-03-19']); ok(p.note === 'TCMB efektif kur, 19.03.2025', 'tcmb: ' + JSON.stringify(p));
p = await rpc(U1, 'api_price_at', ['TRY', '2025-03-19']); ok(p.buy === 1, 'try');
await fails_with(rpc(U1, 'api_price_at', ['GRA', '2020-01-01']), /fiyat yok/, 'before the history');

// ---- 5. history
console.log('5. history');
const hist = await rpc(U1, 'api_history');
ok(hist.months[0].month === '2025-01' && hist.months.at(-1).month === '2026-11', `months ${hist.months[0].month}..${hist.months.at(-1).month} (${hist.months.length})`);
ok(hist.months.length === 23, 'month count');
const jan = hist.months[0];
ok(jan.cost === 30000 && jan.bought === 30000 && jan.sold === 0 && jan.value > 0, 'jan: ' + JSON.stringify(jan));
const aug = hist.months.find(m => m.month === '2025-08');
ok(aug.sold === 30000 && aug.realized === 10000, 'aug: ' + JSON.stringify(aug));
const now = hist.months.at(-1);
ok(Math.abs(now.value - (15 * 6279.53 + 100 * 50.36)) <= 1, 'this month uses live prices: ' + JSON.stringify(now));
ok(hist.approx === true || hist.approx === false, 'approx flag');
const sep = hist.months.find(m => m.month === '2025-09');
ok(sep.gifts === 0 && sep.value > 0, 'sep: ' + JSON.stringify(sep));
ok(JSON.stringify((await rpc(U3, 'api_history')).months) === '[]', 'empty history for a household with nothing');

// ---- 6. the TV view
console.log('6. tv');
const tv = (await q(`select public.api_tv_holdings('${H1}') as r`))[0].r;
ok(tv.holdings.length === 2 && tv.count === 4 && tv.holdings[0].code === 'GRA', 'tv holdings: ' + JSON.stringify(tv));
await db.exec(`set role anon`); await fails_with(q(`select public.api_tv_holdings('${H1}')`), /permission denied/, 'anon cannot read tv holdings'); await db.exec('reset role');
await db.exec(`set role authenticated`); await fails_with(q(`select public.api_tv_holdings('${H1}')`), /permission denied/, 'user cannot read tv holdings directly'); await db.exec('reset role');

// ---- 7. parity: the old Code.gs replay_ against the SQL one, on random transactions
console.log('7. parity with Code.gs replay_');
const KINDS = { 'Aldım': 1, 'Hediye aldım': 1, 'Sattım': -1, 'Hediye verdim': -1 };
function replayJS(txs, until) {   // Code.gs replay_, verbatim in logic
  const by = {}; let realized = 0;
  txs.forEach(t => {
    if (until && t.date > until) return;
    const h = by[t.code] || (by[t.code] = { code: t.code, qty: 0, cost: 0 });
    const avg = h.qty > 0 ? h.cost / h.qty : 0;
    if (KINDS[t.kind] > 0) { h.qty += t.qty; h.cost += t.qty * t.price; }
    else { const qq = Math.min(t.qty, h.qty); if (t.kind === 'Sattım') realized += qq * (t.price - avg); h.qty -= qq; h.cost -= qq * avg; }
  });
  return { by, realized };
}
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const H3 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
await db.exec(`insert into public.households values ('${H3}','Rastgele', now())`);
const codes = ['GRA', 'CEYREKALTIN', 'USD', 'EUR', 'TRY'], kinds = Object.keys(KINDS), txs = [];
for (let i = 0; i < 400; i++) {
  const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(rnd() * 600) * 864e5).toISOString().slice(0, 10);
  txs.push({ date: d, kind: kinds[Math.floor(rnd() * 4)], code: codes[Math.floor(rnd() * codes.length)],
             qty: Math.round((rnd() * 20 + 0.1) * 1000) / 1000, price: Math.round(rnd() * 8000 * 100) / 100 });
}
for (const t of txs) await q(`insert into public.transactions (household_id,tx_date,kind,asset_code,qty,price) values ($1,$2,$3,$4,$5,$6)`, [H3, t.date, t.kind, t.code, t.qty, t.price]);
// JS order: by date, then entry order (the sheet's row order)
const sorted = txs.map((t, i) => ({ ...t, i })).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.i - b.i);
for (const until of [null, '2025-03-31', '2025-08-31', '2026-02-28']) {
  const js = replayJS(sorted, until);
  const sql = await q(`select code, qty::float8 qty, cost::float8 cost, realized::float8 realized from app.replay($1, $2::date)`, [H3, until]);
  let maxd = 0;
  for (const r of sql) { const j = js.by[r.code]; maxd = Math.max(maxd, Math.abs(r.qty - j.qty), Math.abs(r.cost - j.cost)); }
  const rz = sql.reduce((s, r) => s + r.realized, 0);
  ok(sql.length === Object.keys(js.by).length && maxd < 1e-6 && Math.abs(rz - js.realized) < 1e-4, `replay parity until=${until}: maxdiff=${maxd.toExponential(1)} realized sql=${rz.toFixed(2)} js=${js.realized.toFixed(2)}`);
}


// ---- 8. "what would what I hold now have been worth on that day?"
console.log('8. value_at');
const ph = async (code, day) => Number((await q(`select buy from public.price_history where code=$1 and day=$2`, [code, day]))[0].buy);
let v = await rpc(U1, 'api_value_at', ['2025-03-19']);       // holds 15 gram + 100 USD (see above)
const thenGra = await ph('GRA', '2025-03-19'), thenUsd = await ph('USD', '2025-03-19');
const expThen = 15 * thenGra + 100 * thenUsd, expNow = 15 * 6279.53 + 100 * 50.36;
ok(Math.abs(v.then_total - expThen) < 0.01 && Math.abs(v.now_total - expNow) < 0.01, `totals ${v.then_total}/${v.now_total} vs ${expThen.toFixed(2)}/${expNow.toFixed(2)}`);
ok(Math.abs(v.diff - (expNow - expThen)) < 0.01 && Math.abs(v.pct - (expNow - expThen) / expThen * 100) < 0.01, 'diff and percent');
ok(v.gram.then === 3726.47 && v.gram.now === 6279.53, 'gram then/now: ' + JSON.stringify(v.gram));
ok(v.items.length === 2 && v.items[0].code === 'GRA' && v.items[0].then_price === 3726.47 && v.items[0].qty === 15, 'items: ' + JSON.stringify(v.items[0]));
ok(v.approx === false && v.skipped.length === 0 && v.history_from === '2024-11-15', 'not approximate: gram from an archive, USD from the Central Bank');
v = await rpc(U1, 'api_value_at', ['2026-11-15']);   // today: the history row is what fetch-prices writes (the live price), here the seed's
ok(Math.abs(v.then_total - (15 * await ph('GRA', '2026-11-15') + 100 * await ph('USD', '2026-11-15'))) < 0.01 && v.gram.then === v.gram.now, 'today uses today\'s history row');
await q(`update public.price_history set buy = 50.36, sell = 50.37 where code = 'USD' and day = '2026-11-15'`);
v = await rpc(U1, 'api_value_at', ['2026-11-15']); ok(Math.abs(v.diff) < 0.01 && v.pct === 0, 'today with the live price written: no difference');
await fails_with(rpc(U1, 'api_value_at', ['2099-01-01']), /Geçmiş bir tarih/, 'future date');
await fails_with(rpc(U1, 'api_value_at', [null]), /Geçmiş bir tarih/, 'no date');
await fails_with(rpc(U1, 'api_value_at', ['2024-11-14']), /15\.11\.2024 tarihinden başlıyor/, 'before the history');
await fails_with(rpc(noHouse, 'api_value_at', ['2025-03-19']), /bir aileye bağlı değil/, 'no household');
await fails_with(rpc(null, 'api_value_at', ['2025-03-19']), /permission denied/, 'anon');
ok((await rpc(U3, 'api_value_at', ['2025-03-19'])).items.length === 0, 'a household with nothing: no items');
await add(U1, { kind: 'Aldım', code: 'CEYREKALTIN', qty: 2, price: 7000, date: '2025-04-01' });   // no live price in this test db -> at cost; estimated past price
v = await rpc(U1, 'api_value_at', ['2025-03-19']);
const ce = v.items.find(i => i.code === 'CEYREKALTIN');
ok(v.approx === true && ce.estimated === true && ce.now_value === 14000, 'estimated past price flagged, no live price counted at cost: ' + JSON.stringify(ce));
await db.exec(`delete from public.price_history where code = 'HAS'`);
await add(U1, { kind: 'Aldım', code: 'HAS', qty: 1, price: 1, date: '2025-04-02' });
v = await rpc(U1, 'api_value_at', ['2025-03-19']);
ok(v.skipped.length === 1 && v.skipped[0].code === 'HAS' && !v.items.some(i => i.code === 'HAS'), 'asset without a price that day is left out and listed');
const tryRow = await add(U1, { kind: 'Hediye aldım', code: 'TRY', qty: 1000, price: 0, date: '2025-04-03' });
v = await rpc(U1, 'api_value_at', ['2025-03-19']);
ok(v.items.find(i => i.code === 'TRY').then_value === 1000 && v.items.find(i => i.code === 'TRY').now_value === 1000, 'TRY is worth itself');

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
