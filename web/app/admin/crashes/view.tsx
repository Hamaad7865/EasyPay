import { ChevronRight, ShieldCheck } from "lucide-react";
import { Empty, PageHead } from "../../backoffice/ui";

export type CrashRow = {
  summary: string; n: number; tills: number; restaurants: string; versions: string; models: string;
  first_at: string; last_at: string; trace: string;
};

const when = (v: string) =>
  new Date(v).toLocaleString("en-GB", { timeZone: "Indian/Mauritius", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

// The crashes as they are drawn: one line for each place the till stopped,
// which opens on where in the program it was. The page beside this file reads
// the rows.
export function CrashesView({ rows }: { rows: CrashRow[] }) {
  return (
    <div>
      <PageHead
        title="Crashes"
        lede="The last 60 days. A till writes a report when it stops unexpectedly and sends it the next time it syncs. A report says what kind of error it was and where in the program, with the version and the tablet; the error's own message is left out, so nothing of a sale or a customer is in it."
      />
      {rows.length === 0 ? (
        <Empty icon={ShieldCheck} title="No till has reported a crash" />
      ) : (
        <section className="card flush">
          <div className="adm-scroll">
            <table className="adm-top">
              <thead>
                <tr>
                  <th>What stopped it</th>
                  <th className="num">Times</th>
                  <th className="num">Tills</th>
                  <th>Clients</th>
                  <th>Version</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <details className="adm-crash">
                        <summary>
                          <ChevronRight aria-hidden="true" />
                          {r.summary}
                        </summary>
                        <span className="sub">
                          First seen {when(r.first_at)} · {r.models}
                        </span>
                        <pre className="adm-trace">{r.trace}</pre>
                      </details>
                    </td>
                    <td className="num strong">{r.n}</td>
                    <td className="num">{r.tills}</td>
                    <td>{r.restaurants}</td>
                    <td>{r.versions}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{when(r.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
