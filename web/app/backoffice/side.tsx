import { LogOut, Store } from "lucide-react";
import { SideNav } from "./side-nav";
import { SearchBox } from "./search-box";

// The menu: a pane of frosted glass down the left of every page. From the
// top: the name, whose back office this is (with the start of its id, which
// is what to quote to EasyPay support), the search, the pages, and who is
// signed in with the way out.
export function Side({ restaurant, id, employee, role, signOut }: { restaurant: string; id: string; employee: string | null; role: string | null; signOut: () => Promise<void> }) {
  return (
    <aside className="bo-side">
      <div className="bo-brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.png" alt="" className="bo-brand-logo" />
        <span>
          Easy<span className="bo-brand-pos">Pay</span>
        </span>
      </div>
      <div className="bo-restaurant" title={restaurant}>
        <Store aria-hidden="true" />
        <span>
          <b>{restaurant}</b>
          <small>ID {id}</small>
        </span>
      </div>
      <SearchBox />
      <SideNav />
      <div className="bo-user">
        <span className="bo-avatar" aria-hidden="true">
          {(employee ?? "?").trim().slice(0, 1).toUpperCase()}
        </span>
        <span>
          <b>{employee ?? "Signed in"}</b>
          {role && <small>{role}</small>}
        </span>
        <form action={signOut}>
          <button type="submit" title="Sign out" aria-label="Sign out">
            <LogOut aria-hidden="true" />
          </button>
        </form>
      </div>
    </aside>
  );
}
