#!/usr/bin/env node
// Turns the sheet "Hareketler" (File > Download > CSV) into SQL that loads it into Supabase.
//
//   node supabase/admin/sheet-to-sql.mjs hareketler.csv --household <uuid> [--locale tr|en] > transactions.sql
//
// The CSV has the sheet's columns: Kayıt zamanı, Tarih, İşlem, Kod, Varlık, Miktar, Birim fiyat (TL), Tutar (TL), Not.
// --locale says how the sheet wrote numbers: tr (default) 3.150,50 and en 3,150.50. Dates may be dd.MM.yyyy,
// dd/MM/yyyy or yyyy-MM-dd. Rows keep the sheet's order. A row that cannot be read is left out and listed on
// stderr by its row number (the sheet's, header = row 1), never by its content. Nothing is sent anywhere: the SQL
// goes to the standard output for you to read and run. Needs Node 18 or later.

import fs from "node:fs";

const KINDS = ["Aldım", "Sattım", "Hediye aldım", "Hediye verdim"];
const CODES = new Set(["GRA", "CEYREKALTIN", "YARIMALTIN", "TAMALTIN", "CUMHURIYETALTINI", "ATAALTIN", "RESATALTIN",
  "HAMITALTIN", "IKIBUCUKALTIN", "BESLIALTIN", "GREMSEALTIN", "YIA", "22AYAR", "18AYARALTIN", "14AYARALTIN", "HAS",
  "GUMUS", "USD", "EUR", "GBP", "CHF", "TRY"]);

/** CSV with quotes, doubled quotes and line breaks inside quotes. */
export function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const delim = (text.split("\n", 1)[0].match(/;/g) || []).length > (text.split("\n", 1)[0].match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x !== "")) rows.push(row); else rows.push(null);
      row = [];
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row.some((x) => x !== "") ? row : null); }
  return rows;   // null: an empty line (kept so the row numbers match the sheet)
}

/** "3.150,50 ₺" (tr) or "₺3,150.50" (en) -> 3150.5; NaN when it is not a number. */
export function parseNumber(s, locale = "tr") {
  s = String(s ?? "").replace(/[₺$€£\s ]|TL|TRY/gi, "");
  if (!s) return NaN;
  const [thousands, decimal] = locale === "en" ? [",", "."] : [".", ","];
  s = s.split(thousands).join("").replace(decimal, ".");
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** dd.MM.yyyy, dd/MM/yyyy or yyyy-MM-dd (an optional time after it) -> yyyy-MM-dd; null when it is not a date. */
export function parseDate(s) {
  s = String(s ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let y, mo, d;
  if (m) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/))) [d, mo, y] = [m[1].padStart(2, "0"), m[2].padStart(2, "0"), m[3]];
  else return null;
  const t = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === `${y}-${mo}-${d}` ? `${y}-${mo}-${d}` : null;
}

const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** The SQL and the rows that were left out ({row, why}). */
export function convert(csv, { household, locale = "tr" }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(household || "")) throw new Error("--household must be a uuid");
  const rows = parseCsv(csv);
  const out = [], skipped = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    if (n === 1 || !r) return;   // header, empty line
    const [, date, kind, code, , qtyS, priceS, , note] = r;
    const d = parseDate(date), qty = parseNumber(qtyS, locale), price = priceS === "" ? 0 : parseNumber(priceS, locale);
    const why = !d ? "date" : !KINDS.includes((kind || "").trim()) ? "kind" : !CODES.has((code || "").trim()) ? "code"
      : !(qty > 0) ? "qty" : !(price >= 0) ? "price" : null;
    if (why) { skipped.push({ row: n, why }); return; }
    out.push(`(${lit(household)}, ${lit(d)}, ${lit(kind.trim())}, ${lit(code.trim())}, ${qty}, ${price}, ${lit((note || "").slice(0, 120))})`);
  });
  const sql = out.length
    ? "insert into public.transactions (household_id, tx_date, kind, asset_code, qty, price, note) values\n" + out.join(",\n") + ";\n"
    : "-- nothing to load\n";
  return { sql, count: out.length, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--household" && args[args.indexOf(a) - 1] !== "--locale");
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (!file) { console.error("usage: sheet-to-sql.mjs hareketler.csv --household <uuid> [--locale tr|en]"); process.exit(2); }
  try {
    const { sql, count, skipped } = convert(fs.readFileSync(file, "utf8"), { household: opt("--household"), locale: opt("--locale") || "tr" });
    process.stdout.write(sql);
    console.error(`${count} transactions` + (skipped.length ? `, ${skipped.length} left out: ` + skipped.map((s) => `row ${s.row} (${s.why})`).join(", ") : ""));
  } catch (e) { console.error(e.message); process.exit(1); }
}
