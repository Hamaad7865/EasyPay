import type { UsageModel } from "@/lib/usage";
import { Card, PageHead } from "../../backoffice/ui";
import { day, dayTime } from "../bits";

// compute hours: one decimal where the allowance is counted, two for a client's part of it
const h1 = (n: number) => n.toFixed(1);
const h2 = (n: number) => (n > 0 && n < 0.005 ? "under 0.01" : n.toFixed(2));
const MB = 1024 * 1024;
const size = (bytes: number) => {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
  if (bytes < MB / 10) return bytes > 0 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : "0 KB";
  const mb = bytes / MB;
  return `${mb >= 10 ? Math.round(mb).toLocaleString("en-GB") : mb.toFixed(1)} MB`;
};
const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
const part = (n: number, of: number) => `${Math.min(100, Math.max(0, of > 0 ? (n / of) * 100 : 0))}%`;

// The Usage page as it is drawn. The page beside this file reads the rows and
// web/lib/usage.ts works the figures out.
export function UsageView({ m }: { m: UsageModel }) {
  const r = m.reading;
  const main = m.branches.find((b) => b.main);
  const rest = m.branches.filter((b) => !b.main);
  return (
    <div>
      <PageHead
        title="Usage"
        lede="What the database has used of Neon's allowance, what is left, and which client used it. Neon's own figures are read every hour while the database is awake. Neon does not measure a client: what each one used is an estimate, from when its tills and its back office were active."
      >
        {r && <span className="muted">Neon&apos;s figures as read {dayTime(r.read_at)}</span>}
      </PageHead>

      {!r && (
        <div className="note" role="status">
          <strong>No reading of Neon&apos;s figures yet</strong>
          They are read by the job &quot;read usage&quot; on GitHub, every hour while the database is awake. It can be started by hand from the
          repository&apos;s Actions tab. The clients and the storage below come from the database itself.
        </div>
      )}
      {r && m.stale && (
        <div className="note danger" role="alert">
          <strong>The last reading is from {dayTime(r.read_at)}</strong>
          A reading is saved only while production is awake, so either nobody has used it since, or the hourly job on GitHub has stopped: look
          at &quot;read usage&quot; under the repository&apos;s Actions tab. Everything of Neon&apos;s below is as it was then.
        </div>
      )}

      {r && m.used !== null && (
        <>
          <div className="kpis">
            <div className="kpi">
              <div className="kpi-label">Compute used</div>
              <div className="kpi-value">{h1(m.used)}</div>
              <div className="kpi-note">
                {m.allowance !== null
                  ? `of ${m.allowance} compute hours${m.planAssumed ? ". Neon did not name the plan: the free plan's allowance is taken" : ""}`
                  : `compute hours. Neon names the plan ${r.plan}: its allowance is not known here`}
              </div>
              {m.allowance !== null && (
                <span className="bar" style={{ marginTop: 10 }}>
                  <i style={{ width: part(m.used, m.allowance) }} />
                </span>
              )}
            </div>
            <div className="kpi">
              <div className="kpi-label">Left</div>
              <div className="kpi-value">{m.left !== null ? h1(m.left) : "Not known"}</div>
              <div className="kpi-note">{r.period_end ? `until ${day(r.period_end)}, when the period ends` : `since ${day(r.period_start)}`}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Heading for</div>
              {!m.pace || m.pace.early ? (
                <>
                  <div className="kpi-value">Too early</div>
                  <div className="kpi-note">said once the period is three days old (it began {day(r.period_start)})</div>
                </>
              ) : (
                <>
                  <div className="kpi-value">about {Math.round(m.pace.projected)}</div>
                  <div className="kpi-note">
                    {m.pace.runsOut ? `at this pace the allowance runs out on ${day(m.pace.runsOut)}` : "by the end of the period, at this pace"}
                  </div>
                </>
              )}
            </div>
            <div className="kpi">
              <div className="kpi-label">Production</div>
              <div className="kpi-value">{main ? h1(main.hours) : "0.0"}</div>
              <div className="kpi-note">
                {rest.length ? `the rest is ${rest.map((b) => `${b.name} ${h1(b.hours)}`).join(", ")}` : "no other branch used any"}
              </div>
            </div>
          </div>

          <Card
            title="Day by day"
            lede="Compute hours used each day, in Mauritius. Neon keeps no history on this plan: these are the hourly readings, one kept for each day."
            flush
          >
            <div className="adm-scroll">
              <table className="adm-top">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="num">Used</th>
                    <th className="num">Production</th>
                    <th className="num">Other branches</th>
                  </tr>
                </thead>
                <tbody>
                  {m.days.map((d) => (
                    <tr key={d.day}>
                      <td>
                        {day(d.day)}
                        {d.sinceStart && <span className="sub">everything since the period began, up to this day</span>}
                      </td>
                      <td className="num strong">{h2(d.used)}</td>
                      <td className="num">{h2(d.production)}</td>
                      <td className="num">{h2(Math.max(0, d.used - d.production))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <Card
        title="Clients"
        lede={
          (r
            ? `Since ${dayTime(r.period_start)}, up to the reading. `
            : "Counted up to now, at a quarter of a compute hour an hour awake, since there is no reading to measure against. ") +
          "Share: each five minutes production was awake for a client, split between the clients active in it. By itself: what the client would have used with a database to itself. Both in compute hours, both estimates." +
          (m.countingSince ? ` Counting began ${dayTime(m.countingSince)}.` : " Nothing has been counted yet: counting begins when a till syncs or a back office page is opened.")
        }
        flush
      >
        <div className="adm-scroll">
          <table className="adm-top">
            <thead>
              <tr>
                <th>Client</th>
                <th className="num">Share</th>
                <th className="num">By itself</th>
                <th>Usual hours</th>
                <th className="num">Storage</th>
              </tr>
            </thead>
            <tbody>
              {m.clients.map((c) => (
                <tr key={c.id}>
                  <td className="strong">{c.name}</td>
                  <td className="num strong">{h2(c.share)}</td>
                  <td className="num">{h2(c.alone)}</td>
                  <td>{c.usual ? `${clock(c.usual.from)} to ${clock(c.usual.to)}` : <span className="muted">Too early to say</span>}</td>
                  <td className="num">{size(c.bytes)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  Not a client&apos;s
                  <span className="sub">the admin area, sign-in, releases, and anything from before counting began</span>
                </td>
                <td className="num strong">{m.other.share !== null ? h2(m.other.share) : <span className="muted">Not known</span>}</td>
                <td />
                <td />
                <td className="num">{size(m.other.bytes)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Storage"
        lede="This database, as it is now. A client's storage above is its part of each table by its rows, counted when this page is opened."
      >
        <div className="bar-with">
          <strong>{size(m.storage.bytes)}</strong>
          {m.storage.limit !== null && (
            <>
              <span className="bar">
                <i style={{ width: part(m.storage.bytes, m.storage.limit) }} />
              </span>
              of {size(m.storage.limit)}
            </>
          )}
        </div>
        {m.storage.branches !== null && (
          <p className="help">
            Branches: {m.storage.branches}
            {m.storage.branchesLimit !== null ? ` of the ${m.storage.branchesLimit} Neon allows` : ""}. {m.storage.names.join(", ")}. A release makes a
            restore copy before it tidies up, so it needs one free.
          </p>
        )}
      </Card>
    </div>
  );
}
