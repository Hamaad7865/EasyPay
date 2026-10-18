-- 0117: a deposit collected in part reaches the other tablets.
--
-- A tablet learns of a deposit from sync_pull, which sends a deposit, its
-- lines and its payments inside the row whenever the deposits row changed
-- (its server_seq, 0113). A collection writes deposit_lines.qty_collected,
-- and the deposits row was touched only when the receipt also paid with the
-- Deposit type naming it, or when every line was taken. A visit paid in cash
-- that took some of the goods (nothing left of the deposit's money, or a
-- deposit taken with nothing paid) left the row as it was: the other tablets
-- kept showing those goods as held, offered them again at Collect and said
-- the wrong amount to pay.
--
-- Now a line's collected count changing touches its deposit, so the row (and
-- its lines with it) goes out at the next pull.

create or replace function deposit_lines_touch_deposit() returns trigger
language plpgsql set search_path = public as $fn$
begin
  update deposits set updated_at = now() where tenant_id = new.tenant_id and id = new.deposit_id;
  return null;
end $fn$;

drop trigger if exists trg_deposit_lines_touch on deposit_lines;
create trigger trg_deposit_lines_touch after update of qty_collected on deposit_lines
  for each row when (old.qty_collected is distinct from new.qty_collected)
  execute function deposit_lines_touch_deposit();
