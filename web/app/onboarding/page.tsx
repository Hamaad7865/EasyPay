import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";
import { platformAdminOrNull } from "@/lib/platform";
import { loginStanding } from "@/lib/tenant";

// There is no self-serve sign-up: restaurants and their logins are created by
// the platform admin. A login that reaches this page is signed in but is not
// let into a back office: it is not linked to a restaurant (or its login was
// switched off), or its role does not hold "Sign in to the back office".
export default async function NotLinkedPage() {
  const { data } = await auth.getSession();
  if (!data?.user) redirect("/login");
  if (await platformAdminOrNull()) redirect("/admin");
  const standing = await loginStanding(data.user.id);
  if (standing === "ok") redirect("/backoffice");
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
        {standing === "no-access" ? (
          <>
            <h1>No back office on this login</h1>
            <p className="auth-lede">
              {data.user.email} is signed in, but its role does not include the back office. The owner can allow it in
              the back office, under Roles and permissions: tick &quot;Sign in to the back office&quot; for this role.
            </p>
          </>
        ) : (
          <>
            <h1>No restaurant on this login</h1>
            <p className="auth-lede">
              {data.user.email} is signed in, but it is not linked to a restaurant, or its access was switched off.
              Restaurants are set up by EasyPay. Contact us to get access.
            </p>
          </>
        )}
        <form action={signOut}>
          <button type="submit">Sign out</button>
        </form>
      </div>
    </main>
  );
}
