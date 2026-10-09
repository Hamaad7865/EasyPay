import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { db, withTenant } from "@/lib/db";
import { hashPin, isPin } from "@/lib/pin";
import { adminMessage, requirePlatformAdmin } from "@/lib/platform";
import { loginForRestaurant, passwordProblem, removeLogin, setLoginPassword } from "@/lib/platform-auth";
import { type Audit, type Login, type Store, type Tenant, TenantView, type Till } from "./view";

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

// The PIN a login opens the till with. A client's staff get theirs from the
// client, under Staff in its back office; this is for a client being started,
// so that its owner can open the till the day it is handed over. Written the
// way that page writes it (the till checks the same hash, offline). The PIN
// goes nowhere else: not into the audit log, not into a URL.
async function setPin(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const employeeId = String(formData.get("employee") ?? "");
  const pin = String(formData.get("pin") ?? "");
  if (!UUID.test(employeeId)) notFound();
  if (!isPin(pin)) back(tenantId, "error", "A PIN is 4 digits.");
  const name = await withTenant(tenantId, (c) =>
    c
      .query(
        `update employees set pin_hash = $3
          where tenant_id = $1 and id = $2 and deleted_at is null and auth_user_id is not null returning name`,
        [tenantId, employeeId, hashPin(pin)],
      )
      .then((r) => (r.rows[0]?.name as string | undefined) ?? null),
  );
  if (!name) back(tenantId, "error", "That login does not exist.");
  await db().query(
    `insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
     values ($1, 'login.pin', $2, jsonb_build_object('employee_id', $3::text))`,
    [adminId, tenantId, employeeId],
  );
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(tenantId, "notice", `PIN set for ${name}. Give it to them. A till has it after its next sync.`);
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
  back(tenantId, "notice", "Store added. Every login of this client can use it.");
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
        `select e.id, e.name, r.name as role, e.is_active, u.email, e.pin_hash is not null as has_pin
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
  return (
    <TenantView
      tenant={tenant}
      stores={stores}
      tills={tills}
      logins={logins}
      roles={roles}
      audit={audit}
      error={sp.error}
      notice={sp.notice}
      actions={{ setDetails, setPlan, setBusinessType, setStatus, addStore, setTillActive, addLogin, setPassword, setPin, setActive }}
    />
  );
}
