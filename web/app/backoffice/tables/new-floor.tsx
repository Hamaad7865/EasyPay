"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// The Add button on the floor plan list and its "Create new floor plan"
// dialog. A floor exists once it has a table, so creating one goes straight
// to its plan with the Add table dialog open.
export function NewFloor({ storeId, existing }: { storeId: string; existing: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const clean = name.trim().slice(0, 30);

  function save() {
    if (!clean) return;
    const same = existing.find((f) => f.toLowerCase() === clean.toLowerCase());
    const floor = encodeURIComponent(same ?? clean);
    router.push(`/backoffice/tables/plan?store=${storeId}&floor=${floor}${same ? "" : "&add=1"}`);
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Add
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal" role="dialog" aria-label="Create new floor plan" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Create new floor plan</h2>
              <button type="button" className="modal-x" aria-label="Close" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <label>
                Floor plan name
                <input
                  autoFocus
                  value={name}
                  maxLength={30}
                  placeholder="For example Main, Terrace, Rooftop"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && save()}
                />
              </label>
              <p className="muted">Next you add its tables. A floor with no tables is not kept.</p>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn-quiet" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" onClick={save} disabled={!clean}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
