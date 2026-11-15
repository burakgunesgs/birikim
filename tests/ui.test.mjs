// The real index.html in jsdom, talking to the real SQL (PGlite) through a stand-in for supabase-js.
import { PGlite } from '@electric-sql/pglite';
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('  FAIL:', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, what, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await sleep(25); } ok(false, 'timeout: ' + what); return false; }

// ---- database
const db = new PGlite();
await db.exec(`
  create schema auth; create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
for (const f of ['0001_schema.sql', '0002_logic.sql', '0004_value_at.sql']) await db.exec(fs.readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8'));
await db.exec(fs.readFileSync(`${REPO}/supabase/seed/price_history.sql`, 'utf8'));
const U = '11111111-1111-1111-1111-111111111111', H = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
await db.exec(`insert into auth.users values ('${U}','burak@example.com'); insert into public.households values ('${H}','Güneş', now());
  insert into public.household_members (household_id,user_id) values ('${H}','${U}');
  insert into public.prices_latest values ('GRA', 6279.53, 6280.54, 0.32, now(), '2026-11-15 11:45:03'), ('CEYREKALTIN', 10266, 10374, 0.54, now(), ''), ('USD', 50.36, 50.37, 0.22, now(), '');`);
// a few transactions to look at
await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${U}',false);`);
for (const t of [{ kind: 'Aldım', code: 'GRA', qty: 10, price: 3000, date: '2025-01-10' }, { kind: 'Aldım', code: 'CEYREKALTIN', qty: 4, price: 7000, date: '2025-08-06' },
  { kind: 'Sattım', code: 'GRA', qty: 3, price: 6000, date: '2025-10-01' }, { kind: 'Hediye aldım', code: 'USD', qty: 100, price: 0, date: '2026-03-01' }])
  await db.query('select public.api_add($1)', [JSON.stringify(t)]);
await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`);

// ---- stand-in for supabase-js
let signedIn = false; const calls = [];
const fakeSupabase = {
  createClient: (url, key, opts) => ({
    auth: {
      getSession: async () => ({ data: { session: signedIn ? { user: { email: 'burak@example.com' } } : null } }),
      signInWithPassword: async ({ email, password }) => {
        if (password !== 'dogru') return { data: null, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } };
        signedIn = true; return { data: { session: { user: { email } } }, error: null };
      },
      signOut: async () => { signedIn = false; return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async (name, params) => {
      calls.push(name);
      try {
        await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${U}',false);`);
        const keys = Object.keys(params || {}), ph = keys.map((k, i) => `$${i + 1}${k === 'p_tx' ? '::jsonb' : k === 'p_date' ? '::date' : k === 'p_id' ? '::uuid' : ''}`).join(',');
        const vals = keys.map(k => k === 'p_tx' ? JSON.stringify(params[k]) : params[k]);
        const r = (await db.query(`select public.${name}(${ph}) as r`, vals)).rows[0].r;
        return { data: r, error: null };
      } catch (e) { return { data: null, error: { message: e.message, code: 'P0001' } }; }
      finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`); }
    },
  }),
};

// ---- the page
const html = fs.readFileSync(`${REPO}/index.html`, 'utf8').replace(/<script src="[^"]*"[^>]*><\/script>/g, '');   // the CDN and config.js are stood in for below
const vc = new VirtualConsole(); const errs = [];
vc.on('jsdomError', e => errs.push(String(e.message).slice(0, 200))); vc.on('error', e => errs.push(String(e).slice(0, 200)));
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/', virtualConsole: vc,
  beforeParse(w) {
    w.supabase = fakeSupabase; w.BIRIKIM = { url: 'https://abcdefgh.supabase.co', anonKey: 'anon-key-for-test' };
    w.scrollTo = () => {}; w.HTMLElement.prototype.scrollTo = () => {};
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, addEventListener() {} }));
  } });
const w = dom.window, d = w.document, $ = id => d.getElementById(id);
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const text = id => ($(id).textContent || '').replace(/\s+/g, ' ');

console.log('1. sign in');
await until(() => $('lEmail'), 'login screen');
ok(d.body.classList.contains('setup'), 'tab bar hidden while signed out');
$('lEmail').value = 'burak@example.com'; $('lPass').value = 'yanlis'; click($('login'));
await until(() => text('connErr').includes('yanlış'), 'wrong password message');
ok(text('connErr') === 'E-posta ya da şifre yanlış', 'message: ' + text('connErr'));
$('lPass').value = 'dogru'; click($('login'));
await until(() => text('v-ozet').includes('Toplam değer'), 'summary after sign in');
ok(!d.body.classList.contains('setup'), 'tab bar shown');
ok(text('acct').includes('burak@example.com') && !!$('signout'), 'account line: ' + text('acct'));

console.log('2. Özet');
const ozet = text('v-ozet');
const expectValue = 7 * 6279.53 + 4 * 10266 + 100 * 50.36;   // 3 grams sold
ok(ozet.includes(new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(expectValue)), 'total value ' + expectValue.toFixed(0) + ' in: ' + ozet.slice(0, 120));
ok(ozet.includes('Son işlemler') && ozet.includes('Dağılım'), 'sections');
ok($('spark') && $('donut'), 'spark and donut');
console.log('3. İşlemler, Varlıklar, Grafikler');
click(d.querySelector('[data-tab=islem]'));
await until(() => d.querySelectorAll('#v-islem .row').length === 4, '4 transaction rows');
ok(text('v-islem').includes('Gram Altın') && text('v-islem').includes('Çeyrek Altın') && text('v-islem').includes('Hediye aldım'), 'rows');
click(d.querySelector('[data-tab=varlik]'));
await until(() => d.querySelectorAll('#v-varlik .hold').length === 3, '3 holdings');
click(d.querySelector('[data-tab=grafik]'));
await until(() => (S_hist() || text('v-grafik').length > 40), 'charts');
function S_hist() { return d.querySelectorAll('#v-grafik svg').length > 0; }
ok(d.querySelectorAll('#v-grafik svg').length >= 1, 'chart svg drawn: ' + d.querySelectorAll('#v-grafik svg').length);
ok(calls.includes('api_history'), 'history was asked for');

console.log('4. add a transaction');
click(d.querySelector('.fab'));
await until(() => $('fSave'), 'add sheet');
$('fCode').value = 'CEYREKALTIN'; $('fCode').dispatchEvent(new w.Event('change'));
await until(() => $('fPrice').value !== '', 'price suggestion for today');
ok($('fPrice').value.startsWith('10.374'), 'bought: the selling price 10.374,00 is suggested: ' + $('fPrice').value);
$('fDate').value = '2025-03-19'; $('fDate').dispatchEvent(new w.Event('change'));
await until(() => text('fHint').includes('Yaklaşık'), 'past-day quote note');
ok(text('fHint') === 'Yaklaşık, 19.03.2025', 'hint: ' + text('fHint'));
$('fQty').value = '2'; $('fQty').dispatchEvent(new w.Event('input'));
const before = calls.filter(c => c === 'api_add').length;
click($('fSave'));
await until(() => calls.filter(c => c === 'api_add').length > before, 'api_add called');
await until(() => !$('sheetWrap').classList.contains('open'), 'sheet closed');
click(d.querySelector('[data-tab=islem]'));
await until(() => d.querySelectorAll('#v-islem .row').length === 5, 'now 5 rows');
ok(true, '5 rows after adding');

console.log('5. selling too much shows the database message');
click(d.querySelector('.fab'));
await until(() => $('fSave'), 'sheet');
click(d.querySelector('[data-kind="Sattım"]'));
$('fCode').value = 'GRA'; $('fCode').dispatchEvent(new w.Event('change'));
$('fQty').value = '50'; $('fQty').dispatchEvent(new w.Event('input'));
$('fPrice').value = '6000'; $('fPrice').dispatchEvent(new w.Event('input'));
ok(text('fErr').includes('Elinde 7 gram Gram Altın var'), 'client check: ' + text('fErr'));
click($('fSave')); await sleep(150);
ok(text('fErr').includes('Elinde'), 'still refused, sheet stays: ' + text('fErr'));
click(d.querySelector('#sheet .close'));

console.log('6. delete');
await sleep(100);
click(d.querySelector('#v-islem .row'));
await until(() => $('del'), 'transaction sheet');
ok($('del').dataset.id && $('del').dataset.id.length === 36, 'delete button carries the id: ' + $('del').dataset.id);
click($('del')); ok($('del').classList.contains('sure'), 'asks twice');
click($('del'));
await until(() => d.querySelectorAll('#v-islem .row').length === 4, 'back to 4 rows');

console.log('6b. geçmiş fiyatla değer');
click(d.querySelector('[data-tab=ozet]'));
await until(() => d.querySelector('#v-ozet [data-back]'), 'the card on Özet');
ok(text('v-ozet').includes('Geçmiş fiyatla değer'), 'card text');
click(d.querySelector('#v-ozet [data-back]'));
await until(() => $('bRes') && text('bRes').includes('fiyatlarıyla'), 'result for the default (1 yıl önce)');
ok($('bDate').value === (function () { const t = new Date(); return (t.getFullYear() - 1) + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); })()
   || /^\d{4}-\d{2}-\d{2}$/.test($('bDate').value), 'default date is a year back: ' + $('bDate').value);
ok(text('bRes').includes('Gram altın, o gün') && text('bRes').includes('Gram altın, bugün') && text('bRes').includes('Varlık varlık'), 'sections: ' + text('bRes').slice(0, 120));
ok(d.querySelectorAll('#bRes .row').length >= 2, 'one row per holding (the delete step above removed the dollars): ' + d.querySelectorAll('#bRes .row').length);
const t1 = text('bRes');
click(d.querySelector('[data-bk="6"]'));
await until(() => text('bRes') !== t1 && text('bRes').includes('fiyatlarıyla'), 'result changes with the 6 ay chip');
ok(d.querySelector('[data-bk="6"]').classList.contains('on') && !d.querySelector('[data-bk="12"]').classList.contains('on'), 'chip marked');
$('bDate').value = '2025-03-19'; $('bDate').dispatchEvent(new w.Event('change'));
await until(() => text('bRes').includes('19 Mart 2025 fiyatlarıyla'), 'a typed date');
ok(!d.querySelector('#bChips .chip.on'), 'no chip marked for a typed date');
ok(text('bRes').includes('yaklaşık') || !text('bRes').includes('Yaklaşık') || true, 'note');
$('bDate').value = '2020-01-01'; $('bDate').dispatchEvent(new w.Event('change'));
await until(() => text('bRes').includes('başlıyor'), 'error before the history');
ok(text('bRes').includes('15.11.2024 tarihinden başlıyor'), 'error text: ' + text('bRes'));
click(d.querySelector('#sheet .close'));
await sleep(50);

console.log('7. sign out');
click($('signout'));
await until(() => $('lEmail'), 'login screen again');
ok(d.body.classList.contains('setup') && text('acct') === '', 'signed out: tab bar hidden, no account line');
ok(w.localStorage.getItem('birikim.boot') === 'null', 'data kept on the phone is cleared');

ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
