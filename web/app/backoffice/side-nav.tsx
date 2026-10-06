"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { GROUPS, HOME, groupOf, isOn } from "./nav";

// The side menu: the dashboard, then one line per group. A group opens to
// show its pages (they drop in one after the other) and closes the one that
// was open, so the menu never grows past the window.
export function SideNav() {
  const path = usePathname();
  // The group holding the page that is open starts open, on the server and in
  // the browser alike, and opens again whenever the page changes to another
  // group's. Going to the dashboard leaves the menu as it is.
  const [open, setOpen] = useState<string | null>(() => groupOf(path));
  const [seen, setSeen] = useState(path);
  if (seen !== path) {
    setSeen(path);
    const g = groupOf(path);
    if (g) setOpen(g);
  }
  // The settling bounce is for a group someone opened, not for the page loading.
  const [touched, setTouched] = useState(false);

  // The list scrolls without a bar, so the page that is open is brought into
  // view once its group has finished opening.
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const t = setTimeout(() => nav.current?.querySelector("a.on")?.scrollIntoView({ block: "nearest" }), 380);
    return () => clearTimeout(t);
  }, [path]);

  return (
    <nav className="bo-nav" ref={nav} aria-label="Back office" data-touched={touched || undefined}>
      <Link href={HOME.href} className={"bo-nav-top" + (isOn(HOME.href, path) ? " on" : "")}>
        <HOME.icon aria-hidden="true" strokeWidth={1.9} />
        {HOME.label}
      </Link>
      {GROUPS.map((g) => {
        const isOpen = open === g.id;
        const here = g.links.some((l) => isOn(l.href, path));
        return (
          <div key={g.id} className={"bo-group" + (isOpen ? " open" : "") + (here ? " here" : "")}>
            <button
              type="button"
              className="bo-group-head"
              aria-expanded={isOpen}
              aria-controls={`nav-${g.id}`}
              onClick={() => {
                setTouched(true);
                setOpen(isOpen ? null : g.id);
              }}
            >
              <g.icon aria-hidden="true" strokeWidth={1.9} />
              <span>{g.title}</span>
              <ChevronDown aria-hidden="true" className="bo-group-chev" strokeWidth={2.2} />
            </button>
            {/* a closed group's pages are out of reach of the Tab key too */}
            <div id={`nav-${g.id}`} className="bo-group-panel" inert={!isOpen}>
              <div className="bo-group-list">
                {g.links.map((l, i) => (
                  <Link key={l.href} href={l.href} className={isOn(l.href, path) ? "on" : undefined} style={{ "--i": i } as React.CSSProperties}>
                    {l.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </nav>
  );
}
