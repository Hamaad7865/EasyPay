-- 0124: a service charge up to 30 % is taken by the server.
--
-- The back office (settings page), the tablet (Settings > Receipt) and
-- settings.save (0096) all take a service charge from 0 to 30 %. The till
-- sends it in basis points (25 % is 2500), and push_receipt_create has
-- refused anything above 2000 since 0021 (bad-payload). So a restaurant whose
-- service charge was set above 20 % had every table sale refused by the
-- server: the till printed the receipt and took the money, the server kept
-- nothing of it (found by the restaurant review of 2026-10-20).
--
-- Only that one limit changes, to the settings' own 30 %. The live definition
-- (last written by 0123_addons_per_item.sql) is read and the limit replaced
-- in it, so nothing else of the function is written again; the migration
-- stops if the line is not found exactly once.

do $$
declare
  v_def text;
  v_old constant text := 'if v_pct < 0 or v_pct > 2000 then raise exception ''bad-payload''; end if;';
  v_new constant text := 'if v_pct < 0 or v_pct > 3000 then raise exception ''bad-payload''; end if;';
begin
  select pg_get_functiondef('public.push_receipt_create(uuid, uuid, jsonb)'::regprocedure) into v_def;
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception '0124: the service charge limit was not found exactly once in push_receipt_create';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;
