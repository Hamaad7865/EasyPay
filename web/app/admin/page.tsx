import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, withTenant } from "@/lib/db";
import { hashPin, isPin } from "@/lib/pin";
import { adminMessage, requirePlatformAdmin } from "@/lib/platform";
import { loginForRestaurant, passwordProblem, removeLogin } from "@/lib/platform-auth";
import { one, type Search, startOf } from "../backoffice/ui";
import { AdminHome, type TenantRow } from "./view";

const fail = (message: string): never => redirect(`/admin?error=${encodeURIComponent(message)}`);

// Creates the owner's login (or takes over one that exists for that email and
// belongs to nobody), then the restaurant around it. If the second step fails,
// a login created here is removed again, so the form can simply be resubmitted.
async function createTenant(formData: FormData) {
  "use server";
  const admin = await requirePlatformAdmin();
  const text = (key: string) => String(formData.get(key) ?? "").trim();
  const name = text("tenant");
  const store = text("store") || "Main store";
  const code = (text("code") || "S1").toUpperCase();
  const ownerName = text("ownerName");
  const email = text("email").toLowerCase();
  const plan = text("plan") || "standard";
  const type = text("type") === "retail" ? "retail" : "restaurant";
  const password = String(formData.get("password") ?? "");
  const pin = String(formData.get("pin") ?? "").trim();

  if (!name) fail("Give the client a name.");
  if (pin && !isPin(pin)) fail("A PIN is 4 digits.");
  if (!ownerName) fail("Give the owner's name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("That email address does not look right.");
  if (!/^[A-Z0-9]{1,12}$/.test(code)) fail("Store code must be 1 to 12 letters or digits.");
  const weak = passwordProblem(password);
  if (weak) fail(weak);

  const login = await loginForRestaurant({ email, password, name: ownerName });
  if (!login.ok) fail(login.message);
  const { userId, created } = login as { userId: string; created: boolean };

  let tenantId = "";
  let ownerId = "";
  try {
    const made = await db().query(`select platform.create_tenant_of_type($1, $2, $3, $4, $5, $6, $7, $8) as r`, [
      admin.userId,
      name,
      store,
      code,
      ownerName,
      userId,
      plan,
      type,
    ]);
    tenantId = made.rows[0].r.tenant_id as string;
    ownerId = made.rows[0].r.employee_id as string;
  } catch (e) {
    if (created) await removeLogin(userId);
    fail(adminMessage(e));
  }
  // The owner's till PIN, when one was typed: written as the client's own
  // Staff page writes one. The client is made by now and stays made if this
  // fails; the PIN is then set from its page, and the notice says so.
  let pinSet = false;
  if (pin) {
    try {
      const set = await withTenant(tenantId, (c) =>
        c.query(`update employees set pin_hash = $3 where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, ownerId, hashPin(pin)]),
      );
      pinSet = set.rowCount === 1;
      if (pinSet) {
        await db().query(
          `insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
           values ($1, 'login.pin', $2, jsonb_build_object('employee_id', $3::text))`,
          [admin.userId, tenantId, ownerId],
        );
      }
    } catch {
      pinSet = false;
    }
  }
  const handOver = pin && pinSet ? "their password and their PIN" : "their password";
  const pinMissed = pin && !pinSet ? " The PIN could not be set: set it under Logins below." : "";
  revalidatePath("/admin");
  // no email, password or PIN in the URL: it ends up in history and logs
  redirect(`/admin/tenants/${tenantId}?notice=${encodeURIComponent(
      (created
        ? `Client created. Give the owner ${handOver}.`
        : `Client created. That email already had a login: it is now the owner, with the password you typed.${pin && pinSet ? " Their PIN is set." : ""}`) + pinMissed,
    )}`);
}

export default async function AdminHomePage({ searchParams }: { searchParams: Search }) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const tenants = await db()
    .query(
      `select t.id, t.name, t.business_type, t.plan, t.status, t.status_reason, t.created_at,
              (select count(*)::int from stores s where s.tenant_id = t.id and s.deleted_at is null) as stores,
              (select count(*)::int from employees e
                where e.tenant_id = t.id and e.auth_user_id is not null and e.deleted_at is null) as logins,
              (select count(*)::int from pos_devices d where d.tenant_id = t.id and d.deleted_at is null) as devices,
              (select max(r.created_at) from receipts r where r.tenant_id = t.id) as last_sale
         from tenants t
        where t.deleted_at is null
        order by t.created_at desc`,
    )
    .then((r) => r.rows as TenantRow[]);
  return (
    <AdminHome
      tenants={tenants}
      // what the list was last asked for: its words, filters and sort are kept in the address
      start={startOf(sp, "q", "status", "type", "sort")}
      error={one(sp.error) || undefined}
      notice={one(sp.notice) || undefined}
      createTenant={createTenant}
    />
  );
}
