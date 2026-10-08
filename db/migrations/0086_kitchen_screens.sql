-- 0086: a kitchen screen is a printer row of kind "screen".
--
-- The owner asked for "a configurable kitchen on another screen": a till, and
-- a tablet in the kitchen that shows each order when Send to kitchen is
-- pressed. They chose the restaurant's own Wi-Fi as the way there (it works
-- with the internet down and costs nothing a month): the till opens a short
-- connection to the kitchen tablet, as it does to a printer. So a screen sits
-- where the printers sit, and is set up where they are, in the back office
-- under Printers:
--
--   kind       'screen', beside 'network' and 'usb'
--   address    the tablet's address on the Wi-Fi, as the tablet shows it
--              (ip, or ip:port; the till uses port 9310 when none is given)
--   pair_code  the code the tablet shows. The till signs what it sends with
--              it, and the tablet answers nothing else, so that someone who
--              only knows the address cannot put an order on the screen.
--   all_items  the screen shows every item of an order. Otherwise it shows
--              the items of the categories that tick it (categories.printer_ids,
--              which already takes any of the tenant's printer rows).
--
-- A screen is somewhere to show, never somewhere to print: it cannot be the
-- receipt printer, and it has both its address and its code or it is not a
-- screen.
--
-- It is part of the premium tier (0085). A row may become a working screen
-- only for a restaurant whose plan carries it. One that already is a working
-- screen is left alone whatever else is written to it, and can be switched off
-- or removed, so a restaurant whose plan went down is not left with a row it
-- cannot touch. Switched off, it comes back on only with the plan.
--
-- A pull hands out whole rows, so tills are sent the two new columns with no
-- change to sync_pull. A till older than the build that knows screens keeps a
-- printer's kind as whatever it is sent and takes anything that is not USB
-- for a network printer: it would send printer bytes to the tablet. In
-- production the first screen is therefore entered only once that build is
-- required (MIN_TILL_VERSION).

alter table printers drop constraint if exists printers_kind_check;
alter table printers add constraint printers_kind_check check (kind in ('network', 'usb', 'screen'));
alter table printers add column if not exists pair_code text;
alter table printers add column if not exists all_items boolean not null default false;

alter table printers drop constraint if exists printers_screen_check;
alter table printers add constraint printers_screen_check
  check (kind <> 'screen' or (not is_receipt and pair_code is not null and btrim(pair_code) <> '' and address is not null and btrim(address) <> ''));

create or replace function printers_screen_plan() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if new.kind = 'screen' and new.is_active and new.deleted_at is null
     and (tg_op = 'INSERT' or not (old.kind = 'screen' and old.is_active and old.deleted_at is null))
     and not has_premium(new.tenant_id) then
    raise exception 'not-premium';
  end if;
  return new;
end $fn$;

drop trigger if exists printers_screen_plan on printers;
create trigger printers_screen_plan before insert or update on printers
  for each row execute function printers_screen_plan();
