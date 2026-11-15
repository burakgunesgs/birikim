# Birikim (Güneş Ailesi)

Phone app for a family's savings in gold and currency. A static page (`index.html`, GitHub Pages) that signs in to
Supabase with e-mail and password; the data, the calculations and the price fetching live in `supabase/` (tables,
functions and Edge Functions). Setup, step by step, in Turkish: [supabase/README.md](supabase/README.md).

- `index.html` is the whole app and is edited here (it used to be built from the tv-vibehack project and served from
  Google Apps Script; that is retired once the move to Supabase is done).
- `config.js` holds the Supabase address and public key (fill in once, see supabase/README.md).
- `npm install && npm test` runs the tests (a local Postgres in memory; nothing is sent anywhere).
