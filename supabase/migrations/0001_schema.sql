-- Birikim (Güneş Ailesi): tables, access rules.
--
-- Who sees what:
--   * Every signed-in user reads the asset list and the prices.
--   * Transactions belong to a household. A user sees only the households they are a member of, and cannot write to
--     any table directly: adding and deleting go through api_add / api_delete (0002_logic.sql), which check the rules.
--   * Prices are written only by the fetch-prices Edge Function (service role).

create schema if not exists app;   -- internal helpers, not exposed by the API

-- ---- assets ---------------------------------------------------------------------------------------------------

-- What can be saved. Codes are the price feed's (price_code: priced as another code). TRY is cash in lira and has
-- no price rows: it is always 1.
create table public.assets (
  code       text primary key,
  name       text not null,
  unit       text not null,
  grp        text not null check (grp in ('Altın', 'Döviz', 'Nakit', 'Diğer')),
  price_code text references public.assets (code),
  sort       int  not null
);

insert into public.assets (code, name, unit, grp, price_code, sort) values
  ('GRA',              'Gram Altın',        'gram', 'Altın', null,  1),
  ('CEYREKALTIN',      'Çeyrek Altın',      'adet', 'Altın', null,  2),
  ('YARIMALTIN',       'Yarım Altın',       'adet', 'Altın', null,  3),
  ('TAMALTIN',         'Tam Altın',         'adet', 'Altın', null,  4),
  ('CUMHURIYETALTINI', 'Cumhuriyet Altını', 'adet', 'Altın', null,  5),
  ('ATAALTIN',         'Ata Altın',         'adet', 'Altın', null,  6),
  ('RESATALTIN',       'Reşat Altın',       'adet', 'Altın', null,  7),
  ('HAMITALTIN',       'Hamit Altın',       'adet', 'Altın', null,  8),
  ('IKIBUCUKALTIN',    'İkibuçuk',          'adet', 'Altın', null,  9),
  ('BESLIALTIN',       'Beşli',             'adet', 'Altın', null, 10),
  ('GREMSEALTIN',      'Gremse',            'adet', 'Altın', null, 11),
  ('YIA',              '22 Ayar Bilezik',   'gram', 'Altın', null, 12),
  ('18AYARALTIN',      '18 Ayar',           'gram', 'Altın', null, 14),
  ('14AYARALTIN',      '14 Ayar',           'gram', 'Altın', null, 15),
  ('HAS',              'Has Altın',         'gram', 'Altın', null, 16),
  ('GUMUS',            'Gümüş',             'gram', 'Diğer', null, 17),
  ('USD',              'Dolar',             '$',    'Döviz', null, 18),
  ('EUR',              'Euro',              '€',    'Döviz', null, 19),
  ('GBP',              'Sterlin',           '£',    'Döviz', null, 20),
  ('CHF',              'İsviçre Frangı',    'CHF',  'Döviz', null, 21),
  ('TRY',              'Türk Lirası',       '₺',    'Nakit', null, 22);
-- 22 Ayar Gram is priced as 22 Ayar Bilezik (inserted after it, as it points at it)
insert into public.assets (code, name, unit, grp, price_code, sort)
  values ('22AYAR', '22 Ayar Gram', 'gram', 'Altın', 'YIA', 13);

-- ---- households -----------------------------------------------------------------------------------------------

create table public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index household_members_user on public.household_members (user_id);

-- Both helpers are security definer so the policies below can use them without recursing into the same table.
create function app.is_member(p_household uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members m
                 where m.household_id = p_household and m.user_id = auth.uid());
$$;

-- The household of the signed-in user (the oldest membership when there are several).
create function app.my_household() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.household_id from public.household_members m
  where m.user_id = auth.uid() order by m.created_at, m.household_id limit 1;
$$;

-- ---- transactions ---------------------------------------------------------------------------------------------

-- One row per transaction, as in the sheet "Hareketler". seq keeps the entry order within a day.
create table public.transactions (
  id           uuid primary key default gen_random_uuid(),
  seq          bigint generated always as identity,
  household_id uuid not null references public.households (id) on delete cascade,
  tx_date      date not null,
  kind         text not null check (kind in ('Aldım', 'Sattım', 'Hediye aldım', 'Hediye verdim')),
  asset_code   text not null references public.assets (code),
  qty          numeric not null check (qty > 0),
  price        numeric not null default 0 check (price >= 0),
  note         text not null default '',
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index transactions_household on public.transactions (household_id, tx_date, seq);
create index transactions_asset on public.transactions (household_id, asset_code, tx_date, seq);

-- ---- prices ---------------------------------------------------------------------------------------------------

-- The last good price per asset (buying: what a dealer pays you; selling: what you pay).
create table public.prices_latest (
  code         text primary key references public.assets (code),
  buy          numeric not null check (buy > 0),
  sell         numeric not null check (sell > 0),
  change       numeric not null default 0,       -- daily change in percent
  fetched_at   timestamptz not null,
  feed_updated text not null default ''          -- the feed's own "Update_Date"
);

-- One buying and selling price per asset per day. estimated: worked out from other data, not seen on that day.
-- source: kapalicarsi / truncgil (the feed), kuyumaltin (a gold archive), tcmb (Central Bank banknote rate),
-- yahoo_tahmin and oran_tahmin (estimates), devir (carried over from the last day with a price).
create table public.price_history (
  day       date not null,
  code      text not null references public.assets (code),
  buy       numeric not null check (buy > 0),
  sell      numeric not null check (sell > 0),
  source    text not null,
  estimated boolean not null default false,
  primary key (code, day)
);

-- ---- access ---------------------------------------------------------------------------------------------------

alter table public.assets            enable row level security;
alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.transactions      enable row level security;
alter table public.prices_latest     enable row level security;
alter table public.price_history     enable row level security;

create policy assets_read     on public.assets            for select to authenticated using (true);
create policy prices_read     on public.prices_latest     for select to authenticated using (true);
create policy history_read    on public.price_history     for select to authenticated using (true);
create policy households_read on public.households        for select to authenticated using (app.is_member(id));
create policy members_read    on public.household_members for select to authenticated using (app.is_member(household_id));
create policy tx_read         on public.transactions      for select to authenticated using (app.is_member(household_id));

-- Supabase hands new tables to everyone by default: take it all back, then give reading to signed-in users.
revoke all on public.assets, public.households, public.household_members, public.transactions,
              public.prices_latest, public.price_history from anon, authenticated;
grant select on public.assets, public.households, public.household_members, public.transactions,
                public.prices_latest, public.price_history to authenticated;

revoke all on schema app from public, anon;
grant usage on schema app to authenticated, service_role;
revoke execute on function app.is_member(uuid), app.my_household() from public, anon;
grant execute on function app.is_member(uuid), app.my_household() to authenticated, service_role;
