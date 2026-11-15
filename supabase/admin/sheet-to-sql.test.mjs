// Run: node --test supabase/admin/sheet-to-sql.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { convert, parseCsv, parseDate, parseNumber } from "./sheet-to-sql.mjs";

const H = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const HEAD = "Kayıt zamanı,Tarih,İşlem,Kod,Varlık,Miktar,Birim fiyat (TL),Tutar (TL),Not";

test("numbers the Turkish and the English way", () => {
  assert.equal(parseNumber("3.150,50 ₺"), 3150.5);
  assert.equal(parseNumber("2,5"), 2.5);
  assert.equal(parseNumber("1.234"), 1234);          // tr: a dot groups thousands
  assert.equal(parseNumber("₺3,150.50", "en"), 3150.5);
  assert.equal(parseNumber("2.5", "en"), 2.5);
  assert.ok(Number.isNaN(parseNumber("")));
  assert.ok(Number.isNaN(parseNumber("abc")));
});

test("dates", () => {
  assert.equal(parseDate("05.03.2025"), "2025-03-05");
  assert.equal(parseDate("5/3/2025"), "2025-03-05");
  assert.equal(parseDate("2025-03-05 12:00:00"), "2025-03-05");
  assert.equal(parseDate("31.02.2025"), null);
  assert.equal(parseDate("hello"), null);
});

test("csv: quotes, doubled quotes, line breaks in a note, semicolons", () => {
  const rows = parseCsv('a,b\n"x, y","he said ""hi"""\n"line\nbreak",z\n');
  assert.deepEqual(rows, [["a", "b"], ["x, y", 'he said "hi"'], ["line\nbreak", "z"]]);
  assert.deepEqual(parseCsv("a;b\n1,5;2\n"), [["a", "b"], ["1,5", "2"]]);
});

test("converts rows in the sheet's order and lists what it leaves out by row number", () => {
  const csv = [HEAD,
    '15.11.2026 10:00:00,10.01.2025,Aldım,GRA,Gram Altın,"10","3.000,00 ₺","30.000,00 ₺",ilk',
    ",,,,,,,,",
    `15.11.2026 10:01:00,10.06.2025,Sattım,GRA,Gram Altın,"2,5","6.000,50",,"it's a note"`,
    '15.11.2026 10:02:00,01.09.2025,Yedim,GRA,Gram Altın,1,1,,',
    '15.11.2026 10:03:00,31.02.2025,Aldım,GRA,Gram Altın,1,1,,',
    '15.11.2026 10:04:00,01.09.2025,Aldım,XYZ,Bilinmeyen,1,1,,',
    '15.11.2026 10:05:00,01.09.2025,Aldım,USD,Dolar,0,1,,',
    '15.11.2026 10:06:00,02.09.2025,Hediye aldım,USD,Dolar,100,,,',
  ].join("\n");
  const { sql, count, skipped } = convert(csv, { household: H });
  assert.equal(count, 3);
  assert.deepEqual(skipped.map((s) => `${s.row}:${s.why}`), ["5:kind", "6:date", "7:code", "8:qty"]);
  const lines = sql.trim().split("\n");
  assert.match(lines[0], /^insert into public\.transactions/);
  assert.match(lines[1], /'2025-01-10', 'Aldım', 'GRA', 10, 3000, 'ilk'\),$/);
  assert.match(lines[2], /'2025-06-10', 'Sattım', 'GRA', 2\.5, 6000\.5, 'it''s a note'\),$/);   // quote doubled
});

test("refuses a household that is not a uuid", () => {
  assert.throws(() => convert(HEAD, { household: "1; drop table x" }), /uuid/);
});
