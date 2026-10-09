-- 0088_bluetooth_printers.sql — a printer paired with the tablet by Bluetooth.
--
-- The owner, looking at Printers in the back office: "add bluetooth option for
-- printers in the backoffice right now its listing network and cable what
-- about bluetooth". A printer's kind says how the tablet reaches it: over the
-- network at its address, on a USB cable, and now by Bluetooth. Pairing is the
-- tablet's own to do, in its Bluetooth settings; the till then finds the
-- printer among what is paired, by what is kept here in `address`: the name
-- the tablet shows for it ("MPT-II") or its Bluetooth address
-- (00:11:22:AA:BB:CC). So a Bluetooth printer without one cannot be found, and
-- is refused.
--
-- A till older than 0.6.2 does not know the kind: it takes the row for a
-- network printer and reports it as not answering. Nothing else of it changes.

alter table printers drop constraint if exists printers_kind_check;
alter table printers add constraint printers_kind_check check (kind in ('network', 'usb', 'bluetooth', 'screen'));

alter table printers drop constraint if exists printers_bluetooth_check;
alter table printers add constraint printers_bluetooth_check
  check (kind <> 'bluetooth' or (address is not null and btrim(address) <> ''));
