-- Birikim: the calculations and the functions the app calls (a port of Code.gs, with the same answers).
--
-- The app calls only the api_* functions (supabase.rpc). They return the same JSON the Apps Script web app did,
-- except that a transaction is told apart by "id" (a uuid) instead of "row".
-- Reading goes through RLS; adding and deleting are security definer so the rules (the household, enough held to
-- sell) are checked in one place and nobody can write to the tables directly.

create function app.today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Europe/Istanbul')::date;
$$;

-- ---- replay ---------------------------------------------------------------------------------------------------

-- What was held per asset with its cost (average cost method), and the gain made by selling, from the transactions
-- up to a date (all when null). A gift received counts at the price entered for it (0 if none); a gift given leaves
-- at cost. Selling more than is held takes only what is held. One row per asset that has transactions.
create function app.replay(p_household uuid, p_until date default null)
returns table (code text, qty numeric, cost numeric, realized numeric, first_seq bigint)
language plpgsql stable set search_path = '' as $$
declare
  r record;
  cur text;
  q numeric := 0; c numeric := 0; rz numeric := 0; fs bigint := 0;
  avg numeric; take numeric;
begin
  for r in
    select t.asset_code, t.kind, t.qty as tq, t.price as tp, t.seq
    from public.transactions t
    where t.household_id = p_household and (p_until is null or t.tx_date <= p_until)
    order by t.asset_code, t.tx_date, t.seq
  loop
    if cur is distinct from r.asset_code then
      if cur is not null then
        code := cur; qty := q; cost := c; realized := rz; first_seq := fs;
        return next;
      end if;
      cur := r.asset_code; q := 0; c := 0; rz := 0; fs := r.seq;
    end if;
    fs := least(fs, r.seq);
    avg := case when q > 0 then c / q else 0 end;
    if r.kind in ('Aldım', 'Hediye aldım') then
      q := q + r.tq;
      c := c + r.tq * r.tp;
    else
      take := least(r.tq, q);
      if r.kind = 'Sattım' then rz := rz + take * (r.tp - avg); end if;
      q := q - take;
      c := c - take * avg;
    end if;
  end loop;
  if cur is not null then
    code := cur; qty := q; cost := c; realized := rz; first_seq := fs;
    return next;
  end if;
end;
$$;

-- What is held now. The TV reads exactly this: keep its fields (updated, holdings[code,name,unit,qty,cost], realized, count).
create function app.summary(p_household uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'updated', (extract(epoch from now()) * 1000)::bigint,
    'holdings', coalesce((
      select jsonb_agg(jsonb_build_object('code', r.code, 'name', a.name, 'unit', a.unit,
                                          'qty', round(r.qty, 4), 'cost', round(r.cost, 2)) order by r.first_seq)
      from app.replay(p_household) r join public.assets a on a.code = r.code
      where r.qty > 1e-9), '[]'::jsonb),
    'realized', round(coalesce((select sum(r.realized) from app.replay(p_household) r), 0), 2),
    'count', (select count(*) from public.transactions t where t.household_id = p_household));
$$;

-- Buying and selling price per asset code (TRY = 1), when they were fetched.
create function app.prices_json() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
           'TRY', jsonb_build_object('buy', 1, 'sell', 1, 'change', 0),
           'updated', coalesce(max(feed_updated), ''),
           'fetchedAt', coalesce((extract(epoch from max(fetched_at)) * 1000)::bigint, 0))
         || coalesce(jsonb_object_agg(code, jsonb_build_object('buy', buy, 'sell', sell, 'change', change)), '{}'::jsonb)
  from public.prices_latest;
$$;

create function app.assets_json() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'unit', unit, 'group', grp) order by sort), '[]'::jsonb)
  from public.assets;
$$;

-- ---- called from the app --------------------------------------------------------------------------------------

-- Holdings, all transactions (newest first), the last good prices and the asset list.
create function public.api_boot() returns jsonb
language plpgsql stable set search_path = '' as $$
declare h uuid := app.my_household();
begin
  if h is null then raise exception 'Hesabın bir aileye bağlı değil'; end if;
  return jsonb_build_object(
    'summary', app.summary(h),
    'prices', app.prices_json(),
    'assets', app.assets_json(),
    'transactions', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'date', to_char(t.tx_date, 'YYYY-MM-DD'), 'kind', t.kind,
                                          'code', t.asset_code, 'name', a.name, 'qty', t.qty, 'price', t.price,
                                          'note', t.note) order by t.tx_date desc, t.seq desc)
      from public.transactions t join public.assets a on a.code = t.asset_code
      where t.household_id = h), '[]'::jsonb));
end;
$$;

-- The last good prices (the fetch-prices function keeps them fresh).
create function public.api_prices() returns jsonb
language sql stable set search_path = '' as $$
  select app.prices_json();
$$;

-- A buying and selling price for an asset on a date, to start the form from when an old purchase is entered.
-- Today: the live price. Past: that day's price, or the last one before it (up to ten days back).
create function public.api_price_at(p_code text, p_date date) returns jsonb
language plpgsql stable set search_path = '' as $$
declare r record;
begin
  if p_date is null or p_date >= app.today() then
    select buy, sell into r from public.prices_latest where code = p_code;
    if not found then return null; end if;
    return jsonb_build_object('buy', r.buy, 'sell', r.sell, 'note', 'Kapalıçarşı, şimdi');
  end if;
  if p_code = 'TRY' then return jsonb_build_object('buy', 1, 'sell', 1, 'note', ''); end if;
  select day, buy, sell, source, estimated into r from public.price_history
  where code = p_code and day <= p_date and day >= p_date - 10 order by day desc limit 1;
  if not found then raise exception 'Bu tarih için fiyat yok'; end if;
  return jsonb_build_object('buy', r.buy, 'sell', r.sell, 'note',
    case when r.source = 'tcmb' then 'TCMB efektif kur, '
         when r.estimated then 'Yaklaşık, '
         else 'Kapalıçarşı, ' end || to_char(r.day, 'DD.MM.YYYY'));
end;
$$;

-- One point per month from the first transaction: what was held at the month's end (today for this month), what it
-- was worth then (at the buying price of that day; at cost when there is no price), what it had cost, the gains
-- made by selling so far, and what was bought, sold and given that month. approx is true when a price was an estimate.
create function public.api_history() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  h uuid := app.my_household();
  today date := app.today();
  this_month date := date_trunc('month', app.today())::date;
  first_day date;
  m date; e date;
  months jsonb := '[]'::jsonb;
  approx boolean := false;
  r record; p numeric; est boolean;
  v numeric; c numeric; rz numeric; bought numeric; sold numeric; gifts numeric;
begin
  if h is null then raise exception 'Hesabın bir aileye bağlı değil'; end if;
  select min(tx_date) into first_day from public.transactions where household_id = h;
  if first_day is null then return jsonb_build_object('months', '[]'::jsonb, 'approx', false); end if;
  m := date_trunc('month', first_day)::date;
  while m <= this_month loop
    e := case when m = this_month then today else (m + interval '1 month' - interval '1 day')::date end;
    v := 0; c := 0; rz := 0;
    for r in select * from app.replay(h, e) loop
      rz := rz + r.realized;
      if r.qty <= 1e-9 then continue; end if;
      c := c + r.cost;
      p := null; est := false;
      if r.code = 'TRY' then
        p := 1;
      elsif e >= today then
        select buy into p from public.prices_latest where code = r.code;
      else
        select ph.buy, ph.estimated into p, est from public.price_history ph
        where ph.code = r.code and ph.day <= e and ph.day >= e - 10 order by ph.day desc limit 1;
      end if;
      v := v + case when p is null then r.cost else r.qty * p end;
      if est then approx := true; end if;
    end loop;
    select coalesce(sum(t.qty * t.price) filter (where t.kind = 'Aldım'), 0),
           coalesce(sum(t.qty * t.price) filter (where t.kind = 'Sattım'), 0),
           coalesce(sum(t.qty * t.price) filter (where t.kind = 'Hediye aldım'), 0)
      into bought, sold, gifts
      from public.transactions t
      where t.household_id = h and t.tx_date >= m and t.tx_date < (m + interval '1 month')::date;
    months := months || jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'value', round(v, 0), 'cost', round(c, 0),
      'realized', round(rz, 0), 'bought', round(bought, 0), 'sold', round(sold, 0), 'gifts', round(gifts, 0));
    m := (m + interval '1 month')::date;
  end loop;
  return jsonb_build_object('approx', approx, 'months', months);
end;
$$;

-- Adds a transaction; answers like api_boot. p_tx: {kind, code, qty, price, date (yyyy-mm-dd), note}.
create function public.api_add(p_tx jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  h uuid := app.my_household();
  a record;
  k text := p_tx ->> 'kind';
  q numeric; pr numeric; d date; held numeric;
begin
  if auth.uid() is null or h is null then raise exception 'Yetkisiz'; end if;
  select * into a from public.assets where code = p_tx ->> 'code';
  if not found then raise exception 'Bilinmeyen varlık'; end if;
  if k is null or k not in ('Aldım', 'Sattım', 'Hediye aldım', 'Hediye verdim') then raise exception 'Bilinmeyen işlem'; end if;
  begin
    q := (p_tx ->> 'qty')::numeric;
    pr := coalesce(nullif(p_tx ->> 'price', '')::numeric, 0);
    d := coalesce(nullif(p_tx ->> 'date', '')::date, app.today());
  exception when others then
    raise exception 'Miktar, fiyat ya da tarih okunamadı';
  end;
  if not (q > 0) then raise exception 'Miktar sıfırdan büyük olmalı'; end if;
  if pr < 0 then raise exception 'Fiyat negatif olamaz'; end if;
  if d > app.today() then raise exception 'Tarih bugünden ileri olamaz'; end if;
  -- two phones saving at once must not both pass the "enough held" check
  perform pg_advisory_xact_lock(hashtextextended(h::text || a.code, 0));
  if k in ('Sattım', 'Hediye verdim') then
    select coalesce(sum(r.qty), 0) into held from app.replay(h) r where r.code = a.code;
    if q > held + 1e-9 then
      raise exception 'Elinde % % % var', trim_scale(round(held, 4))::text, a.unit, a.name;
    end if;
  end if;
  insert into public.transactions (household_id, tx_date, kind, asset_code, qty, price, note, created_by)
  values (h, d, k, a.code, q, pr, left(coalesce(p_tx ->> 'note', ''), 120), auth.uid());
  return public.api_boot();
end;
$$;

-- Deletes a transaction of the signed-in user's household; answers like api_boot.
create function public.api_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare h uuid := app.my_household();
begin
  if auth.uid() is null or h is null then raise exception 'Yetkisiz'; end if;
  delete from public.transactions where id = p_id and household_id = h;
  if not found then raise exception 'Kayıt bulunamadı'; end if;
  return public.api_boot();
end;
$$;

-- The TV's view: the holdings of a household, for the tv-holdings Edge Function (service role only).
create function public.api_tv_holdings(p_household uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select app.summary(p_household);
$$;

-- ---- who may call what ----------------------------------------------------------------------------------------

revoke execute on all functions in schema app from public, anon;
grant execute on function app.today(), app.prices_json(), app.assets_json(),
  app.replay(uuid, date), app.summary(uuid) to authenticated, service_role;

revoke execute on function public.api_boot(), public.api_prices(), public.api_price_at(text, date), public.api_history(),
  public.api_add(jsonb), public.api_delete(uuid), public.api_tv_holdings(uuid) from public, anon, authenticated;
grant execute on function public.api_boot(), public.api_prices(), public.api_price_at(text, date), public.api_history(),
  public.api_add(jsonb), public.api_delete(uuid) to authenticated;
grant execute on function public.api_tv_holdings(uuid) to service_role;
