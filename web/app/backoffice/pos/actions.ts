"use server";

import { Refused, UUID, act } from "@/lib/action";
import { parseRs } from "@/lib/money";
import { refusal } from "@/lib/pos";

// What the back office asks of a till (migration 0091). Nothing is closed and
// no cash is moved here: a request is left, and the till carries it out the
// next time it syncs, with its own figures. The database refuses what a till
// could not do or this person may not do on a till either, and says why with
// a code that is put into words here.

// Back to where it was asked from: the cards, or a page of that till.
function from(f: FormData, till: string): string {
  const back = String(f.get("back") ?? "");
  const own = `/backoffice/pos/${till}`;
  if (UUID.test(till) && (back === own || back.startsWith(own + "?"))) return back.slice(0, 300);
  return "/backoffice/pos";
}

const asking = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (e) {
    throw new Refused(refusal((e as Error).message));
  }
};

export async function askClose(f: FormData) {
  const till = String(f.get("till") ?? "");
  await act("shift.open_close", from(f, till), async (c, ctx) => {
    const typed = String(f.get("counted") ?? "").trim();
    const counted = typed === "" ? null : parseRs(typed);
    if (!UUID.test(till)) throw new Refused(refusal("bad-device"));
    if (typed !== "" && counted === null) throw new Refused("Type the counted cash as an amount, like 1,250.00, or leave it empty.");
    await asking(() => c.query(`select till_request($1, $2, 'close_day', $3, null, null)`, [ctx.employeeId, till, counted]));
    return "Asked. The till closes its day as of now: at once if someone is using it, otherwise the next time it is touched.";
  });
}

export async function askCashOut(f: FormData) {
  const till = String(f.get("till") ?? "");
  await act("cash.pay_in_out", from(f, till), async (c, ctx) => {
    const amount = parseRs(String(f.get("amount") ?? ""));
    const reason = String(f.get("reason") ?? "").trim().slice(0, 120);
    if (!UUID.test(till)) throw new Refused(refusal("bad-device"));
    if (amount === null || amount <= 0) throw new Refused("Type the amount taken out, like 190.00.");
    if (!reason) throw new Refused(refusal("reason-required"));
    await asking(() => c.query(`select till_request($1, $2, 'cash_out', null, $3, $4)`, [ctx.employeeId, till, amount, reason]));
    return "Asked. The till records the cash out as of now: at once if someone is using it, otherwise the next time it is touched.";
  });
}

export async function cancelAsk(f: FormData) {
  const till = String(f.get("till") ?? "");
  const id = String(f.get("id") ?? "");
  // the database checks the permission that goes with what was asked
  await act(f.get("kind") === "cash_out" ? "cash.pay_in_out" : "shift.open_close", from(f, till), async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused(refusal("bad-request"));
    await asking(() => c.query(`select till_request_cancel($1, $2)`, [ctx.employeeId, id]));
    return "Cancelled. The till will not act on it.";
  });
}
