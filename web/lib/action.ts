import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import type { PoolClient } from "pg";
import { requirePerm, type TenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";

// What a form's server action does, in one place: check the permission, run
// the change in the restaurant's own transaction, then go back to the page
// with a line saying what happened. A thrown Error's message is shown as is,
// so actions throw sentences a restaurant owner can read.
export class Refused extends Error {}

export async function act(
  perm: string,
  path: string,
  fn: (c: PoolClient, ctx: TenantContext) => Promise<string | void>,
  // where to go when the change is refused, if not the same place (a form in
  // a panel goes back to the list when it saves, and stays open when it does not)
  refusedPath: string = path,
): Promise<never> {
  let ok = "Saved.";
  try {
    const ctx = await requirePerm(perm);
    ok = (await withTenant(ctx.tenantId, (c) => fn(c, ctx))) ?? ok;
  } catch (e) {
    unstable_rethrow(e);
    const code = (e as { code?: string }).code;
    const msg =
      e instanceof Refused
        ? e.message
        : code === "23505"
          ? "That name is already in use."
          : e instanceof Error && e.message.startsWith("Forbidden")
            ? "You are not allowed to change this."
            : e instanceof Error && e.message.includes("suspended")
              ? e.message
              : "That could not be saved. Nothing was changed.";
    redirect(with_(refusedPath, "err", msg));
  }
  revalidatePath(path.split("?")[0]);
  redirect(with_(path, "ok", ok));
}

const with_ = (path: string, key: string, msg: string) => path + (path.includes("?") ? "&" : "?") + key + "=" + encodeURIComponent(msg);

// Where a list's save goes back to: the list as it was (its search, filters
// and open line travel in the form's "back" field), and never anywhere but
// the page itself.
export const backTo = (f: FormData, path: string) => {
  const back = String(f.get("back") ?? "");
  return back === path || back.startsWith(path + "?") ? back.slice(0, 600) : path;
};

export const text = (f: FormData, k: string, max = 200) => String(f.get(k) ?? "").trim().slice(0, max);
export const int = (f: FormData, k: string, lo: number, hi: number, d = lo) => {
  const n = Math.round(Number(String(f.get(k) ?? "")));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
export const on = (f: FormData, k: string) => f.get(k) === "on" || f.get(k) === "1" || f.get(k) === "true";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuid = (f: FormData, k: string) => {
  const v = String(f.get(k) ?? "");
  if (!UUID.test(v)) throw new Refused("That row no longer exists. Reload the page.");
  return v;
};
