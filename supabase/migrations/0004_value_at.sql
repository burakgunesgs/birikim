-- Birikim: "what would what I hold now have been worth on that day?"
--
-- What is held now, valued at the buying prices of a past day (the price history), next to its value now.
-- Same way of valuing as the app: quantity x buying price; TRY is 1; a holding that has no price now is counted
-- at cost. A holding with no price on that day is left out of both totals (and listed), so the two are compared
-- on the same things. approx is true when one of the past prices is an estimate (see supabase/seed/README.md).

create function public.api_value_at(p_date date) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  h uuid := app.my_household();
  today date := app.today();
  first_day date;
  r record;
  np numeric; tp numeric; est boolean; pday date;
  vnow numeric; vthen numeric;
  total_now numeric := 0; total_then numeric := 0;
  items jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb;
  approx boolean := false;
  g_then numeric; g_now numeric;
begin
  if h is null then raise exception 'Hesabın bir aileye bağlı değil'; end if;
  if p_date is null or p_date > today then raise exception 'Geçmiş bir tarih seç'; end if;
  select min(day) into first_day from public.price_history;
  if first_day is null or p_date < first_day then
    raise exception 'Fiyat geçmişi % tarihinden başlıyor', to_char(first_day, 'DD.MM.YYYY');
  end if;

  for r in
    select rp.code, rp.qty, rp.cost, a.name, a.unit
    from app.replay(h) rp join public.assets a on a.code = rp.code
    where rp.qty > 1e-9 order by a.sort
  loop
    if r.code = 'TRY' then
      np := 1; tp := 1; est := false; pday := p_date;
    else
      select buy into np from public.prices_latest where code = r.code;
      select ph.buy, ph.estimated, ph.day into tp, est, pday from public.price_history ph
      where ph.code = r.code and ph.day <= p_date and ph.day >= p_date - 10 order by ph.day desc limit 1;
    end if;
    if tp is null then
      skipped := skipped || jsonb_build_object('code', r.code, 'name', r.name);
      continue;
    end if;
    vnow := case when np is null then r.cost else r.qty * np end;
    vthen := r.qty * tp;
    total_now := total_now + vnow;
    total_then := total_then + vthen;
    if est then approx := true; end if;
    items := items || jsonb_build_object('code', r.code, 'name', r.name, 'unit', r.unit, 'qty', round(r.qty, 4),
      'then_price', tp, 'now_price', np, 'then_value', round(vthen, 2), 'now_value', round(vnow, 2), 'estimated', est);
  end loop;

  select ph.buy into g_then from public.price_history ph
    where ph.code = 'GRA' and ph.day <= p_date order by ph.day desc limit 1;
  select buy into g_now from public.prices_latest where code = 'GRA';

  return jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'then_total', round(total_then, 2),
    'now_total', round(total_now, 2),
    'diff', round(total_now - total_then, 2),
    'pct', case when total_then > 0 then round((total_now - total_then) / total_then * 100, 2) else 0 end,
    'approx', approx,
    'gram', jsonb_build_object('then', g_then, 'now', g_now),
    'items', items,
    'skipped', skipped,
    'history_from', to_char(first_day, 'YYYY-MM-DD'));
end;
$$;

revoke execute on function public.api_value_at(date) from public, anon, authenticated;
grant execute on function public.api_value_at(date) to authenticated;
