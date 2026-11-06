"use client";

import { useState } from "react";
import { Submit } from "../../../backoffice/busy";

type Action = (f: FormData) => Promise<void>;

// A till's name and code, changed on its own row (0158). The code is in every
// number the till gives, so once something carries it the database keeps it
// and the page says why; the name can always change.
export function RenameTill({ tenant, till, name, code, action }: { tenant: string; till: string; name: string; code: string; action: Action }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="btn-quiet btn-sm" onClick={() => setOpen(true)}>
        Rename
      </button>
    );
  }
  return (
    <form action={action} className="till-rename">
      <input type="hidden" name="tenant" value={tenant} />
      <input type="hidden" name="device" value={till} />
      <input name="name" defaultValue={name} aria-label={`Name of ${name}`} placeholder="Name" maxLength={40} required autoFocus />
      <input
        name="code"
        defaultValue={code}
        aria-label={`Code of ${name}`}
        placeholder="T1"
        maxLength={12}
        pattern="[A-Za-z0-9]{1,12}"
        title="Letters and digits, up to 12"
        required
        className="till-code"
      />
      <Submit className="btn-sm">Save</Submit>
      <button type="button" className="btn-quiet btn-sm" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
