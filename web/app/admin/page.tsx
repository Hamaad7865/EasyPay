import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
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

  if (!name) fail("Give the client a name.");
  if (!ownerName) fail("Give the owner's name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("That email address does not look right.");
  if (!/^[A-Z0-9]{1,12}$/.test(code)) fail("Store code must be 1 to 12 letters or digits.");
  const weak = passwordProblem(password);
  if (weak) fail(weak);

  const login = await loginForRestaurant({ email, password, name: ownerName });
  if (!login.ok) fail(login.message);
  const { userId, created } = login as { userId: string; created: boolean };

  let tenantId = "";
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
  } catch (e) {
    if (created) await removeLogin(userId);
    fail(adminMessage(e));
  }
  revalidatePath("/admin");
  // no email or password in the URL: it ends up in history and logs
  redirect(`/admin/tenants/${tenantId}?notice=${encodeURIComponent(
      created
        ? "Client created. Give the owner their password."
        : "Client created. That email already had a login: it is now the owner, with the password you typed.",
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
