"use client";

import { useMemo, useRef, useState } from "react";
import { saveFloor, type FloorTable } from "./actions";

const PLAN_W = 100;
const PLAN_H = 60;
const MIN = 6;

type Drag = { id: string; mode: "move" | "size"; px: number; py: number; x: number; y: number; w: number; h: number };

// The floor plan of one store: drag a table to place it, drag its corner to
// size it, pick it to rename it. Nothing reaches the tills until Save.
export function FloorEditor({
  storeId,
  initial,
  occupied,
  canEdit,
}: {
  storeId: string;
  initial: FloorTable[];
  occupied: string[];
  canEdit: boolean;
}) {
  const [tables, setTables] = useState<FloorTable[]>(initial);
  const [removed, setRemoved] = useState<string[]>([]);
  const [extraAreas, setExtraAreas] = useState<string[]>([]);
  const [area, setArea] = useState<string>(initial[0]?.area ?? "Main");
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const areas = useMemo(() => {
    const all = new Set<string>([...tables.map((t) => t.area), ...extraAreas, area]);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [tables, extraAreas, area]);
  const shown = tables.filter((t) => t.area === area);
  const current = tables.find((t) => t.id === selected) ?? null;
  const busy = new Set(occupied);

  const change = (id: string, patch: Partial<FloorTable>) => {
    setTables((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setDirty(true);
    setNote(null);
  };

  function addTable() {
    const used = new Set(tables.map((t) => t.name.toLowerCase()));
    let n = 1;
    while (used.has(String(n))) n++;
    // the first free spot on this area's plan, scanning left to right
    const w = 12, h = 12;
    let spot = { x: 2, y: 2 };
    search: for (let y = 2; y + h <= PLAN_H; y += h + 3) {
      for (let x = 2; x + w <= PLAN_W; x += w + 3) {
        const clash = shown.some((t) => x < t.x + t.w && t.x < x + w && y < t.y + t.h && t.y < y + h);
        if (!clash) { spot = { x, y }; break search; }
      }
    }
    const t: FloorTable = { id: crypto.randomUUID(), name: String(n), area, seats: 4, shape: "square", w, h, ...spot };
    setTables((all) => [...all, t]);
    setSelected(t.id);
    setDirty(true);
    setNote(null);
  }

  function removeTable(t: FloorTable) {
    if (busy.has(t.id) && !window.confirm(`Table ${t.name} has an open order. The order stays open under Orders, without a table. Remove the table?`)) return;
    setTables((all) => all.filter((x) => x.id !== t.id));
    if (initial.some((x) => x.id === t.id)) setRemoved((r) => [...r, t.id]);
    setSelected(null);
    setDirty(true);
    setNote(null);
  }

  function addArea() {
    const name = window.prompt("Name of the new area (for example Terrace)")?.trim().slice(0, 30);
    if (!name) return;
    setExtraAreas((a) => [...a, name]);
    setArea(name);
    setSelected(null);
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
      setNote({ kind: "ok", text: "Saved. The tills show the new plan after their next sync." });
    }
  }

  return (
    <div>
      <div className="floor-bar">
        <div className="bo-chips" style={{ margin: 0 }}>
          {areas.map((a) => (
            <a key={a} href="#" className={a === area ? "on" : undefined} onClick={(e) => { e.preventDefault(); setArea(a); setSelected(null); }}>
              {a} · {tables.filter((t) => t.area === a).length}
            </a>
          ))}
          {canEdit && (
            <a href="#" onClick={(e) => { e.preventDefault(); addArea(); }}>
              + Area
            </a>
          )}
        </div>
        <span className="spacer" />
        {note && <span className={note.kind === "error" ? "flag" : "muted"}>{note.text}</span>}
        {canEdit && (
          <>
            <button type="button" className="btn-quiet" onClick={addTable}>
              Add table
            </button>
            <button type="button" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : dirty ? "Save plan" : "Saved"}
            </button>
          </>
        )}
      </div>
      <div className="floor-wrap">
        <div className="floor-canvas" ref={canvas} onPointerDown={() => setSelected(null)}>
          {shown.length === 0 && <p className="floor-empty">No tables in {area} yet.{canEdit ? " Add one, then drag it into place." : ""}</p>}
          {shown.map((t) => (
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
              <small>{t.seats} seats</small>
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
                Name
                <input value={current.name} maxLength={30} disabled={!canEdit} onChange={(e) => change(current.id, { name: e.target.value })} />
              </label>
              <label>
                Seats
                <input type="number" min={1} max={99} value={current.seats} disabled={!canEdit}
                  onChange={(e) => change(current.id, { seats: Math.min(99, Math.max(1, Number(e.target.value) || 1)) })} />
              </label>
              <label>
                Shape
                <select value={current.shape} disabled={!canEdit} onChange={(e) => change(current.id, { shape: e.target.value === "round" ? "round" : "square" })}>
                  <option value="square">Square</option>
                  <option value="round">Round</option>
                </select>
              </label>
              <label>
                Area
                <select value={current.area} disabled={!canEdit} onChange={(e) => { change(current.id, { area: e.target.value }); setArea(e.target.value); }}>
                  {areas.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              {canEdit && (
                <button type="button" className="btn-quiet" onClick={() => removeTable(current)}>
                  Remove table
                </button>
              )}
            </>
          ) : (
            <>
              <h2>Floor plan</h2>
              <p className="muted">
                {canEdit
                  ? "Drag a table to place it. Drag its corner to make it bigger or smaller. Pick a table to rename it or change its seats."
                  : "Only an owner or a manager can change the plan."}
              </p>
              <p className="muted">The tablets show this plan under Tables. A table with an open order is outlined in amber.</p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
