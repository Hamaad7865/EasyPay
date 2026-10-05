import { db } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform";

// What the tills wrote down when they stopped unexpectedly, newest first,
// across every restaurant. A till sends its reports the next time it syncs.
// The same place in the program failing on several tablets is one line here
// with a count, so the crash that matters most is the one at the top.
type Row = {
  summary: string; n: number; tills: number; restaurants: string; versions: string; models: string;
  first_at: string; last_at: string; trace: string;
};

const when = (v: string) =>
  new Date(v).toLocaleString("en-GB", { timeZone: "Indian/Mauritius", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

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
  ).rows as Row[];
  return (
    <div>
      <h1>Crashes</h1>
      <p>
        The last 60 days. A till writes a report when it stops unexpectedly and sends it the next time it syncs; nothing of a sale or a customer is in
        it.
      </p>
      {rows.length === 0 ? (
        <p>No till has reported a crash.</p>
      ) : (
        <table cellPadding={6} style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
              <th>What stopped it</th>
              <th>Times</th>
              <th>Tills</th>
              <th>Restaurants</th>
              <th>Version</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                <td style={{ maxWidth: 520 }}>
                  <details>
                    <summary style={{ cursor: "pointer", wordBreak: "break-word" }}>{r.summary}</summary>
                    <p style={{ margin: "6px 0", color: "#555", fontSize: 12 }}>
                      First seen {when(r.first_at)} · {r.models}
                    </p>
                    <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, background: "#f6f6f6", padding: 8, maxHeight: 360, overflow: "auto" }}>
                      {r.trace}
                    </pre>
                  </details>
                </td>
                <td>{r.n}</td>
                <td>{r.tills}</td>
                <td>{r.restaurants}</td>
                <td>{r.versions}</td>
                <td style={{ whiteSpace: "nowrap" }}>{when(r.last_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
