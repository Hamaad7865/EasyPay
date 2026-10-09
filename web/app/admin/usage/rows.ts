import { db } from "@/lib/db";
import type { Mark, Reading } from "@/lib/usage";

export type UsageRows = {
  readings: Reading[];
  marks: Mark[];
  tenants: { id: string; name: string }[];
  storage: { tenant_id: string; bytes: number }[];
  dbBytes: number;
};

// Everything the Usage page is drawn from, in one question (migration 0090):
// Neon's totals as the hourly job read them, which five minutes each client
// was active in, and how much of the database each client's rows take. Seventy
// days back: a period is a month at most, and the hours a client usually keeps
// are taken from the last fourteen days. The storage is counted as it is
// asked: every table that has a tenant_id is read.
export async function usageRows(): Promise<UsageRows> {
  const row = (
    await db().query(
      `select
         (select coalesce(jsonb_agg(to_jsonb(d) order by d.day), '[]'::jsonb)
            from platform.usage_days d where d.day > current_date - 70) as readings,
         (select coalesce(jsonb_agg(jsonb_build_object('tenant_id', h.tenant_id, 'hour', h.hour, 'slots', h.slots)), '[]'::jsonb)
            from platform.usage_hours h join tenants t on t.id = h.tenant_id and t.deleted_at is null
           where h.hour > now() - interval '70 days') as marks,
         (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name), '[]'::jsonb)
            from tenants t where t.deleted_at is null) as tenants,
         (select coalesce(jsonb_agg(jsonb_build_object('tenant_id', s.tenant_id, 'bytes', s.bytes)), '[]'::jsonb)
            from platform.storage_by_tenant() s join tenants t on t.id = s.tenant_id and t.deleted_at is null) as storage,
         pg_database_size(current_database())::float8 as db_bytes`,
    )
  ).rows[0];
  return { readings: row.readings, marks: row.marks, tenants: row.tenants, storage: row.storage, dbBytes: Number(row.db_bytes) };
}
