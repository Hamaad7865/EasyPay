import { db } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform";
import { type CrashRow, CrashesView } from "./view";

// What the tills wrote down when they stopped unexpectedly, newest first,
// across every restaurant. A till sends its reports the next time it syncs.
// The same place in the program failing on several tablets is one line here
// with a count, so the crash that matters most is the one at the top.
export default async function CrashesPage() {
  await requirePlatformAdmin();
  const rows = (
    await db().query(
      // grouped by where it stopped: the first line of the trace and the first frame of the till's own code
      `with c as (
         select cr.*, t.name as restaurant,
                coalesce(substring(cr.trace from E'\\n\\\\s*at (com\\\\.restopos[^\\n]*)'), '') as frame
           from crash_reports cr join tenants t on t.id = cr.tenant_id
          where cr.deleted_at is null and cr.created_at > now() - interval '60 days'
       )
       select summary, count(*)::int as n, count(distinct coalesce(device_id::text, tenant_id::text))::int as tills,
              string_agg(distinct restaurant, ', ') as restaurants,
              string_agg(distinct coalesce(app_version, '?'), ', ') as versions,
              string_agg(distinct coalesce(model, '?'), ', ') as models,
              min(happened_at) as first_at, max(happened_at) as last_at,
              (array_agg(trace order by happened_at desc))[1] as trace
         from c group by summary, frame order by max(happened_at) desc limit 100`,
    )
  ).rows as CrashRow[];
  return <CrashesView rows={rows} />;
}
