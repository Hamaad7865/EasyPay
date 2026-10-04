"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteFloor, renameFloor, saveFloor, type FloorTable } from "./actions";

const PLAN_W = 100;
const PLAN_H = 60;
const MIN = 6;
const SEAT = "M4 18v3h3v-3h10v3h3v-6H4zm15-8h3v3h-3zM2 10h3v3H2zm15 3H7V5c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2v8z";

type Drag = { id: string; mode: "move" | "size"; px: number; py: number; x: number; y: number; w: number; h: number };

// One floor's plan: drag a table to place it, drag its corner to size it,
// pick it to rename it. Add table puts several down at once. Nothing reaches
// the tills until Save.
export function FloorEditor({
  storeId,
  floor,
  initial,
  namesElsewhere,
  occupied,
  canEdit,
  openAdd,
}: {
  storeId: string;
  floor: string;
  initial: FloorTable[];
  namesElsewhere: string[];
  occupied: string[];
  canEdit: boolean;
  openAdd: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"plan" | "settings">("plan");
  const [tables, setTables] = useState<FloorTable[]>(initial);
  const [removed, setRemoved] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [adding, setAdding] = useState(openAdd && canEdit);
  const [rename, setRename] = useState(floor);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const current = tables.find((t) => t.id === selected) ?? null;
  const busy = new Set(occupied);
  const taken = () => new Set([...namesElsewhere, ...tables.map((t) => t.name)].map((n) => n.toLowerCase()));

  const change = (id: string, patch: Partial<FloorTable>) => {
    setTables((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setDirty(true);
    setNote(null);
  };

  // the first free spot on the plan, scanning left to right, among `placed`
  function freeSpot(placed: FloorTable[], w: number, h: number) {
    for (let y = 2; y + h <= PLAN_H; y += h + 3) {
      for (let x = 2; x + w <= PLAN_W; x += w + 3) {
        if (!placed.some((t) => x < t.x + t.w && t.x < x + w && y < t.y + t.h && t.y < y + h)) return { x, y };
      }
    }
    return { x: 2, y: 2 };
  }

  // Add table: `count` tables of `seats` covers, named from `first` upwards
  // ("7" gives 7, 8, 9; "T7" gives T7, T8, T9), skipping names already used.
  function addTables(count: number, seats: number, shape: "square" | "round", first: string) {
    const used = taken();
    const m = /^(.*?)(\d+)$/.exec(first.trim());
    const prefix = m ? m[1] : first.trim() ? first.trim() + " " : "";
    let n = m ? Number(m[2]) : 1;
    const placed = [...tables];
    const made: FloorTable[] = [];
    for (let i = 0; i < count; i++) {
      while (used.has((prefix + n).toLowerCase())) n++;
      const name = (prefix + n).slice(0, 30);
      used.add(name.toLowerCase());
      const t: FloorTable = { id: crypto.randomUUID(), name, area: floor, seats, shape, w: 12, h: 12, ...freeSpot(placed, 12, 12) };
      placed.push(t);
      made.push(t);
    }
    setTables(placed);
    setSelected(made.length === 1 ? made[0].id : null);
    setDirty(true);
    setNote(null);
    setAdding(false);
  }

  function removeTable(t: FloorTable) {
    if (busy.has(t.id) && !window.confirm(`Table ${t.name} has an open order. The order stays open under Orders, without a table. Remove the table?`)) return;
    setTables((all) => all.filter((x) => x.id !== t.id));
    if (initial.some((x) => x.id === t.id)) setRemoved((r) => [...r, t.id]);
    setSelected(null);
    setDirty(true);
    setNote(null);
  }

  function down(e: React.PointerEvent, t: FloorTable, mode: "move" | "size") {
    if (!canEdit) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: t.id, mode, px: e.clientX, py: e.clientY, x: t.x, y: t.y, w: t.w, h: t.h };
    setSelected(t.id);
  }
  function move(e: React.PointerEvent) {
    const d = drag.current;
    const box = canvas.current?.getBoundingClientRect();
    if (!d || !box) return;
    // screen pixels to grid units, snapped to the grid
    const dx = Math.round(((e.clientX - d.px) / box.width) * PLAN_W);
    const dy = Math.round(((e.clientY - d.py) / box.height) * PLAN_H);
    if (dx === 0 && dy === 0) return;
    if (d.mode === "move") {
      change(d.id, { x: Math.min(PLAN_W - d.w, Math.max(0, d.x + dx)), y: Math.min(PLAN_H - d.h, Math.max(0, d.y + dy)) });
    } else {
      change(d.id, { w: Math.min(PLAN_W - d.x, Math.max(MIN, d.w + dx)), h: Math.min(PLAN_H - d.y, Math.max(MIN, d.h + dy)) });
    }
  }
  const up = () => { drag.current = null; };

  async function save() {
    setSaving(true);
    const result = await saveFloor(storeId, tables, removed);
    setSaving(false);
    if ("error" in result) {
      setNote({ kind: "error", text: result.error });
    } else {
      setDirty(false);
      setRemoved([]);
      setNote({ kind: "ok", text: "Saved. The tablets show the new plan after their next sync." });
    }
  }

  async function doRename() {
    const result = await renameFloor(storeId, floor, rename);
    if ("error" in result) setNote({ kind: "error", text: result.error });
    else router.push(`/backoffice/tables/plan?store=${storeId}&floor=${encodeURIComponent(rename.trim().slice(0, 30))}`);
  }
  async function doDelete() {
    const open = initial.filter((t) => busy.has(t.id)).length;
    const warn = open > 0 ? ` ${open} of its tables have an open order; those orders stay open under Orders, without a table.` : "";
    if (!window.confirm(`Remove the floor "${floor}" and its ${initial.length} tables?${warn}`)) return;
    const result = await deleteFloor(storeId, floor);
    if ("error" in result) setNote({ kind: "error", text: result.error });
    else router.push(`/backoffice/tables?store=${storeId}`);
  }

  return (
    <div>
      <h1>{floor}</h1>
      <div className="tabs">
        <a href="#" className={tab === "plan" ? "on" : undefined} onClick={(e) => { e.preventDefault(); setTab("plan"); }}>
          Floor plan
        </a>
        <a href="#" className={tab === "settings" ? "on" : undefined} onClick={(e) => { e.preventDefault(); setTab("settings"); }}>
          Settings
        </a>
      </div>
      {tab === "plan" ? (
        <div className="card floor-card">
          <div className="floor-bar">
            <h2>Floor plan</h2>
            <span className="muted">
              {tables.length} {tables.length === 1 ? "table" : "tables"} · {tables.reduce((a, t) => a + t.seats, 0)} covers
            </span>
            <span className="spacer" />
            {note && <span className={note.kind === "error" ? "flag" : "muted"}>{note.text}</span>}
            {canEdit && (
              <>
                <button type="button" onClick={() => setAdding(true)}>
                  + Add table
                </button>
                <button type="button" className={dirty ? undefined : "btn-quiet"} onClick={save} disabled={!dirty || saving}>
                  {saving ? "Saving…" : dirty ? "Save plan" : "Saved"}
                </button>
              </>
            )}
          </div>
          <div className="floor-wrap">
            <div className="floor-canvas" ref={canvas} onPointerDown={() => setSelected(null)}>
              {tables.length === 0 && <p className="floor-empty">No tables on this floor yet.{canEdit ? " Add some, then drag them into place." : ""}</p>}
              {tables.map((t) => (
                <div
                  key={t.id}
                  className={"floor-table" + (t.shape === "round" ? " round" : "") + (t.id === selected ? " on" : "") + (busy.has(t.id) ? " busy" : "")}
                  style={{ left: `${t.x}%`, top: `${(t.y / PLAN_H) * 100}%`, width: `${t.w}%`, height: `${(t.h / PLAN_H) * 100}%` }}
                  onPointerDown={(e) => down(e, t, "move")}
                  onPointerMove={move}
                  onPointerUp={up}
                  onPointerCancel={up}
                >
                  <strong>{t.name}</strong>
                  <small>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d={SEAT} />
                    </svg>
                    {t.seats}
                  </small>
                  {canEdit && t.id === selected && (
                    <span className="floor-handle" onPointerDown={(e) => down(e, t, "size")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
                  )}
                </div>
              ))}
            </div>
            <aside className="floor-panel">
              {current ? (
                <>
                  <h2>Table {current.name}</h2>
                  {busy.has(current.id) && <p className="flag">Has an open order.</p>}
                  <label>
                    Table number
                    <input value={current.name} maxLength={30} disabled={!canEdit} onChange={(e) => change(current.id, { name: e.target.value })} />
                  </label>
                  <label>
                    Number of covers
                    <input type="number" min={1} max={99} value={current.seats} disabled={!canEdit}
                      onChange={(e) => change(current.id, { seats: Math.min(99, Math.max(1, Number(e.target.value) || 1)) })} />
                  </label>
                  <label>
                    Table type
                    <select value={current.shape} disabled={!canEdit} onChange={(e) => change(current.id, { shape: e.target.value === "round" ? "round" : "square" })}>
                      <option value="square">Square</option>
                      <option value="round">Round</option>
                    </select>
                  </label>
                  {canEdit && (
                    <button type="button" className="btn-quiet" onClick={() => removeTable(current)}>
                      Remove table
                    </button>
                  )}
                </>
              ) : (
                <p className="muted">
                  {canEdit
                    ? "Drag a table to place it. Drag its corner to make it bigger or smaller. Pick a table to change its number or covers."
                    : "Only an owner or a manager can change the plan."}
                </p>
              )}
            </aside>
          </div>
        </div>
      ) : (
        <div className="card">
          {note && <p className={note.kind === "error" ? "flag" : "muted"}>{note.text}</p>}
          {dirty && <p className="flag">Save the plan first; it has changes that are not saved.</p>}
          <label className="field">
            Floor plan name
            <input value={rename} maxLength={30} disabled={!canEdit || dirty} onChange={(e) => setRename(e.target.value)} />
          </label>
          {canEdit && (
            <div className="bo-toolbar">
              <button type="button" onClick={doRename} disabled={dirty || !rename.trim() || rename.trim() === floor}>
                Rename
              </button>
              <button type="button" className="btn-quiet" onClick={doDelete} disabled={dirty}>
                Remove this floor
              </button>
            </div>
          )}
        </div>
      )}
      {adding && <AddTables first={nextNumber(taken())} onCancel={() => setAdding(false)} onDone={addTables} />}
    </div>
  );
}

// the lowest whole number no table is called yet
function nextNumber(used: Set<string>) {
  let n = 1;
  while (used.has(String(n))) n++;
  return String(n);
}

// "Add table": how many, how many covers each, what shape, and the number the first one gets.
function AddTables({
  first,
  onCancel,
  onDone,
}: {
  first: string;
  onCancel: () => void;
  onDone: (count: number, seats: number, shape: "square" | "round", first: string) => void;
}) {
  const [count, setCount] = useState("1");
  const [seats, setSeats] = useState("4");
  const [shape, setShape] = useState<"square" | "round">("square");
  const [number, setNumber] = useState(first);
  const n = Math.min(50, Math.max(1, Number(count) || 1));
  const covers = Math.min(99, Math.max(1, Number(seats) || 1));
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal wide" role="dialog" aria-label="Add table" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Add table</h2>
          <button type="button" className="modal-x" aria-label="Close" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-row">
            <label>
              Number of tables
              <input type="number" min={1} max={50} value={count} autoFocus onChange={(e) => setCount(e.target.value)} />
            </label>
            <label>
              Number of covers
              <input type="number" min={1} max={99} value={seats} onChange={(e) => setSeats(e.target.value)} />
            </label>
          </div>
          <label>Table type</label>
          <div className="shape-pick">
            <button type="button" className={shape === "square" ? "on" : undefined} aria-label="Square" onClick={() => setShape("square")}>
              <span className="shape square" />
            </button>
            <button type="button" className={shape === "round" ? "on" : undefined} aria-label="Round" onClick={() => setShape("round")}>
              <span className="shape round" />
            </button>
          </div>
          <label>
            Table number
            <input value={number} maxLength={30} onChange={(e) => setNumber(e.target.value)} />
          </label>
          <p className="muted">{n > 1 ? `${n} tables, numbered from this one upwards. Numbers already used are skipped.` : "The number shown on the plan and on the tablets."}</p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => onDone(n, covers, shape, number)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
