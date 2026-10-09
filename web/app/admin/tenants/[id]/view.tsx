import Link from "next/link";
import { BUSINESS_TYPES, PLAN_HELP, PLANS } from "@/lib/platform";
import { Submit, Wait } from "../../../backoffice/busy";
import { cap, day, dayTime, Notes, supportId } from "../../bits";
import { ConfirmSubmit } from "../../confirm";
import { Password } from "../../password";
import { type Login, LoginsTable } from "./logins";

export type Tenant = {
  id: string;
  name: string;
  brn: string | null;
  vat_number: string | null;
  plan: string;
  business_type: string;
  status: string;
  status_reason: string | null;
  status_changed_at: string | null;
  created_at: string;
};
export type Store = { id: string; name: string; code: string };
export type Till = {
  id: string;
  store_id: string;
  name: string;
  code: string;
  app_version: string | null;
  last_seen_at: string | null;
  last_receipt_seq: string;
  active: boolean;
};
export type Audit = { action: string; detail: Record<string, unknown>; created_at: string; admin: string | null };
export type { Login };

type Action = (f: FormData) => Promise<void>;
export type TenantActions = {
  setDetails: Action;
  setPlan: Action;
  setBusinessType: Action;
  setStatus: Action;
  addStore: Action;
  setTillActive: Action;
  addLogin: Action;
  setPassword: Action;
  setPin: Action;
  setActive: Action;
};

const ACTIONS: Record<string, string> = {
  "tenant.create": "Client created",
  "tenant.suspended": "Suspended",
  "tenant.active": "Reactivated",
  "tenant.plan": "Plan changed",
  "tenant.business_type": "Business type changed",
  "login.add": "Login added",
  "login.disable": "Login switched off",
  "login.enable": "Login switched on",
  "login.password": "Password changed",
  "login.pin": "Till PIN set",
  "store.add": "Store added",
  "tenant.details": "Details changed",
  "till.deactivate": "Till deactivated",
  "till.activate": "Till reactivated",
};

function auditNote(a: Audit): string {
  const d = a.detail ?? {};
  if (a.action === "tenant.plan" || a.action === "tenant.business_type") return `${String(d.from)} to ${String(d.to)}`;
  if (a.action === "tenant.suspended") return String(d.reason ?? "");
  if (a.action === "login.add") return `${String(d.name)} as ${String(d.role)}`;
  if (a.action === "store.add") return `${String(d.name)} (${String(d.code)})`;
  if (a.action === "till.deactivate" || a.action === "till.activate") return String(d.code ?? "");
  return "";
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// One restaurant's page as it is drawn. What it has is on the left (its
// stores with their tills, its logins); what it is, is on the right (its
// details, plan and type, and whether it is suspended); what an admin did to
// it runs along the foot. Each form adds on top of its list. The page beside
// this file reads the rows and holds the actions.
export function TenantView({
  tenant,
  stores,
  tills,
  logins,
  roles,
  audit,
  error,
  notice,
  actions,
}: {
  tenant: Tenant;
  stores: Store[];
  tills: Till[];
  logins: Login[];
  roles: string[];
  audit: Audit[];
  error?: string;
  notice?: string;
  actions: TenantActions;
}) {
  const active = tenant.status === "active";
  const which = <input type="hidden" name="tenant" value={tenant.id} />;
  return (
    <div>
      <p className="crumb">
        <Link href="/admin">
          Clients
          <Wait />
        </Link>{" "}
        / {tenant.name}
      </p>
      <div className="adm-title">
        <h1>{tenant.name}</h1>
        <span className={active ? "badge green" : "badge red"}>{active ? "Active" : "Suspended"}</span>
      </div>
      <p className="lede">
        {cap(tenant.business_type)} · {cap(tenant.plan)} plan · ID {supportId(tenant.id)} · Created {day(tenant.created_at)}
      </p>
      <Notes error={error} notice={notice} />
      {!active && (
        <div className="bo-banner danger">
          <strong>
            Suspended{tenant.status_changed_at ? ` since ${day(tenant.status_changed_at)}` : ""}
            {tenant.status_reason ? `: ${tenant.status_reason}` : ""}
          </strong>
          They can still sign in and see their data, and their tills still sync sales already made. They cannot change the menu or add tills. Nothing is
          deleted.
        </div>
      )}

      <div className="adm-cols">
        <div>
          <section className="card flush">
            <div className="card-head">
              <div>
                <h2>Stores and tills</h2>
                <p>
                  {count(stores.length, "store")}, {count(tills.length, "till")}. Every login of this client can use every store.
                </p>
              </div>
            </div>
            <form action={actions.addStore} className="table-filters">
              {which}
              <input name="name" placeholder="Store name" aria-label="Store name" required />
              <input name="code" placeholder="Store code, e.g. S2" aria-label="Store code" required />
              <Submit>Add store</Submit>
            </form>
            <div className="adm-scroll">
              <table className="adm-nowrap">
                <thead>
                  <tr>
                    <th>Till</th>
                    <th>Last seen</th>
                    <th>App</th>
                    <th className="num">Receipts</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {stores.map((st) => {
                    const here = tills.filter((d) => d.store_id === st.id);
                    return [
                      <tr key={st.id} className="adm-group">
                        <td colSpan={6}>
                          {st.name}
                          <span className="chip">{st.code}</span>
                        </td>
                      </tr>,
                      here.length === 0 && (
                        <tr key={st.id + "-none"}>
                          <td colSpan={6} className="muted">
                            No tills registered yet.
                          </td>
                        </tr>
                      ),
                      ...here.map((d) => (
                        <tr key={d.id}>
                          <td>
                            <span className="strong">{d.name}</span>
                            <span className="sub">{d.code}</span>
                          </td>
                          <td>{d.last_seen_at ? dayTime(d.last_seen_at) : <span className="muted">Never</span>}</td>
                          <td>{d.app_version ?? <span className="muted">Unknown</span>}</td>
                          <td className="num">{d.last_receipt_seq}</td>
                          <td>
                            <span className={d.active ? "badge green" : "badge"}>{d.active ? "Active" : "Deactivated"}</span>
                          </td>
                          <td>
                            <form action={actions.setTillActive} className="row-actions">
                              {which}
                              <input type="hidden" name="device" value={d.id} />
                              <input type="hidden" name="active" value={d.active ? "false" : "true"} />
                              {d.active ? (
                                <ConfirmSubmit
                                  className="btn-danger btn-sm"
                                  title={`Deactivate ${d.name}?`}
                                  text="It cannot register again. A till that is still signed in keeps selling and syncing; switch its login off to stop that. You can reactivate it here."
                                  yes="Deactivate"
                                >
                                  Deactivate
                                </ConfirmSubmit>
                              ) : (
                                <Submit className="btn-quiet btn-sm">Reactivate</Submit>
                              )}
                            </form>
                          </td>
                        </tr>
                      )),
                    ];
                  })}
                </tbody>
              </table>
            </div>
            <p className="adm-note">
              Deactivating stops a till from registering again. It does not stop a till that is still signed in: that till keeps selling and syncing until
              its login is switched off.
            </p>
          </section>

          <section className="card flush">
            <div className="card-head">
              <div>
                <h2>Logins</h2>
                <p>{count(logins.length, "login")}. Open one to set a new password or till PIN, or to switch it off.</p>
              </div>
            </div>
            <form action={actions.addLogin} className="table-filters adm-add">
              {which}
              <input name="name" placeholder="Name" aria-label="Name" required />
              <input name="email" type="email" placeholder="Email (their login)" aria-label="Email (their login)" required autoComplete="off" />
              <Password inline label="Initial password" placeholder="Initial password, 8 or more" />
              <select name="role" defaultValue="Manager" aria-label="Role">
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <Submit>Create login</Submit>
            </form>
            <LoginsTable tenant={tenant.id} logins={logins} setPassword={actions.setPassword} setPin={actions.setPin} setActive={actions.setActive} />
            <p className="adm-note">
              A login opens the back office only when its role has &quot;Sign in to the back office&quot;: an Owner&apos;s and a Manager&apos;s do, a
              Cashier&apos;s and a Waiter&apos;s do not, unless the client ticks it under Roles and permissions. Staff who only sell need no login: they get
              a PIN in the back office, under Staff. A till is set up with the owner&apos;s or a manager&apos;s login, and with no other (a role needs
              &quot;Change settings, printers and tables&quot; for it): what staff then do on it under their PIN is recorded in their own name.
            </p>
          </section>
        </div>

        <div>
          <section className="card flush">
            <div className="card-head">
              <h2>Details</h2>
            </div>
            <form action={actions.setDetails}>
              <div className="card-body">
                {which}
                <label className="field">
                  Client name
                  <input name="name" defaultValue={tenant.name} required />
                </label>
                <label className="field">
                  BRN
                  <input name="brn" defaultValue={tenant.brn ?? ""} />
                </label>
                <label className="field">
                  VAT number
                  <input name="vat" defaultValue={tenant.vat_number ?? ""} />
                </label>
              </div>
              <div className="card-foot">
                <Submit>Save details</Submit>
              </div>
            </form>
          </section>

          <section className="card flush">
            <div className="card-head">
              <h2>Plan and type</h2>
            </div>
            <div className="card-body">
              <form action={actions.setPlan} className="adm-part">
                {which}
                <strong>Plan</strong>
                <div className="inline">
                  <select name="plan" defaultValue={tenant.plan} aria-label="Plan">
                    {Array.from(new Set([...PLANS, tenant.plan])).map((p) => (
                      <option key={p} value={p}>
                        {cap(p)}
                      </option>
                    ))}
                  </select>
                  <Submit className="btn-quiet">Change plan</Submit>
                </div>
                <span className="help">{PLAN_HELP}</span>
              </form>
              <form action={actions.setBusinessType} className="adm-part">
                {which}
                <strong>Business type</strong>
                <span className="help">
                  A restaurant has tables, bookings and the kitchen. A shop has none of them. Changing is refused while the client has open orders, and
                  deletes nothing: pages are only hidden.
                </span>
                <div className="inline">
                  <select name="type" defaultValue={tenant.business_type} aria-label="Business type">
                    {BUSINESS_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {cap(t)}
                      </option>
                    ))}
                  </select>
                  <Submit className="btn-quiet">Change type</Submit>
                </div>
              </form>
            </div>
          </section>

          <section className="card flush">
            <div className="card-head">
              <h2>Status</h2>
            </div>
            {active ? (
              <form action={actions.setStatus}>
                <div className="card-body">
                  {which}
                  <input type="hidden" name="status" value="suspended" />
                  <label className="field">
                    Reason for suspending
                    <input name="reason" placeholder="e.g. plan cancelled, unpaid since March" required />
                    <span className="help">
                      They can still sign in and see their data, and their tills still sync sales already made. They cannot change the menu or add tills.
                      Nothing is deleted.
                    </span>
                  </label>
                </div>
                <div className="card-foot">
                  <ConfirmSubmit
                    className="btn-danger"
                    title={`Suspend ${tenant.name}?`}
                    text="They can still sign in and see their data, and their tills still sync sales already made. They cannot change the menu or add tills. Nothing is deleted, and you can reactivate them here."
                    yes="Suspend"
                  >
                    Suspend this client
                  </ConfirmSubmit>
                </div>
              </form>
            ) : (
              <form action={actions.setStatus} className="card-body">
                {which}
                <input type="hidden" name="status" value="active" />
                <Submit>Reactivate</Submit>
              </form>
            )}
          </section>
        </div>
      </div>

      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>What was done here</h2>
            <p>By an admin, the newest first.</p>
          </div>
        </div>
        {audit.length === 0 ? (
          <p className="dash-empty">Nothing yet.</p>
        ) : (
          <ul className="adm-log">
            {audit.map((a, i) => (
              <li key={i}>
                <time>{dayTime(a.created_at)}</time>
                <span>
                  <b>{ACTIONS[a.action] ?? a.action}</b>
                  {auditNote(a) ? `, ${auditNote(a)}` : ""}
                </span>
                {a.admin && <small>{a.admin}</small>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
