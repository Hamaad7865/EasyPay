import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { platformAdminOrNull } from "@/lib/platform";

// There is no self-serve sign-up: restaurants and their logins are created by
// the platform admin. A login that reaches this page is signed in but is not
// linked to a restaurant (or its login was switched off).
export default async function NotLinkedPage() {
  const { data } = await auth.getSession();
  if (!data?.user) redirect("/login");
  if (await platformAdminOrNull()) redirect("/admin");
  const linked = await db().query(
    `select 1 from employees where auth_user_id = $1 and deleted_at is null and is_active limit 1`,
    [data.user.id],
  );
  if (linked.rowCount) redirect("/backoffice");
  async function signOut() {
    "use server";
    await auth.signOut();
    redirect("/login");
  }
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="" className="bo-brand-logo" />
          <span>Easy<span className="bo-brand-pos">Pay</span></span>
        </div>
        <h1>No restaurant on this login</h1>
        <p className="auth-lede">
          {data.user.email} is signed in, but it is not linked to a restaurant, or its access was switched off.
          Restaurants are set up by EasyPay. Contact us to get access.
        </p>
        <form action={signOut}>
          <button type="submit">Sign out</button>
        </form>
      </div>
    </main>
  );
}
