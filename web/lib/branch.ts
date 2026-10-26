import type { PoolClient } from "pg";
import { cookies } from "next/headers";

// The branch the back office is looking at (docs/superpowers/specs/2026-10-27-multi-branch-design.md): picked at
// the top of a report or a stock page, and kept in this browser. null is All branches, and it is what an account
// with one branch always has: it has nothing to pick.
export const BRANCH_COOKIE = "bo-branch";
export type Branch = { id: string; name: string; address: string | null; phone: string | null };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The account's branches, in the order they were made: the first is the one the account started with.
export async function branches(c: PoolClient, tenantId: string): Promise<Branch[]> {
  return (await c.query(`select id, name, address, phone from stores where tenant_id = $1 and deleted_at is null order by created_at, id`, [tenantId])).rows as Branch[];
}

// What this browser picked, not yet read against the account: a page that needs no list of branches when nothing
// is picked asks this first, and reads the list only when there is something to check.
export async function wanted(): Promise<string | null> {
  const v = (await cookies()).get(BRANCH_COOKIE)?.value ?? "";
  return ID.test(v) ? v : null;
}

// The pick, read against the account's own branches: a pick that is not one of them (a branch since removed,
// another account's, anything typed) is All branches.
export async function pickedOf(all: Branch[]): Promise<Branch | null> {
  if (all.length < 2) return null;
  const want = await wanted();
  return all.find((b) => b.id === want) ?? null;
}

// The branch a stock page works on: the one picked, or the account's only one. null is All branches of several,
// where a page shows the branches side by side and a change asks which branch it is for.
export const workingBranch = (all: Branch[], picked: Branch | null): Branch | null => picked ?? (all.length === 1 ? all[0] : null);

// The branch a form names (field "store"), read against the account's own; an account with one branch needs none.
// null when it is not one of them: the action says so in its own words.
export async function formBranch(c: PoolClient, tenantId: string, v: FormDataEntryValue | null): Promise<string | null> {
  const all = await branches(c, tenantId);
  if (all.length === 1) return all[0].id;
  const id = typeof v === "string" ? v : "";
  return all.find((b) => b.id === id)?.id ?? null;
}
