import Link from "next/link";
import { isOffline } from "@/lib/plan";
import { BUSINESS_TYPES, PLAN_HELP, PLANS, PREMIUM_MRA } from "@/lib/platform";
import { asMra, MRA_STATE_WORDS, onMra, type ChecklistLine, type TillMraStatus } from "@/lib/mra";
import { Submit, Wait } from "../../../backoffice/busy";
import { cap, day, dayTime, Notes, supportId } from "../../bits";
import { ConfirmSubmit } from "../../confirm";
import { Password } from "../../password";
import { type Login, LoginsTable } from "./logins";
import { type CodeAction, type TabletCode, Tablets } from "./tablets";
import { type MraConnection, MraPanel } from "./mra";

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
  // extras paid for beyond the plan (0113)
  features: string[];
  // Premium MRA: off, setting_up, training, live (0116)
  mra: string;
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
  // nothing recorded on it: no receipt, no day, no cash, no clock-in
  bare: boolean;
  // the ID the MRA gave it (0116), and what it last said of its connection to the MRA (0132)
  mra_ebs_id: string | null;
  mra_status: TillMraStatus;
};
// Is the client being set up, and how much has been rung up on it so far.
export type Setup = { settingUp: boolean; receipts: number; orders: number };
export type Audit = { action: string; detail: Record<string, unknown>; created_at: string; admin: string | null };
export type { Login };

type Action = (f: FormData) => Promise<void>;
export type TenantActions = {
  setDetails: Action;
  setPlan: Action;
  setFeatures: Action;
  setBusinessType: Action;
  setStatus: Action;
  addStore: Action;
  setTillActive: Action;
  addLogin: Action;
  setPassword: Action;
  setPin: Action;
  setActive: Action;
  addTablet: CodeAction;
  moveTablet: CodeAction;
  endCode: Action;
  openBackOffice: Action;
  removeTill: Action;
  removeCode: Action;
  goLive: Action;
  backToSettingUp: Action;
  clearTest: Action;
  setMra: Action;
  setTillMraIds: Action;
  setMraConnection: Action;
};

const ACTIONS: Record<string, string> = {
  "tenant.create": "Client created",
  "tenant.suspended": "Suspended",
  "tenant.active": "Reactivated",
  "tenant.plan": "Plan changed",
  "tenant.features": "Extras changed",
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
  "tablet.add": "Code made for a new tablet",
  "tablet.move": "Code made for a replacement tablet",
  "tablet.code_end": "Code taken back",
  "backoffice.open": "Back office opened by EasyPay",
  "till.remove": "Till removed",
  "tablet.code_remove": "Code removed",
  "tenant.clear_test": "Test activity cleared",
  "tenant.live": "Put live",
  "tenant.setting_up": "Taken back to being set up",
  "tenant.mra": "MRA e-invoicing",
  "till.mra_id": "Till's EBS MRA ID",
};

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function auditNote(a: Audit): string {
  const d = a.detail ?? {};
  if (a.action === "tenant.plan" || a.action === "tenant.business_type") return `${String(d.from)} to ${String(d.to)}`;
  if (a.action === "tenant.features") return `${(Array.isArray(d.to) ? d.to : []).join(", ") || "none"}`;
  if (a.action === "tenant.mra") return `${MRA_STATE_WORDS[asMra(d.from)]} to ${MRA_STATE_WORDS[asMra(d.to)]}`;
  // what the till had is said too: an ID cleared by mistake can be typed back
  if (a.action === "till.mra_id") return d.to ? (d.from ? `${String(d.from)} to ${String(d.to)}` : String(d.to)) : d.from ? `cleared (was ${String(d.from)})` : "cleared";
  if (a.action === "tenant.suspended") return String(d.reason ?? "");
  if (a.action === "login.add") return `${String(d.name)} as ${String(d.role)}`;
  if (a.action === "store.add") return `${String(d.name)} (${String(d.code)})`;
  if (a.action === "till.deactivate" || a.action === "till.activate" || a.action === "tablet.move" || a.action === "till.remove") return String(d.code ?? "");
  if (a.action === "tablet.code_remove") return `ending ${String(d.hint ?? "")}`;
  if (a.action === "tenant.clear_test") {
    return [count(Number(d.receipts ?? 0), "receipt"), count(Number(d.orders ?? 0), "order"), count(Number(d.tills ?? 0), "till"), count(Number(d.codes ?? 0), "code")].join(", ");
  }
  return "";
}

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
  codes,
  setup,
  checklist,
  mraConnection,
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
  codes: TabletCode[];
  setup: Setup;
  // what a Premium MRA client's move still lacks (0116); empty for any other client
  checklist: ChecklistLine[];
  // the MRA's address and key, for every client on MRA (0132); null until typed
  mraConnection: MraConnection | null;
  error?: string;
  notice?: string;
  actions: TenantActions;
}) {
  const active = tenant.status === "active";
  const offline = isOffline(tenant.plan);
  const mra = onMra(asMra(tenant.mra));
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
        {setup.settingUp && <span className="badge amber">Setting up</span>}
      </div>
      <p className="lede">
        {cap(tenant.business_type)} · {mra ? "Premium MRA" : cap(tenant.plan)} plan · ID {supportId(tenant.id)} · Created {day(tenant.created_at)}
      </p>
      <Notes error={error} notice={notice} />
      {/* An offline client has no back office of its own: EasyPay sets it up from here, for its owner. */}
      {offline && (
        <form action={actions.openBackOffice} className="bo-banner">
          {which}
          <strong>This client runs on its tablet, and has no back office of its own</strong>
          You can open it to set the business up for its owner: products, prices, taxes, staff, printers, tables, the receipt. The tablet has what you
          set up once someone taps Get changes from EasyPay on it (Settings, Support), with the tablet online. Its sales and its stock stay on the
          tablet: reports and stock figures in there are not the business&apos;s.
          <div className="inline" style={{ display: "flex", marginTop: 10 }}>
            <Submit>Login to back office</Submit>
          </div>
        </form>
      )}
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
                  {count(stores.length, "store")}, {count(tills.length, "till")}. Every login of this client can use every store; its staff work where its Staff page says.
                </p>
              </div>
            </div>
            {/* the offline plan runs one tablet's branch (0136) */}
            {offline ? (
              <p className="muted" style={{ padding: "0 20px" }}>An offline client has one branch. Make it Premium to add another.</p>
            ) : (
              <form action={actions.addStore} className="table-filters">
                {which}
                <input name="name" placeholder="Store name" aria-label="Store name" required />
                <input name="code" placeholder="Store code, e.g. S2" aria-label="Store code" required />
                <Submit>Add store</Submit>
              </form>
            )}
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
                            <div className="row-actions">
                              {/* Only a till with nothing recorded; and where the tablet keeps its sales to itself, only while the client is being set up. */}
                              {d.bare && (!offline || setup.settingUp) && (
                                <form action={actions.removeTill}>
                                  {which}
                                  <input type="hidden" name="device" value={d.id} />
                                  <ConfirmSubmit
                                    className="btn-quiet btn-sm"
                                    title={`Remove ${d.name}?`}
                                    text={
                                      offline
                                        ? "The till goes for good, with its key and the codes it was set up with. The tablet that is this till works on its own and keeps selling, but it can no longer be given a code: a backup of it can be restored to no tablet. Remove it only when what is on that tablet is not needed."
                                        : "The till goes for good, with its key and the codes it was set up with, and its number is free again. The tablet that was it is set up again only after the EasyPay app's data is cleared on it."
                                    }
                                    yes="Remove"
                                  >
                                    Remove
                                  </ConfirmSubmit>
                                </form>
                              )}
                              <form action={actions.setTillActive}>
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
                            </div>
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
              its login is switched off. A till with nothing recorded on it (no sale, no day, no cash) can be removed for good
              {offline ? ", while the client is being set up" : ""}.
            </p>
          </section>

          <Tablets
            tenant={tenant.id}
            offline={offline}
            stores={stores}
            tills={tills.filter((d) => d.active).map((d) => ({ id: d.id, name: d.name, code: d.code, store: stores.find((st) => st.id === d.store_id)?.name ?? "" }))}
            codes={codes}
            addTablet={actions.addTablet}
            moveTablet={actions.moveTablet}
            endCode={actions.endCode}
            removeCode={actions.removeCode}
          />

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
          {/* Being set up, or live (migration 0104): what a client is tried with can be cleared only before it opens. */}
          <section className="card flush">
            <div className="card-head">
              <div>
                <h2>{setup.settingUp ? "Being set up" : "Live"}</h2>
                <p>{offline ? "Its sales are on its tablet, not here." : `${count(setup.receipts, "receipt")} and ${count(setup.orders, "order")} so far.`}</p>
              </div>
            </div>
            {setup.settingUp ? (
              <div className="card-body">
                {offline ? (
                  <div className="adm-part">
                    <strong>What it was tried with</strong>
                    <span className="help">
                      This client runs on its tablet: what was rung up while it was tried is on the tablet, and nothing of it is here to clear. A till it
                      was tried with can be removed in the list, and a code that waits or is over too. A tablet set up with its code before the business
                      sold for real (Not yet) is being set up on its own: its owner clears what was rung up on it with Go live, on the strip at the
                      top of the till or under This till, and keeps what was set up.
                    </span>
                  </div>
                ) : (
                  <form action={actions.clearTest} className="adm-part">
                    {which}
                    <strong>Clear test activity</strong>
                    <span className="help">
                      Removes what was rung up while it was tried: every order, receipt, refund, payment, day, cash movement, clock-in and booking, and
                      its tills with their keys and the codes they were set up with (a code for a new tablet that nobody used yet stays). What the
                      sales took off the shelves is put back. The menu, the stock with its deliveries
                      and counts, suppliers, customers, tables, staff, logins, printers and settings stay. Before you clear, clear the EasyPay
                      app&apos;s data on each tablet (the tablet&apos;s Settings, Apps, EasyPay, Storage); afterwards, set each one up again. This
                      cannot be undone from here.
                    </span>
                    <label className="field">
                      Type the client&apos;s name to confirm
                      <input name="confirm" placeholder={tenant.name} required autoComplete="off" />
                    </label>
                    <ConfirmSubmit
                      className="btn-danger"
                      title={`Clear what ${tenant.name} was tried with?`}
                      text={`${count(setup.receipts, "receipt")}, ${count(setup.orders, "order")} and ${count(tills.length, "till")} go for good. Its menu, stock, staff and settings stay. Every tablet has to be cleared and set up again.`}
                      yes="Clear test activity"
                    >
                      Clear test activity
                    </ConfirmSubmit>
                  </form>
                )}
                <form action={actions.goLive} className="adm-part">
                  {which}
                  <strong>Go live</strong>
                  <span className="help">
                    The day it opens for real. From then on its sales are its books: nothing of them is cleared from here, and it can be taken back to
                    being set up only while it has no receipt.
                  </span>
                  <ConfirmSubmit
                    title={`Put ${tenant.name} live?`}
                    text={
                      !offline && setup.receipts > 0
                        ? `It has ${count(setup.receipts, "receipt")} from its trying, and they will stay in its books: once it is live they cannot be cleared from here. Clear test activity first if they should go.`
                        : "From now on its sales are its books: nothing of them is cleared from here."
                    }
                    yes="Go live"
                  >
                    Go live
                  </ConfirmSubmit>
                </form>
              </div>
            ) : (
              <form action={actions.backToSettingUp} className="card-body">
                {which}
                <span className="help">
                  Its sales are its books: nothing of them is cleared from here.{" "}
                  {setup.receipts === 0
                    ? "It has no receipt yet, so it can still be taken back to being set up, where a till can be removed and what it is tried with can be cleared."
                    : "It has receipts, so it stays live."}
                </span>
                {setup.receipts === 0 && (
                  <div className="inline" style={{ display: "flex", marginTop: 10 }}>
                    <ConfirmSubmit
                      className="btn-quiet"
                      title={`Take ${tenant.name} back to being set up?`}
                      text="What is rung up on it from now on can be cleared again, until it is put live."
                      yes="Back to setting up"
                    >
                      Back to setting up
                    </ConfirmSubmit>
                  </div>
                )}
              </form>
            )}
          </section>

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
                <span className="help">
                  {PLAN_HELP} Premium MRA is Premium for a business that must send every sale to the MRA (turnover over Rs 40 million a year): choosing it
                  starts the move, and what the move still needs is listed under MRA e-invoicing.
                </span>
                <div className="inline">
                  <select name="plan" defaultValue={mra ? PREMIUM_MRA : tenant.plan} aria-label="Plan">
                    {Array.from(new Set<string>([...PLANS, PREMIUM_MRA, tenant.plan])).map((p) => (
                      <option key={p} value={p}>
                        {p === PREMIUM_MRA ? "Premium MRA" : cap(p)}
                      </option>
                    ))}
                  </select>
                  <Submit className="btn-quiet">Change plan</Submit>
                </div>
              </form>
              {tenant.business_type === "retail" && (
                <form action={actions.setFeatures} className="adm-part">
                  {which}
                  <strong>Extras</strong>
                  <span className="help">
                    Deposits: goods held for a customer who pays part now and collects later. Customer accounts: a named customer takes goods now and pays
                    later, with statements. Premium and trial carry both already; switch one on here for a client on the offline
                    edition who paid for it.
                  </span>
                  <label className="check">
                    <input type="checkbox" name="deposits" defaultChecked={(tenant.features ?? []).includes("deposits")} /> Deposits
                  </label>
                  <label className="check">
                    <input type="checkbox" name="accounts" defaultChecked={(tenant.features ?? []).includes("accounts")} /> Customer accounts
                  </label>
                  <div className="inline">
                    <Submit className="btn-quiet">Save extras</Submit>
                  </div>
                </form>
              )}
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

          {mra && (
            <MraPanel
              tenantId={tenant.id}
              state={asMra(tenant.mra)}
              checklist={checklist}
              tills={tills
                .filter((d) => d.active)
                .map((d) => ({
                  id: d.id,
                  name: d.name,
                  code: d.code,
                  store: stores.find((st) => st.id === d.store_id)?.name ?? "",
                  mra_ebs_id: d.mra_ebs_id,
                  mra_status: d.mra_status,
                }))}
              connection={mraConnection}
              setTillMraIds={actions.setTillMraIds}
              setMra={actions.setMra}
              setMraConnection={actions.setMraConnection}
            />
          )}

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
