import type { PoolClient } from "pg";

// What a few of the back office's forms do to the database, kept apart from
// their pages so that db/tests/backoffice-saves.test.cjs can run them as the
// restaurant's own connection. Each says whether it did what was asked: the
// page turns a "no" into the sentence the owner reads, and nothing is saved.

// One tax per item: the others are taken off, the chosen one put (back) on.
// False when the tax is not one of the restaurant's (it was removed while the
// item's panel was open): nothing is touched, so the item keeps the tax it had.
export async function setItemTax(c: PoolClient, tenantId: string, item: string, tax: string): Promise<boolean> {
  const live = await c.query(`select 1 from taxes where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, tax]);
  if (live.rowCount !== 1) return false;
  await c.query(`update item_taxes set deleted_at = now() where tenant_id = $1 and item_id = $2 and tax_id <> $3 and deleted_at is null`, [tenantId, item, tax]);
  await c.query(
    `insert into item_taxes (tenant_id, item_id, tax_id)
       select $1, $2, t.id from taxes t where t.tenant_id = $1 and t.id = $3 and t.deleted_at is null
     on conflict (item_id, tax_id) do update set deleted_at = null`,
    [tenantId, item, tax],
  );
  return true;
}
