import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { db, withTenant } from "@/lib/db";
import { hashPin, isPin } from "@/lib/pin";
import { isOffline } from "@/lib/plan";
import { adminMessage, requirePlatformAdmin } from "@/lib/platform";
import { loginForRestaurant, passwordProblem, removeLogin, setLoginPassword } from "@/lib/platform-auth";
import { AS_COOKIE, AS_PATH, adminInside } from "@/lib/tenant";
import type { CodeAnswer, TabletCode } from "./tablets";
import { type Audit, type Login, type Setup, type Store, type Tenant, TenantView, type Till } from "./view";

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

// "Login to back office": EasyPay goes into an offline client's back office,
// to set the business up for its owner (lib/tenant.ts, adminInside). Only an
// offline client's: it has none of its own, and nothing of its sales is here.
// What the tablet has of it comes when someone taps "Get changes from
// EasyPay" on it. That the admin went in is written in what was done here;
// the cookie it leaves names the client and nothing else, lasts a working
// day, and is asked about again on every page of the back office.
async function openBackOffice(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const found = await db().query(`select plan from tenants where id = $1 and deleted_at is null`, [tenantId]);
  if (!found.rowCount) notFound();
  if (!isOffline(found.rows[0].plan)) {
    back(tenantId, "error", "Only an offline client's back office is opened from here. A client on another plan has its own, and signs in to it.");
  }
  if (!(await adminInside(adminId, tenantId))) {
    back(tenantId, "error", "This client has nobody whose role holds everything, so there is no owner to set it up as. Add a login with the Owner role first.");
  }
  await db().query(
    `insert into platform.audit (admin_auth_user_id, action, tenant_id, detail) values ($1, 'backoffice.open', $2, '{}'::jsonb)`,
    [adminId, tenantId],
  );
  (await cookies()).set(AS_COOKIE, tenantId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: AS_PATH,
    maxAge: 8 * 60 * 60,
  });
  redirect("/backoffice");
}

// The extras a client pays for beyond its plan (0113): deposits, for now. The
// tills learn them through the settings they pull, as they learn the plan.
async function setFeatures(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const features = ["deposits", "accounts"].filter((f) => formData.get(f) === "on");
  try {
    await db().query(`select platform.set_tenant_features($1, $2, $3::text[])`, [adminId, tenantId, features]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(
    tenantId,
    "notice",
    (features.length ? `Extras now: ${features.map((f) => (f === "accounts" ? "customer accounts" : f)).join(", ")}. The tills take it at their next sync; a tablet working alone when it gets changes from EasyPay.` : "No extras now.") +
      " Deposits already taken and bills already on account can still be dealt with at a till.",
  );
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

// A code that sets up one tablet (migration 0099). The code is the answer to
// the form and is shown on the page that asked, once: it is never put in the
// page's address, as a notice is, nor in what was done here.
async function addTablet(_was: CodeAnswer, formData: FormData): Promise<CodeAnswer> {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const storeId = String(formData.get("store") ?? "");
  if (!UUID.test(storeId)) notFound();
  const owned = await db().query(`select name from stores where id = $1 and tenant_id = $2 and deleted_at is null`, [storeId, tenantId]);
  if (!owned.rowCount) return { error: "That store does not exist." };
  try {
    const made = (await db().query(`select platform.tablet_code_add($1, $2) as r`, [adminId, storeId])).rows[0].r as { id: string; code: string };
    revalidatePath(`/admin/tenants/${tenantId}`);
    return { id: made.id, code: made.code, what: `Code for a new tablet in ${owned.rows[0].name}` };
  } catch (e) {
    return { error: adminMessage(e) };
  }
}

// The tablet of a till is being replaced: the till's key ends at once, and the
// tablet set up with the new code becomes that till.
async function moveTablet(_was: CodeAnswer, formData: FormData): Promise<CodeAnswer> {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const deviceId = String(formData.get("device") ?? "");
  if (!UUID.test(deviceId)) notFound();
  const owned = await db().query(`select name, code from pos_devices where id = $1 and tenant_id = $2`, [deviceId, tenantId]);
  if (!owned.rowCount) return { error: "That till does not exist." };
  try {
    const made = (await db().query(`select platform.tablet_code_move($1, $2) as r`, [adminId, deviceId])).rows[0].r as { id: string; code: string };
    revalidatePath(`/admin/tenants/${tenantId}`);
    return { id: made.id, code: made.code, what: `Code for the tablet that replaces ${owned.rows[0].name} (${owned.rows[0].code})` };
  } catch (e) {
    return { error: adminMessage(e) };
  }
}

async function endCode(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const codeId = String(formData.get("code") ?? "");
  if (!UUID.test(codeId)) notFound();
  const owned = await db().query(`select 1 from tablet_codes where id = $1 and tenant_id = $2`, [codeId, tenantId]);
  if (!owned.rowCount) back(tenantId, "error", "That code does not exist.");
  try {
    await db().query(`select platform.tablet_code_end($1, $2)`, [adminId, codeId]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(tenantId, "notice", "Code taken back. It sets up nothing now.");
}

// A code that waits or is over is taken off the list (migration 0104). One in
// use is a tablet at work: it goes with its till.
async function removeCode(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const codeId = String(formData.get("code") ?? "");
  if (!UUID.test(codeId)) notFound();
  const owned = await db().query(`select 1 from tablet_codes where id = $1 and tenant_id = $2`, [codeId, tenantId]);
  if (!owned.rowCount) back(tenantId, "error", "That code does not exist.");
  try {
    await db().query(`select platform.remove_code($1, $2)`, [adminId, codeId]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(tenantId, "notice", "Code removed.");
}

// A till with nothing recorded is removed, with its key and its codes: its
// number is free again. What the database refuses (a till that sold, or the
// till of a live client that runs on its tablet) comes back in words.
async function removeTill(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const deviceId = String(formData.get("device") ?? "");
  if (!UUID.test(deviceId)) notFound();
  const owned = await db().query(`select name from pos_devices where id = $1 and tenant_id = $2`, [deviceId, tenantId]);
  if (!owned.rowCount) back(tenantId, "error", "That till does not exist.");
  try {
    await db().query(`select platform.remove_till($1, $2)`, [adminId, deviceId]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  revalidatePath("/admin");
  back(
    tenantId,
    "notice",
    `${owned.rows[0].name} removed, with its key and its codes. The tablet that was it is set up again only after the EasyPay app's data is cleared on it.`,
  );
}

async function goLive(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  try {
    await db().query(`select platform.go_live($1, $2)`, [adminId, tenantId]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  revalidatePath("/admin");
  back(tenantId, "notice", "This client is live. From now on its sales are its books: nothing of them is cleared from here.");
}

async function backToSettingUp(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  try {
    await db().query(`select platform.back_to_setting_up($1, $2)`, [adminId, tenantId]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  revalidatePath("/admin");
  back(tenantId, "notice", "This client is being set up again.");
}

// What a client being set up was tried with is cleared: its sales and its
// tills go, its set-up stays (migration 0104). The client's name is typed, as
// its own "Delete all transactions" asks: this cannot be undone from here.
async function clearTest(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  const found = await db().query(`select name from tenants where id = $1 and deleted_at is null`, [tenantId]);
  if (!found.rowCount) notFound();
  if (String(formData.get("confirm") ?? "").trim().toLowerCase() !== String(found.rows[0].name).trim().toLowerCase()) {
    back(tenantId, "error", "The name you typed is not this client's name. Nothing was cleared.");
  }
  let r = { receipts: 0, orders: 0, tills: 0, codes: 0 };
  try {
    r = (await db().query(`select platform.clear_test_activity($1, $2) as r`, [adminId, tenantId])).rows[0].r;
  } catch (e) {
    // a till that was sending at that moment held a row: nothing was done
    const busy = e instanceof Error && /lock timeout|deadlock/i.test(e.message);
    back(tenantId, "error", busy ? "A till was sending its sales at that moment. Nothing was cleared: try again." : adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  revalidatePath("/admin");
  const n = (v: number, one: string) => `${Number(v)} ${one}${Number(v) === 1 ? "" : "s"}`;
  back(
    tenantId,
    "notice",
    `Cleared: ${n(r.receipts, "receipt")}, ${n(r.orders, "order")}, ${n(r.tills, "till")} and ${n(r.codes, "code")}. The menu, stock, staff and settings are as they were. Clear the EasyPay app's data on each tablet, then set it up again.`,
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
      `select id, name, brn, vat_number, plan, business_type, status, status_reason, status_changed_at, created_at, features
         from tenants where id = $1 and deleted_at is null`,
      [id],
    )
  ).rows[0] as Tenant | undefined;
  if (!tenant) notFound();
  const [stores, tills, logins, roles, audit, codes, setup] = await Promise.all([
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
                d.deleted_at is null as active, platform.till_is_bare(d.tenant_id, d.id) as bare
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
    pool.query(`select platform.tablet_codes($1) as r`, [id]).then((r) => (r.rows[0]?.r ?? []) as TabletCode[]),
    pool
      .query(
        `select platform.is_setting_up($1) as "settingUp",
                (select count(*)::int from receipts where tenant_id = $1) as receipts,
                (select count(*)::int from tickets where tenant_id = $1) as orders`,
        [id],
      )
      .then((r) => r.rows[0] as Setup),
  ]);
  return (
    <TenantView
      tenant={tenant}
      stores={stores}
      tills={tills}
      logins={logins}
      roles={roles}
      audit={audit}
      codes={codes}
      setup={setup}
      error={sp.error}
      notice={sp.notice}
      actions={{
        setDetails, setPlan, setFeatures, setBusinessType, setStatus, addStore, setTillActive, addLogin, setPassword, setPin, setActive,
        addTablet, moveTablet, endCode, openBackOffice, removeTill, removeCode, goLive, backToSettingUp, clearTest,
      }}
    />
  );
}
