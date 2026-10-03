import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { bearerToken } from "@/lib/tenant";

const FUNCTION_URL = process.env.NEXT_PUBLIC_FUNCTION_URL!;

async function createTenant(formData: FormData) {
  "use server";
  const { data } = await auth.getSession();
  if (!data?.user) redirect("/login");
  const token = await bearerToken();
  const res = await fetch(`${FUNCTION_URL}/signup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      tenantName: formData.get("tenant"),
      storeName: formData.get("store"),
      storeCode: formData.get("code"),
      ownerName: data.user.name ?? "Owner",
    }),
  });
  if (!res.ok) throw new Error("signup failed");
  redirect("/backoffice");
}

export default async function OnboardingPage() {
  const { data } = await auth.getSession();
  if (!data?.user) redirect("/login");
  const linked = await db().query(
    `select 1 from employees where auth_user_id = $1 and deleted_at is null limit 1`,
    [data.user.id],
  );
  if (linked.rowCount) redirect("/backoffice");
  return (
    <main style={{ maxWidth: 480, margin: "80px auto", fontFamily: "system-ui" }}>
      <h1>Your restaurant</h1>
      <form action={createTenant}>
        <p>
          <input name="tenant" placeholder="Restaurant name" required />
        </p>
        <p>
          <input name="store" placeholder="First store" defaultValue="Main store" required />
        </p>
        <p>
          <input name="code" placeholder="Store code" defaultValue="S1" required />
        </p>
        <button type="submit">Create and open back office</button>
      </form>
    </main>
  );
}
