"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";

export type Group = { id: string; name: string; min_select: number; max_select: number; items: number };
// shown: the extra price as the till shows it ("+ Rs 25.00"), or "" when the choice is free
export type Choice = { id: string; group_id: string; name: string; price: string; shown: string };
type Action = (f: FormData) => Promise<void>;

// How many of a group's choices the waiter picks, in words.
function rule(min: number, max: number): string {
  if (min === 0 && max === 0) return "Optional, any number";
  if (min === 0) return max === 1 ? "Optional, one at most" : `Optional, up to ${max}`;
  if (max === 0) return min === 1 ? "At least one" : `At least ${min}`;
  if (min === max) return min === 1 ? "Pick one" : `Pick ${min}`;
  return `Pick ${min} to ${max}`;
}

// The add-on groups as one table. A group is one line: its name, how many of
// its choices are picked, the choices at a glance and how many items carry it.
// Tapping the line opens it: the group's own settings and its choices, to
// change, add or remove. Typing in the search box keeps the groups whose name
// or one of whose choices matches.
export function AddonsTable({
  groups, choices, open: opened, saveGroup, addChoice, saveChoice,
}: {
  groups: Group[]; choices: Choice[]; open: string | null; saveGroup: Action; addChoice: Action; saveChoice: Action;
}) {
  // the group that was just worked on stays open when the page comes back from a save
  const [open, setOpen] = useState<Set<string>>(() => new Set(opened ? [opened] : []));
  const [q, setQ] = useState("");
  const byGroup = useMemo(() => {
    const m = new Map<string, Choice[]>();
    for (const c of choices) m.set(c.group_id, [...(m.get(c.group_id) ?? []), c]);
    return m;
  }, [choices]);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? groups.filter((g) => g.name.toLowerCase().includes(needle) || (byGroup.get(g.id) ?? []).some((c) => c.name.toLowerCase().includes(needle)))
    : groups;
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>Groups</h2>
          <p>
            {needle ? `${shown.length} of ${groups.length}` : groups.length} {groups.length === 1 ? "group" : "groups"} · {choices.length}{" "}
            {choices.length === 1 ? "choice" : "choices"}. Tap a group to open it.
          </p>
        </div>
        <label className="table-search">
          <Search aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups and choices" aria-label="Search groups and choices" />
        </label>
      </div>
      <table className="rows-open">
        <thead>
          <tr>
            <th />
            <th>Group</th>
            <th>The waiter picks</th>
            <th>Choices</th>
            <th>Used on</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={5} className="muted" style={{ textAlign: "center", padding: "28px 16px" }}>
                No group or choice matches “{q.trim()}”.
              </td>
            </tr>
          )}
          {shown.map((g) => {
            const mine = byGroup.get(g.id) ?? [];
            const on = open.has(g.id);
            // a search that found the group by one of its choices says which
            const hit = needle && !g.name.toLowerCase().includes(needle) ? mine.filter((c) => c.name.toLowerCase().includes(needle)) : [];
            return [
              <tr key={g.id} className={on ? "row on" : "row"} onClick={() => toggle(g.id)}>
                <td>
                  <button type="button" className="chev" aria-expanded={on} aria-label={(on ? "Close " : "Open ") + g.name} onClick={(e) => { e.stopPropagation(); toggle(g.id); }}>
                    <ChevronRight aria-hidden="true" />
                  </button>
                </td>
                <td className="strong">{g.name}</td>
                <td>{rule(g.min_select, g.max_select)}</td>
                <td className="clip">
                  {mine.length === 0 ? (
                    <span className="badge amber">No choices yet</span>
                  ) : (
                    <>
                      <span className="count">{mine.length}</span>
                      <span className="muted">{(hit.length > 0 ? hit : mine).map((c) => c.name).join(", ")}</span>
                    </>
                  )}
                </td>
                <td>{g.items === 0 ? <span className="muted">No item</span> : `${g.items} ${g.items === 1 ? "item" : "items"}`}</td>
              </tr>,
              on && (
                <tr key={g.id + "-open"} className="open-body">
                  <td colSpan={5}>
                    <div className="open-panel">
                      <form action={saveGroup} className="bo-toolbar" style={{ margin: 0 }}>
                        <input type="hidden" name="id" value={g.id} />
                        <input name="name" defaultValue={g.name} required maxLength={40} aria-label="Group name" style={{ fontWeight: 600 }} />
                        <label className="inline muted">
                          Pick at least
                          <input name="min" type="number" min={0} max={20} defaultValue={g.min_select} className="narrow" style={{ width: 64 }} />
                        </label>
                        <label className="inline muted">
                          at most
                          <input name="max" type="number" min={0} max={20} defaultValue={g.max_select} className="narrow" style={{ width: 64 }} />
                          <span>(0 = any)</span>
                        </label>
                        <span className="spacer" />
                        <button type="submit" className="btn-quiet btn-sm">Save group</button>
                        <button type="submit" name="remove" value="1" className="btn-link danger" formNoValidate>
                          Remove group
                        </button>
                      </form>
                      <table>
                        <thead>
                          <tr>
                            <th>Choice</th>
                            <th>Extra price (Rs)</th>
                            <th>The till shows</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {mine.map((m) => (
                            <tr key={m.id}>
                              <td><input form={"m" + m.id} name="name" defaultValue={m.name} required maxLength={40} aria-label="Choice" /></td>
                              <td><input form={"m" + m.id} name="price" defaultValue={(Number(m.price) / 100).toString()} className="narrow" inputMode="decimal" aria-label="Extra price" /></td>
                              <td>{m.shown || <span className="muted">Free</span>}</td>
                              <td>
                                <form id={"m" + m.id} action={saveChoice} className="row-actions">
                                  <input type="hidden" name="id" value={m.id} />
                                  <input type="hidden" name="group" value={g.id} />
                                  <button type="submit" className="btn-quiet btn-sm">Save</button>
                                  <button type="submit" name="remove" value="1" className="btn-link danger" formNoValidate>Remove</button>
                                </form>
                              </td>
                            </tr>
                          ))}
                          <tr>
                            <td><input form={"n" + g.id} name="name" placeholder="New choice, e.g. Extra cheese" required maxLength={40} aria-label="New choice" style={{ minWidth: 280 }} /></td>
                            <td><input form={"n" + g.id} name="price" placeholder="0" className="narrow" inputMode="decimal" aria-label="Extra price" /></td>
                            <td />
                            <td>
                              <form id={"n" + g.id} action={addChoice} className="row-actions">
                                <input type="hidden" name="group" value={g.id} />
                                <button type="submit" className="btn-sm">Add choice</button>
                              </form>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </section>
  );
}
