import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { BUSINESS_TYPES, PLANS, adminMessage, requirePlatformAdmin } from "@/lib/platform";
import { loginForRestaurant, passwordProblem, removeLogin, setLoginPassword } from "@/lib/platform-auth";

type Tenant = {
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
type Store = { id: string; name: string; code: string };
type Till = {
  id: string;
  store_id: string;
  name: string;
  code: string;
  app_version: string | null;
  last_seen_at: string | null;
  last_receipt_seq: string;
  active: boolean;
};
type Login = { id: string; name: string; role: string | null; is_active: boolean; email: string | null };
type Audit = { action: string; detail: Record<string, unknown>; created_at: string; admin: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function back(tenantId: string, kind: "error" | "notice", message: string): never {
  redirect(`/admin/tenants/${tenantId}?${kind}=${encodeURIComponent(message)}`);
}

// Every action re-checks the admin and reads the tenant id from the form, then
// goes through a platform.* function that writes its own audit row.
async function tenantOf(formData: FormData): Promise<{ adminId: string; tenantId: string }> {
  const admin = await requirePlatformAdmin();
  const tenantId = String(formData.get("tenant") ?? "");
  if (!UUID.test(tenantId)) notFound();
  return { adminId: admin.userId, tenantId };
}

async function setPlan(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  try {
    await db().query(`select platform.set_tenant_plan($1, $2, $3)`, [adminId, tenantId, String(formData.get("plan") ?? "")]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(tenantId, "notice", "Plan changed.");
}

async function setBusinessType(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  try {
    await db().query(`select platform.set_tenant_business_type($1, $2, $3)`, [adminId, tenantId, String(formData.get("type") ?? "")]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(tenantId, "notice", "Business type saved. Their back office follows at once, their tills at the next sync.");
}

async function setStatus(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const status = String(formData.get("status") ?? "");
  try {
    await db().query(`select platform.set_tenant_status($1, $2, $3, $4)`, [
      adminId,
      tenantId,
      status,
      String(formData.get("reason") ?? ""),
    ]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(tenantId, "notice", status === "active" ? "Reactivated." : "Suspended. Their tills still sync sales already made.");
}

async function addLogin(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!name) back(tenantId, "error", "Give the person's name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) back(tenantId, "error", "That email address does not look right.");
  const weak = passwordProblem(password);
  if (weak) back(tenantId, "error", weak);

  const login = await loginForRestaurant({ email, password, name });
  if (!login.ok) back(tenantId, "error", login.message);
  const { userId, created } = login as { userId: string; created: boolean };
  try {
    await db().query(`select platform.add_login($1, $2, $3, $4, $5)`, [adminId, tenantId, name, role, userId]);
  } catch (e) {
    if (created) await removeLogin(userId);
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(
    tenantId,
    "notice",
    created
      ? "Login created. Give them the password."
      : "That email already had a login: it is now linked here, with the password you typed.",
  );
}

async function setPassword(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const employeeId = String(formData.get("employee") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!UUID.test(employeeId)) notFound();
  const weak = passwordProblem(password);
  if (weak) back(tenantId, "error", weak);
  // the auth user is looked up here, never taken from the form
  const found = await db().query(
    `select auth_user_id from employees where id = $1 and tenant_id = $2 and deleted_at is null`,
    [employeeId, tenantId],
  );
  const userId = found.rows[0]?.auth_user_id as string | undefined;
  if (!userId) back(tenantId, "error", "That login does not exist.");
  const changed = await setLoginPassword(userId as string, password);
  if (!changed.ok) back(tenantId, "error", changed.message);
  await db().query(
    `insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
     values ($1, 'login.password', $2, jsonb_build_object('employee_id', $3::text))`,
    [adminId, tenantId, employeeId],
  );
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(tenantId, "notice", "Password changed. Give them the new one.");
}

async function setDetails(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  try {
    await db().query(`select platform.set_tenant_details($1, $2, $3, $4, $5)`, [
      adminId,
      tenantId,
      String(formData.get("name") ?? ""),
      String(formData.get("brn") ?? ""),
      String(formData.get("vat") ?? ""),
    ]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(tenantId, "notice", "Details saved.");
}

async function addStore(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  try {
    await db().query(`select platform.add_store($1, $2, $3, $4)`, [
      adminId,
      tenantId,
      String(formData.get("name") ?? ""),
      String(formData.get("code") ?? ""),
    ]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(tenantId, "notice", "Store added. Every login of this restaurant can use it.");
}

async function setTillActive(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const deviceId = String(formData.get("device") ?? "");
  const active = formData.get("active") === "true";
  if (!UUID.test(deviceId)) notFound();
  const owned = await db().query(`select 1 from pos_devices where id = $1 and tenant_id = $2`, [deviceId, tenantId]);
  if (!owned.rowCount) back(tenantId, "error", "That till does not exist.");
  try {
    await db().query(`select platform.set_device_active($1, $2, $3)`, [adminId, deviceId, active]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(
    tenantId,
    "notice",
    active
      ? "Till reactivated."
      : "Till deactivated: it cannot register again. A till that is still signed in keeps selling and syncing; switch its login off to stop that.",
  );
}

async function setActive(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const employeeId = String(formData.get("employee") ?? "");
  const active = formData.get("active") === "true";
  if (!UUID.test(employeeId)) notFound();
  const owned = await db().query(`select 1 from employees where id = $1 and tenant_id = $2`, [employeeId, tenantId]);
  if (!owned.rowCount) back(tenantId, "error", "That login does not exist.");
  try {
    await db().query(`select platform.set_login_active($1, $2, $3)`, [adminId, employeeId, active]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(tenantId, "notice", active ? "Login switched on." : "Login switched off.");
}

const ACTIONS: Record<string, string> = {
  "tenant.create": "Restaurant created",
  "tenant.suspended": "Suspended",
  "tenant.active": "Reactivated",
  "tenant.plan": "Plan changed",
  "tenant.business_type": "Business type changed",
  "login.add": "Login added",
  "login.disable": "Login switched off",
  "login.enable": "Login switched on",
  "login.password": "Password changed",
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

export default async function TenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const pool = db();
  const tenant = (
    await pool.query(
      `select id, name, brn, vat_number, plan, business_type, status, status_reason, status_changed_at, created_at
         from tenants where id = $1 and deleted_at is null`,
      [id],
    )
  ).rows[0] as Tenant | undefined;
  if (!tenant) notFound();
  const [stores, tills, logins, roles, audit] = await Promise.all([
    pool
      .query(
        `select s.id, s.name, s.code
           from stores s where s.tenant_id = $1 and s.deleted_at is null order by s.created_at`,
        [id],
      )
      .then((r) => r.rows as Store[]),
    pool
      .query(
        `select d.id, d.store_id, d.name, d.code, d.app_version, d.last_seen_at, d.last_receipt_seq,
                d.deleted_at is null as active
           from pos_devices d where d.tenant_id = $1 order by d.created_at`,
        [id],
      )
      .then((r) => r.rows as Till[]),
    pool
      .query(
        `select e.id, e.name, r.name as role, e.is_active, u.email
           from employees e
           left join roles r on r.id = e.role_id
           left join neon_auth."user" u on u.id = e.auth_user_id
          where e.tenant_id = $1 and e.deleted_at is null and e.auth_user_id is not null
          order by e.created_at`,
        [id],
      )
      .then((r) => r.rows as Login[]),
    pool
      .query(`select name from roles where tenant_id = $1 and deleted_at is null order by name`, [id])
      .then((r) => r.rows.map((x) => x.name as string)),
    pool
      .query(
        `select a.action, a.detail, a.created_at, p.email as admin
           from platform.audit a left join platform.admins p on p.auth_user_id = a.admin_auth_user_id
          where a.tenant_id = $1 order by a.created_at desc limit 30`,
        [id],
      )
      .then((r) => r.rows as Audit[]),
  ]);
  const active = tenant.status === "active";
  const field = { display: "grid", gap: 8, maxWidth: 420 } as const;
  return (
    <div>
      <p>
        <Link href="/admin">All restaurants</Link>
      </p>
      <h1>{tenant.name}</h1>
      {sp.error && <p style={{ color: "#8a1c1c" }}>{sp.error}</p>}
      {sp.notice && <p style={{ color: "#1c6b2a" }}>{sp.notice}</p>}
      <p>
        Type <strong>{tenant.business_type}</strong> · Plan <strong>{tenant.plan}</strong> · Status{" "}
        <strong style={{ color: active ? undefined : "#8a1c1c" }}>{tenant.status}</strong>
        {tenant.status_reason ? ` (${tenant.status_reason})` : ""} · Created{" "}
        {new Date(tenant.created_at).toLocaleDateString()}
      </p>

      <h2>Details</h2>
      <form action={setDetails} style={field}>
        <input type="hidden" name="tenant" value={tenant.id} />
        <input name="name" defaultValue={tenant.name} placeholder="Restaurant name" required />
        <input name="brn" defaultValue={tenant.brn ?? ""} placeholder="BRN" />
        <input name="vat" defaultValue={tenant.vat_number ?? ""} placeholder="VAT number" />
        <button type="submit">Save details</button>
      </form>

      <h2>Business type</h2>
      <form action={setBusinessType} style={{ marginBottom: 12 }}>
        <input type="hidden" name="tenant" value={tenant.id} />
        <select name="type" defaultValue={tenant.business_type} aria-label="Business type">
          {BUSINESS_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>{" "}
        <button type="submit">Change type</button>
        <p style={{ margin: "6px 0 0", color: "#555" }}>
          A restaurant has tables, bookings and the kitchen. A shop has none of them. Changing is refused while the client
          has open orders, and deletes nothing: pages are only hidden.
        </p>
      </form>

      <h2>Plan and status</h2>
      <form action={setPlan} style={{ marginBottom: 12 }}>
        <input type="hidden" name="tenant" value={tenant.id} />
        <select name="plan" defaultValue={tenant.plan}>
          {Array.from(new Set([...PLANS, tenant.plan])).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>{" "}
        <button type="submit">Change plan</button>
      </form>
      {active ? (
        <form action={setStatus} style={field}>
          <input type="hidden" name="tenant" value={tenant.id} />
          <input type="hidden" name="status" value="suspended" />
          <input name="reason" placeholder="Reason, e.g. plan cancelled, unpaid since March" required />
          <button type="submit">Suspend this restaurant</button>
          <small>
            They can still sign in and see their data, and their tills still sync sales already made. They cannot
            change the menu or add tills. Nothing is deleted.
          </small>
        </form>
      ) : (
        <form action={setStatus}>
          <input type="hidden" name="tenant" value={tenant.id} />
          <input type="hidden" name="status" value="active" />
          <button type="submit">Reactivate</button>
        </form>
      )}

      <h2>Stores and tills</h2>
      {stores.map((st) => {
        const here = tills.filter((d) => d.store_id === st.id);
        return (
          <div key={st.id} style={{ marginBottom: 12 }}>
            <strong>
              {st.name} ({st.code})
            </strong>
            {here.length === 0 && <div>No tills registered yet.</div>}
            {here.length > 0 && (
              <table cellPadding={6} style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
                    <th>Till</th>
                    <th>Code</th>
                    <th>Last seen</th>
                    <th>App</th>
                    <th>Receipts</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {here.map((d) => (
                    <tr key={d.id} style={{ borderBottom: "1px solid #eee" }}>
                      <td>{d.name}</td>
                      <td>{d.code}</td>
                      <td>{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "never"}</td>
                      <td>{d.app_version ?? "unknown"}</td>
                      <td>{d.last_receipt_seq}</td>
                      <td>
                        <form action={setTillActive}>
                          <input type="hidden" name="tenant" value={tenant.id} />
                          <input type="hidden" name="device" value={d.id} />
                          <input type="hidden" name="active" value={d.active ? "false" : "true"} />
                          {d.active ? "active" : "deactivated"}{" "}
                          <button type="submit">{d.active ? "Deactivate" : "Reactivate"}</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
      <p>
        <small>
          Deactivating stops a till from registering again. It does not stop a till that is still signed in: that
          till keeps selling and syncing until its login is switched off.
        </small>
      </p>
      <h3>Add a store</h3>
      <form action={addStore} style={field}>
        <input type="hidden" name="tenant" value={tenant.id} />
        <input name="name" placeholder="Store name" required />
        <input name="code" placeholder="Store code, e.g. S2" required />
        <button type="submit">Add store</button>
      </form>

      <h2>Logins</h2>
      <table cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Access</th>
            <th>New password</th>
          </tr>
        </thead>
        <tbody>
          {logins.map((l) => (
            <tr key={l.id} style={{ borderBottom: "1px solid #eee", verticalAlign: "top" }}>
              <td>{l.name}</td>
              <td>{l.email ?? "(login missing)"}</td>
              <td>{l.role ?? "none"}</td>
              <td>
                <form action={setActive}>
                  <input type="hidden" name="tenant" value={tenant.id} />
                  <input type="hidden" name="employee" value={l.id} />
                  <input type="hidden" name="active" value={l.is_active ? "false" : "true"} />
                  {l.is_active ? "on" : "off"} <button type="submit">{l.is_active ? "Switch off" : "Switch on"}</button>
                </form>
                {l.is_active && l.role === "Owner" && (
                  <small>Tills signed in with this login stop syncing if it is switched off.</small>
                )}
              </td>
              <td>
                <form action={setPassword}>
                  <input type="hidden" name="tenant" value={tenant.id} />
                  <input type="hidden" name="employee" value={l.id} />
                  <input
                    name="password"
                    type="password"
                    placeholder="8 characters or more"
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />{" "}
                  <button type="submit">Set</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Add a login</h3>
      <form action={addLogin} style={field}>
        <input type="hidden" name="tenant" value={tenant.id} />
        <input name="name" placeholder="Name" required />
        <input name="email" type="email" placeholder="Email (their login)" required autoComplete="off" />
        <input
          name="password"
          type="password"
          placeholder="Initial password (8 characters or more)"
          required
          minLength={8}
          autoComplete="new-password"
        />
        <select name="role" defaultValue="Manager">
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button type="submit">Create login</button>
      </form>

      <h2>What was done here</h2>
      <ul>
        {audit.map((a, i) => (
          <li key={i}>
            {new Date(a.created_at).toLocaleString()}: {ACTIONS[a.action] ?? a.action}
            {auditNote(a) ? `, ${auditNote(a)}` : ""}
            {a.admin ? ` (by ${a.admin})` : ""}
          </li>
        ))}
      </ul>
      {audit.length === 0 && <p>Nothing yet.</p>}
    </div>
  );
}
