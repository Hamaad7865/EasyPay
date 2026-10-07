"use client";

import { useState } from "react";
import { Submit } from "../../../backoffice/busy";
import { Chev } from "../../../backoffice/table-kit";
import { Password } from "../../password";

export type Login = { id: string; name: string; role: string | null; is_active: boolean; email: string | null };
type Action = (f: FormData) => Promise<void>;

// A restaurant's logins as the back office shows a list: a line opens on what
// can be done to it, a new password above and switching it off or on below,
// so the list itself stays a list.
export function LoginsTable({ tenant, logins, setPassword, setActive }: { tenant: string; logins: Login[]; setPassword: Action; setActive: Action }) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((was) => (was === id ? null : id));
  return (
    <div className="adm-scroll">
      <table className="rows-open">
        <thead>
          <tr>
            <th />
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Access</th>
          </tr>
        </thead>
        <tbody>
          {logins.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Nobody can sign in for this client yet. Create a login above.
              </td>
            </tr>
          )}
          {logins.map((l) => {
            const on = open === l.id;
            return [
              <tr key={l.id} className={on ? "row on" : "row"} onClick={() => toggle(l.id)}>
                <td>
                  <Chev open={on} name={l.name} onClick={() => toggle(l.id)} />
                </td>
                <td className="strong">{l.name}</td>
                <td>{l.email ?? <span className="flag">Login missing</span>}</td>
                <td>{l.role ?? <span className="muted">None</span>}</td>
                <td>
                  <span className={l.is_active ? "badge green" : "badge"}>{l.is_active ? "On" : "Off"}</span>
                </td>
              </tr>,
              on && (
                <tr key={l.id + "-open"} className="open-body">
                  <td colSpan={5}>
                    <div className="open-panel">
                      <form action={setPassword} className="open-form">
                        <input type="hidden" name="tenant" value={tenant} />
                        <input type="hidden" name="employee" value={l.id} />
                        <Password inline label={`New password for ${l.name}`} placeholder="New password, 8 or more" />
                        <Submit className="btn-sm">Set password</Submit>
                      </form>
                      <form action={setActive} className="open-remove">
                        <input type="hidden" name="tenant" value={tenant} />
                        <input type="hidden" name="employee" value={l.id} />
                        <input type="hidden" name="active" value={l.is_active ? "false" : "true"} />
                        <span className="muted">
                          {l.is_active && l.role === "Owner" ? "Tills signed in with this login stop syncing if it is switched off." : `Access is ${l.is_active ? "on" : "off"}.`}
                        </span>
                        <Submit className={l.is_active ? "btn-link danger" : "btn-link"}>{l.is_active ? "Switch off" : "Switch on"}</Submit>
                      </form>
                    </div>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
