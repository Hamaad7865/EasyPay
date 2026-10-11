"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical,
  Armchair, Check, Circle, CircleDot, DoorOpen, Grid3x3, Hand, LayoutTemplate, Magnet, Maximize, Minus, MousePointer2, Pencil, Plus,
  RectangleHorizontal, Redo2, RotateCcw, RotateCw, Square, Trash2, Undo2, Wine, ZoomIn, ZoomOut,
} from "lucide-react";
import { deleteFloor, renameFloor, saveFloor, type FloorElement, type FloorTable } from "./actions";

// The floor plan, an area at a time. Tables come off the list on the left
// (tap one, or drag it onto the plan), are dragged to their place and by
// their corner to their size, and are picked to change their number or
// covers. Several can be picked at once (Shift) to move or line up together.
// Every step can be undone. Nothing reaches the tablets until Save: a plan
// half drawn is not what a till should seat people on.
//
// The plan is 100 by 60 units (migration 0048); a till fits it to its own
// screen. Positions and sizes are whole units, so everything sits on the
// grid whether its lines are shown or not.
//
// Since migration 0102 a piece can be set at an angle (the round handle
// above it, in steps of 15 degrees; Alt for any angle), a table can be a
// booth or a bar stool, and the room has what stands in it: walls, doors,
// windows, a bar counter. Those are picked, moved, sized and turned like a
// table, and have no number and no seats. A piece's place and size are its
// rectangle before it is turned, and that rectangle is what stays on the plan.

const PLAN_W = 100;
const PLAN_H = 60;
const MIN = 6;
const TURN = 15;
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];

type Kind = { id: string; label: string; shape: FloorTable["shape"]; w: number; h: number; seats: number };
// The kinds of table. A rectangle and a long table are a square one with
// another width and depth; a booth has a bench down each long side; a bar
// stool is one seat.
const KINDS: Kind[] = [
  { id: "square", label: "Square", shape: "square", w: 12, h: 12, seats: 4 },
  { id: "round", label: "Round", shape: "round", w: 12, h: 12, seats: 4 },
  { id: "rect", label: "Rectangle", shape: "square", w: 18, h: 12, seats: 6 },
  { id: "long", label: "Long table", shape: "square", w: 30, h: 10, seats: 10 },
  { id: "stool", label: "Bar stool", shape: "stool", w: 6, h: 6, seats: 1 },
  { id: "booth", label: "Booth", shape: "booth", w: 18, h: 12, seats: 4 },
];
// What stands in a room beside its tables, and the size each starts at.
const ROOM: { kind: FloorElement["kind"]; label: string; w: number; h: number }[] = [
  { kind: "wall", label: "Wall", w: 30, h: 1 },
  { kind: "door", label: "Door", w: 8, h: 2 },
  { kind: "window", label: "Window", w: 12, h: 1 },
  { kind: "bar", label: "Bar counter", w: 24, h: 6 },
];
const roomLabel = (kind: string) => ROOM.find((r) => r.kind === kind)?.label ?? "Piece";

type Spot = { shape: "square" | "round"; x: number; y: number; w: number; h: number; seats: number };
const row = (n: number, y: number, s: Omit<Spot, "x" | "y">, x0 = 4, gap = 4): Spot[] =>
  Array.from({ length: n }, (_, i) => ({ ...s, x: x0 + i * (s.w + gap), y }));
// Rooms to start from. Each replaces the tables the area holds; what stands in it stays.
const TEMPLATES: { id: string; label: string; say: string; spots: Spot[] }[] = [
  { id: "rows", label: "Rows of four", say: "12 square tables in three rows",
    spots: [4, 23, 42].flatMap((y) => row(4, y, { shape: "square", w: 12, h: 12, seats: 4 }, 8, 12)) },
  { id: "bistro", label: "Bistro", say: "10 round tables for two, close set",
    spots: [6, 24, 42].flatMap((y, r) => row(r === 1 ? 4 : 3, y, { shape: "round", w: 10, h: 10, seats: 2 }, r === 1 ? 8 : 20, 14)) },
  { id: "banquet", label: "Banquet", say: "4 long tables of ten",
    spots: [8, 38].flatMap((y) => row(2, y, { shape: "square", w: 36, h: 10, seats: 10 }, 8, 12)) },
  { id: "mixed", label: "Mixed room", say: "squares by the wall, rounds in the middle, two long tables",
    spots: [...row(5, 4, { shape: "square", w: 10, h: 10, seats: 2 }, 6, 8), ...row(3, 22, { shape: "round", w: 14, h: 14, seats: 6 }, 12, 18),
      ...row(2, 44, { shape: "square", w: 30, h: 10, seats: 8 }, 12, 16)] },
];

type Box = { x: number; y: number; w: number; h: number };
type Snap = { tables: FloorTable[]; removed: string[]; elements: FloorElement[]; removedEls: string[] };
type Drag = { mode: "move" | "size" | "turn"; px: number; py: number; from: Map<string, Box>; before: Snap; moved: boolean };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const turned = (deg: number) => ((Math.round(deg) % 360) + 360) % 360;

// the first free spot on the plan, scanning left to right
function freeSpot(placed: Box[], w: number, h: number) {
  for (let y = 2; y + h <= PLAN_H; y += 2) {
    for (let x = 2; x + w <= PLAN_W; x += 2) {
      if (!placed.some((t) => overlap({ x: x - 1, y: y - 1, w: w + 2, h: h + 2 }, t))) return { x, y };
    }
  }
  return { x: 2, y: 2 };
}

// Where the chairs go, as places round the table's edge: evenly round a round
// one, down the two long sides of the others (one a side at a square four).
// A booth has benches and a bar stool is the seat itself: neither has chairs.
function chairs(t: FloorTable): { left: string; top: string; turn: number }[] {
  if (t.shape === "booth" || t.shape === "stool") return [];
  const n = Math.min(t.seats, 16);
  if (t.shape === "round") {
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      return { left: `calc(50% + ${Math.cos(a).toFixed(3)} * (50% + 7px))`, top: `calc(50% + ${Math.sin(a).toFixed(3)} * (50% + 7px))`, turn: (a * 180) / Math.PI + 90 };
    });
  }
  const out: { left: string; top: string; turn: number }[] = [];
  const side = (count: number, where: "top" | "bottom" | "left" | "right") => {
    for (let i = 0; i < count; i++) {
      const at = `${(((i + 0.5) / count) * 100).toFixed(1)}%`;
      if (where === "top") out.push({ left: at, top: "-7px", turn: 0 });
      if (where === "bottom") out.push({ left: at, top: "calc(100% + 7px)", turn: 0 });
      if (where === "left") out.push({ left: "-7px", top: at, turn: 90 });
      if (where === "right") out.push({ left: "calc(100% + 7px)", top: at, turn: 90 });
    }
  };
  const wide = t.w >= t.h;
  if (n <= 4 && Math.abs(t.w - t.h) <= 2) {
    (["top", "bottom", "left", "right"] as const).slice(0, n).forEach((w) => side(1, w));
  } else {
    // a seat at each end of a long table, the rest down its sides
    const ends = n >= 6 ? 2 : 0;
    const a = Math.ceil((n - ends) / 2), b = n - ends - a;
    side(a, wide ? "top" : "left");
    side(b, wide ? "bottom" : "right");
    if (ends) { side(1, wide ? "left" : "top"); side(1, wide ? "right" : "bottom"); }
  }
  return out;
}

export function FloorDesigner({
  storeId, floor, floors, initial, initialElements, namesElsewhere, occupied, canEdit, saved,
}: {
  storeId: string;
  floor: string;
  floors: string[];
  initial: FloorTable[];
  initialElements: FloorElement[];
  namesElsewhere: string[];
  occupied: string[];
  canEdit: boolean;
  // false for an area just named, with nothing saved in it yet
  saved: boolean;
}) {
  const router = useRouter();
  const [tables, setTables] = useState<FloorTable[]>(initial);
  const [removed, setRemoved] = useState<string[]>([]);
  const [elements, setElements] = useState<FloorElement[]>(initialElements);
  const [removedEls, setRemovedEls] = useState<string[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  // What was, and what was undone: kept beside the screen's own state and
  // changed at once, so that two steps taken in a row are two steps.
  const hist = useRef<{ past: Snap[]; future: Snap[] }>({ past: [], future: [] });
  const [, redraw] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [grid, setGrid] = useState(true);
  const [snap, setSnap] = useState(true);
  const [tool, setTool] = useState<"pick" | "pan">("pick");
  const [dialog, setDialog] = useState<null | "area" | "new" | "template">(null);
  const plan = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const state = useRef<Snap>({ tables, removed, elements, removedEls });
  state.current = { tables, removed, elements, removedEls };

  const busy = new Set(occupied);
  const picked = tables.filter((t) => sel.includes(t.id));
  const pickedEls = elements.filter((e) => sel.includes(e.id));
  const count = picked.length + pickedEls.length;
  const one = count === 1 ? picked[0] ?? null : null;
  const oneEl = count === 1 ? pickedEls[0] ?? null : null;
  const taken = () => new Set([...namesElsewhere, ...state.current.tables.map((t) => t.name)].map((n) => n.trim().toLowerCase()));
  const boxes = (): Box[] => [...state.current.tables, ...state.current.elements];

  // a plan with changes not saved is not left without a word
  useEffect(() => {
    if (!dirty) return;
    const stop = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", stop);
    return () => window.removeEventListener("beforeunload", stop);
  }, [dirty]);

  // the plan as it now stands, on the screen and for the step after this one
  const show = (now: Snap) => {
    state.current = now;
    setTables(now.tables); setRemoved(now.removed); setElements(now.elements); setRemovedEls(now.removedEls);
    setSel((ids) => ids.filter((id) => now.tables.some((t) => t.id === id) || now.elements.some((e) => e.id === id)));
    setDirty(true); setNote(null);
    redraw((n) => n + 1);
  };
  // one step of work: what the plan was is kept so that it can be undone
  const commit = (before: Snap, next: Partial<Snap>) => {
    hist.current = { past: [...hist.current.past.slice(-59), before], future: [] };
    show({ ...before, ...next });
  };
  // every picked piece changed the same way, tables and what stands round them alike
  const change = (how: <T extends Box & { rotation: number }>(p: T) => T, ids = sel) =>
    commit(state.current, {
      tables: state.current.tables.map((t) => (ids.includes(t.id) ? how(t) : t)),
      elements: state.current.elements.map((e) => (ids.includes(e.id) ? how(e) : e)),
    });
  const changeTable = (id: string, how: (t: FloorTable) => FloorTable) =>
    commit(state.current, { tables: state.current.tables.map((t) => (t.id === id ? how(t) : t)) });
  const changeEl = (id: string, how: (e: FloorElement) => FloorElement) =>
    commit(state.current, { elements: state.current.elements.map((e) => (e.id === id ? how(e) : e)) });

  const undo = () => {
    const { past, future } = hist.current;
    const last = past[past.length - 1];
    if (!last) return;
    hist.current = { past: past.slice(0, -1), future: [state.current, ...future] };
    show(last);
  };
  const redo = () => {
    const { past, future } = hist.current;
    const next = future[0];
    if (!next) return;
    hist.current = { past: [...past, state.current], future: future.slice(1) };
    show(next);
  };

  // the next number no table of the store has
  function nextName(used: Set<string>) {
    let n = 1;
    while (used.has(String(n))) n++;
    used.add(String(n));
    return String(n);
  }

  function add(kind: Kind, at?: { x: number; y: number }) {
    if (!canEdit) return;
    const spot = at ?? freeSpot(boxes(), kind.w, kind.h);
    const t: FloorTable = {
      id: crypto.randomUUID(), name: nextName(taken()), area: floor, seats: kind.seats, shape: kind.shape, w: kind.w, h: kind.h,
      x: clamp(spot.x, 0, PLAN_W - kind.w), y: clamp(spot.y, 0, PLAN_H - kind.h), rotation: 0,
    };
    commit(state.current, { tables: [...state.current.tables, t] });
    setSel([t.id]);
  }
  function addEl(r: (typeof ROOM)[number], at?: { x: number; y: number }) {
    if (!canEdit) return;
    const spot = at ?? freeSpot(boxes(), r.w, r.h);
    const e: FloorElement = { id: crypto.randomUUID(), kind: r.kind, w: r.w, h: r.h, x: clamp(spot.x, 0, PLAN_W - r.w), y: clamp(spot.y, 0, PLAN_H - r.h), rotation: 0 };
    commit(state.current, { elements: [...state.current.elements, e] });
    setSel([e.id]);
  }

  function remove(ids: string[]) {
    const now = state.current;
    const going = now.tables.filter((t) => ids.includes(t.id));
    const open = going.filter((t) => busy.has(t.id));
    if (open.length > 0 && !window.confirm(
      `${open.length === 1 ? `Table ${open[0].name} has` : `${open.length} of these tables have`} an open order. The order stays open under Orders, without a table. Remove?`)) return;
    commit(now, {
      tables: now.tables.filter((t) => !ids.includes(t.id)),
      removed: [...now.removed, ...going.filter((t) => initial.some((x) => x.id === t.id)).map((t) => t.id)],
      elements: now.elements.filter((e) => !ids.includes(e.id)),
      removedEls: [...now.removedEls, ...now.elements.filter((e) => ids.includes(e.id) && initialElements.some((x) => x.id === e.id)).map((e) => e.id)],
    });
    setSel([]);
  }

  function applyTemplate(spots: Spot[]) {
    const now = state.current;
    const open = now.tables.filter((t) => busy.has(t.id)).length;
    if (now.tables.length > 0 && !window.confirm(
      `This replaces the ${now.tables.length} ${now.tables.length === 1 ? "table" : "tables"} of ${floor}.${open ? ` ${open} of them have an open order, which stays open without a table.` : ""} Go on?`)) return;
    const used = new Set(namesElsewhere.map((n) => n.trim().toLowerCase()));
    const made: FloorTable[] = spots.map((s) => ({ id: crypto.randomUUID(), name: nextName(used), area: floor, rotation: 0, ...s }));
    commit(now, { tables: made, removed: [...now.removed, ...now.tables.filter((t) => initial.some((x) => x.id === t.id)).map((t) => t.id)] });
    setSel([]);
    setDialog(null);
  }

  // lining up what is picked: by an edge or by the middle
  function align(how: "left" | "centre" | "right" | "top" | "middle" | "bottom") {
    const all: Box[] = [...picked, ...pickedEls];
    if (all.length < 2) return;
    const x0 = Math.min(...all.map((t) => t.x)), x1 = Math.max(...all.map((t) => t.x + t.w));
    const y0 = Math.min(...all.map((t) => t.y)), y1 = Math.max(...all.map((t) => t.y + t.h));
    change((t) => ({
      ...t,
      x: how === "left" ? x0 : how === "right" ? x1 - t.w : how === "centre" ? Math.round((x0 + x1 - t.w) / 2) : t.x,
      y: how === "top" ? y0 : how === "bottom" ? y1 - t.h : how === "middle" ? Math.round((y0 + y1 - t.h) / 2) : t.y,
    }));
  }

  // ---- the pointer ----
  function down(e: React.PointerEvent, p: Box & { id: string }, mode: Drag["mode"]) {
    if (!canEdit || tool === "pan") return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const ids = mode !== "move" ? [p.id] : e.shiftKey ? (sel.includes(p.id) ? sel.filter((x) => x !== p.id) : [...sel, p.id]) : sel.includes(p.id) ? sel : [p.id];
    setSel(ids);
    const all: (Box & { id: string })[] = [...state.current.tables, ...state.current.elements];
    drag.current = { mode, px: e.clientX, py: e.clientY, before: state.current, moved: false, from: new Map(all.filter((x) => ids.includes(x.id)).map((x) => [x.id, { x: x.x, y: x.y, w: x.w, h: x.h }])) };
  }
  function move(e: React.PointerEvent) {
    const d = drag.current;
    const box = plan.current?.getBoundingClientRect();
    if (!d || !box || d.from.size === 0) return;
    const from = [...d.from.values()];
    const isEl = (id: string) => state.current.elements.some((x) => x.id === id);
    let next: Pick<Snap, "tables" | "elements">;
    if (d.mode === "turn") {
      // the angle from the piece's middle to the pointer, the handle being above it
      const f = from[0];
      const cx = box.left + ((f.x + f.w / 2) / PLAN_W) * box.width, cy = box.top + ((f.y + f.h / 2) / PLAN_H) * box.height;
      const raw = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90;
      const to = turned(e.altKey ? raw : Math.round(raw / TURN) * TURN);
      next = {
        tables: state.current.tables.map((t) => (d.from.has(t.id) ? { ...t, rotation: to } : t)),
        elements: state.current.elements.map((x) => (d.from.has(x.id) ? { ...x, rotation: to } : x)),
      };
      if (JSON.stringify(next) === JSON.stringify({ tables: state.current.tables, elements: state.current.elements })) return;
    } else {
      let dx = Math.round(((e.clientX - d.px) / box.width) * PLAN_W);
      let dy = Math.round(((e.clientY - d.py) / box.height) * PLAN_H);
      if (d.mode === "move") {
        // the picked pieces move as one, and stop together at the plan's edge
        dx = clamp(dx, -Math.min(...from.map((t) => t.x)), Math.min(...from.map((t) => PLAN_W - t.x - t.w)));
        dy = clamp(dy, -Math.min(...from.map((t) => t.y)), Math.min(...from.map((t) => PLAN_H - t.y - t.h)));
        // one piece alone lines up with its neighbours when it comes within a unit of them
        if (snap && from.length === 1 && !e.altKey) {
          const t = from[0];
          const id = [...d.from.keys()][0];
          const rest = boxes().filter((x) => (x as Box & { id: string }).id !== id);
          const near = (v: number, marks: number[]) => marks.find((m) => Math.abs(m - v) <= 1);
          const nx = near(t.x + dx, rest.flatMap((o) => [o.x, o.x + o.w - t.w, Math.round(o.x + (o.w - t.w) / 2)]));
          const ny = near(t.y + dy, rest.flatMap((o) => [o.y, o.y + o.h - t.h, Math.round(o.y + (o.h - t.h) / 2)]));
          if (nx !== undefined) dx = clamp(nx, 0, PLAN_W - t.w) - t.x;
          if (ny !== undefined) dy = clamp(ny, 0, PLAN_H - t.h) - t.y;
        }
      }
      if (dx === 0 && dy === 0 && !d.moved) return;
      const to = <T extends Box & { id: string }>(p: T): T => {
        const f = d.from.get(p.id);
        if (!f) return p;
        if (d.mode === "move") return { ...p, x: f.x + dx, y: f.y + dy };
        // a wall is one unit thick; a table is not made smaller than a table
        const least = isEl(p.id) ? 1 : MIN;
        return { ...p, w: clamp(f.w + dx, Math.min(least, f.w), PLAN_W - f.x), h: clamp(f.h + dy, Math.min(least, f.h), PLAN_H - f.y) };
      };
      next = { tables: state.current.tables.map(to), elements: state.current.elements.map(to) };
    }
    d.moved = true;
    state.current = { ...state.current, ...next };
    setTables(next.tables); setElements(next.elements);
  }
  function up() {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    hist.current = { past: [...hist.current.past.slice(-59), d.before], future: [] };
    setDirty(true); setNote(null);
    redraw((n) => n + 1);
  }

  // ---- the keyboard ----
  function key(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).closest("input, select, textarea")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); setSel([...tables.map((t) => t.id), ...elements.map((x) => x.id)]); return; }
    if (e.key === "Escape") { setSel([]); return; }
    if (!canEdit || sel.length === 0) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(sel); return; }
    const step = e.shiftKey ? 5 : 1;
    const by = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
    if (!by) return;
    e.preventDefault();
    change((t) => ({ ...t, x: clamp(t.x + by[0], 0, PLAN_W - t.w), y: clamp(t.y + by[1], 0, PLAN_H - t.h) }));
  }

  async function save() {
    const names = new Set<string>();
    for (const t of tables) {
      const n = t.name.trim().toLowerCase();
      if (!n) { setNote("Every table needs a number."); setSel([t.id]); return; }
      if (names.has(n)) { setNote(`Two tables are called "${t.name.trim()}". Give each its own number.`); setSel([t.id]); return; }
      names.add(n);
    }
    if (tables.length === 0 && elements.length > 0) { setNote("Add a table to this area first: an area with no table is not kept."); return; }
    setSaving(true);
    const result = await saveFloor(storeId, tables, removed, elements, removedEls);
    setSaving(false);
    if ("error" in result) { setNote(result.error); return; }
    setDirty(false); setRemoved([]); setRemovedEls([]); setNote(null);
    // an area that had nothing saved in it is one of the store's now
    if (!saved) router.refresh();
  }

  const go = (to: string) => {
    if (dirty && !window.confirm(`${floor} has changes that are not saved. Leave them?`)) return;
    router.push(to);
  };
  const href = (name: string) => `/backoffice/tables?store=${storeId}&floor=${encodeURIComponent(name)}`;
  const covers = tables.reduce((a, t) => a + t.seats, 0);
  const areas = floors.includes(floor) ? floors : [...floors, floor];
  const place = (p: Box) => ({ left: `${p.x}%`, top: `${(p.y / PLAN_H) * 100}%`, width: `${p.w}%`, height: `${(p.h / PLAN_H) * 100}%` });
  const handlers = (p: Box & { id: string }, mode: Drag["mode"]) => ({ onPointerDown: (e: React.PointerEvent) => down(e, p, mode), onPointerMove: move, onPointerUp: up, onPointerCancel: up });
  // what is picked alone, table or element: its width, depth and angle are changed the same way
  const lone: (Box & { id: string; rotation: number }) | null = one ?? oneEl;
  const least = oneEl ? 1 : 4;

  return (
    <div className="fd" onKeyDown={key}>
      <div className="fd-areas">
        <div className="fd-tabs" role="tablist" aria-label="Areas">
          {areas.map((a) => (
            <button key={a} type="button" role="tab" aria-selected={a === floor} className={a === floor ? "on" : undefined} onClick={() => a !== floor && go(href(a))}>
              {a}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {canEdit && (
          <>
            <button type="button" className="btn-quiet" onClick={() => setDialog("template")}><LayoutTemplate aria-hidden="true" />Start from a template</button>
            <button type="button" className="btn-quiet" onClick={() => setDialog("area")}><Pencil aria-hidden="true" />Rename or remove area</button>
            <button type="button" className="btn-quiet" onClick={() => setDialog("new")}><Plus aria-hidden="true" />Add an area</button>
          </>
        )}
      </div>

      <div className="fd-bar">
        <div className="fd-group" role="group" aria-label="Tool">
          <button type="button" className={tool === "pick" ? "on" : undefined} aria-pressed={tool === "pick"} title="Pick and move tables" onClick={() => setTool("pick")}><MousePointer2 aria-hidden="true" /></button>
          <button type="button" className={tool === "pan" ? "on" : undefined} aria-pressed={tool === "pan"} title="Move the plan about" onClick={() => setTool("pan")}><Hand aria-hidden="true" /></button>
        </div>
        <button type="button" className="fd-key" title="Undo (Ctrl Z)" aria-label="Undo" disabled={!canEdit || hist.current.past.length === 0} onClick={undo}><Undo2 aria-hidden="true" /></button>
        <button type="button" className="fd-key" title="Redo (Ctrl Y)" aria-label="Redo" disabled={!canEdit || hist.current.future.length === 0} onClick={redo}><Redo2 aria-hidden="true" /></button>
        <span className="fd-rule" />
        <button type="button" className="fd-key" aria-label="Smaller" disabled={zoom <= ZOOMS[0]} onClick={() => setZoom((z) => [...ZOOMS].reverse().find((v) => v < z) ?? z)}><ZoomOut aria-hidden="true" /></button>
        <span className="fd-zoom">{Math.round(zoom * 100)}%</span>
        <button type="button" className="fd-key" aria-label="Larger" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom((z) => ZOOMS.find((v) => v > z) ?? z)}><ZoomIn aria-hidden="true" /></button>
        <button type="button" className="fd-key" title="Fit the plan to the page" aria-label="Fit" onClick={() => setZoom(1)}><Maximize aria-hidden="true" /></button>
        <span className="fd-rule" />
        <button type="button" className={"fd-toggle" + (grid ? " on" : "")} aria-pressed={grid} onClick={() => setGrid((g) => !g)}><Grid3x3 aria-hidden="true" />Grid</button>
        <button type="button" className={"fd-toggle" + (snap ? " on" : "")} aria-pressed={snap} title="A piece lines up with its neighbours as it is dragged. Hold Alt to place it freely." onClick={() => setSnap((s) => !s)}><Magnet aria-hidden="true" />Snap</button>
        <span className="spacer" />
        {note && <span className="flag fd-note">{note}</span>}
        {canEdit && (dirty || saving ? (
          <button type="button" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save plan"}</button>
        ) : (
          <span className="fd-saved"><Check aria-hidden="true" />Saved</span>
        ))}
      </div>

      <div className={"fd-body" + (canEdit ? "" : " view")}>
        {canEdit && (
          <aside className="fd-kinds" aria-label="Pieces to add">
            <h3>Tables</h3>
            <div className="fd-kind-list">
              {KINDS.map((k) => (
                <button key={k.id} type="button" draggable title={`${k.label}: tap to add, or drag onto the plan`}
                  onDragStart={(e) => { e.dataTransfer.setData("text/plain", "table:" + k.id); e.dataTransfer.effectAllowed = "copy"; }} onClick={() => add(k)}>
                  {k.id === "square" ? <Square aria-hidden="true" /> : k.id === "round" ? <Circle aria-hidden="true" /> : k.id === "stool" ? <CircleDot aria-hidden="true" />
                    : k.id === "booth" ? <Armchair aria-hidden="true" /> : <RectangleHorizontal aria-hidden="true" className={k.id === "long" ? "long" : undefined} />}
                  <span>{k.label}</span>
                </button>
              ))}
            </div>
            <h3>Room</h3>
            <div className="fd-kind-list">
              {ROOM.map((r) => (
                <button key={r.kind} type="button" draggable title={`${r.label}: tap to add, or drag onto the plan`}
                  onDragStart={(e) => { e.dataTransfer.setData("text/plain", "room:" + r.kind); e.dataTransfer.effectAllowed = "copy"; }} onClick={() => addEl(r)}>
                  {r.kind === "wall" ? <Minus aria-hidden="true" /> : r.kind === "door" ? <DoorOpen aria-hidden="true" /> : r.kind === "window" ? <Grid3x3 aria-hidden="true" /> : <Wine aria-hidden="true" />}
                  <span>{r.label}</span>
                </button>
              ))}
            </div>
            <p>Tap one to put it on the plan, or drag it to its place.</p>
          </aside>
        )}

        <div
          className={"fd-stage" + (tool === "pan" ? " pan" : "")} ref={stage} tabIndex={0} aria-label={`The plan of ${floor}`}
          onPointerDown={(e) => {
            if (tool === "pan" && stage.current) {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              pan.current = { x: e.clientX, y: e.clientY, left: stage.current.scrollLeft, top: stage.current.scrollTop };
            } else setSel([]);
          }}
          onPointerMove={(e) => { const p = pan.current; if (p && stage.current) { stage.current.scrollLeft = p.left - (e.clientX - p.x); stage.current.scrollTop = p.top - (e.clientY - p.y); } }}
          onPointerUp={() => { pan.current = null; }}
          onPointerCancel={() => { pan.current = null; }}
          onDragOver={(e) => { if (canEdit) e.preventDefault(); }}
          onDrop={(e) => {
            const [what, id] = e.dataTransfer.getData("text/plain").split(":");
            const box = plan.current?.getBoundingClientRect();
            const kind = what === "table" ? KINDS.find((k) => k.id === id) : undefined;
            const piece = what === "room" ? ROOM.find((r) => r.kind === id) : undefined;
            const size = kind ?? piece;
            if (!size || !box) return;
            e.preventDefault();
            const at = { x: Math.round(((e.clientX - box.left) / box.width) * PLAN_W - size.w / 2), y: Math.round(((e.clientY - box.top) / box.height) * PLAN_H - size.h / 2) };
            if (kind) add(kind, at); else if (piece) addEl(piece, at);
          }}
        >
          <div className={"fd-plan" + (grid ? " grid" : "")} ref={plan} style={{ width: `${zoom * 100}%` }}>
            {tables.length === 0 && elements.length === 0 && <p className="fd-empty">No tables in {floor} yet.{canEdit ? " Add one from the left, or start from a template." : ""}</p>}
            {/* what stands in the room is under its tables, as on the tablets */}
            {elements.map((p) => {
              const on = sel.includes(p.id);
              return (
                <div key={p.id} className={`fd-el ${p.kind}` + (on ? " on" : "")} style={{ ...place(p), transform: `rotate(${p.rotation}deg)` }} {...handlers(p, "move")}>
                  {p.kind === "bar" && <span>Bar</span>}
                  {canEdit && on && oneEl && <span className="fd-handle" {...handlers(p, "size")} />}
                  {canEdit && on && oneEl && <span className="fd-turn" title="Drag to turn it. Hold Alt for any angle." {...handlers(p, "turn")} />}
                </div>
              );
            })}
            {tables.map((t) => {
              const on = sel.includes(t.id);
              return (
                <div
                  key={t.id}
                  className={`fd-table ${t.shape}` + (t.shape === "round" || t.shape === "stool" ? " round" : "") + (t.h > t.w ? " tall" : "") + (on ? " on" : "") + (busy.has(t.id) ? " busy" : "")}
                  style={{ ...place(t), transform: `rotate(${t.rotation}deg)` }}
                  {...handlers(t, "move")}
                >
                  {chairs(t).map((c, i) => <i key={i} style={{ left: c.left, top: c.top, transform: `translate(-50%, -50%) rotate(${c.turn.toFixed(0)}deg)` }} />)}
                  {/* its number stays upright, as on the tablets */}
                  <strong style={{ transform: `rotate(${-t.rotation}deg)` }}>{t.name || "?"}</strong>
                  {canEdit && on && one && <span className="fd-handle" {...handlers(t, "size")} />}
                  {canEdit && on && one && <span className="fd-turn" title="Drag to turn it. Hold Alt for any angle." {...handlers(t, "turn")} />}
                </div>
              );
            })}
          </div>
        </div>

        <aside className="fd-side">
          <header>
            <b>{floor}</b>
            <small>{tables.length} {tables.length === 1 ? "table" : "tables"}, {covers} {covers === 1 ? "seat" : "seats"}{elements.length > 0 ? `, ${elements.length} in the room` : ""}</small>
          </header>
          {lone ? (
            <>
              {one ? (
                <>
                  {busy.has(one.id) && <p className="flag">Has an open order.</p>}
                  <label>Table number
                    <input value={one.name} maxLength={30} disabled={!canEdit} onChange={(e) => changeTable(one.id, (t) => ({ ...t, name: e.target.value }))} />
                  </label>
                  <label>Seats
                    <input type="number" min={1} max={99} value={one.seats} disabled={!canEdit} onChange={(e) => changeTable(one.id, (t) => ({ ...t, seats: clamp(Number(e.target.value) || 1, 1, 99) }))} />
                  </label>
                  <label>Shape
                    <select value={one.shape} disabled={!canEdit} onChange={(e) => changeTable(one.id, (t) => ({ ...t, shape: (["square", "round", "booth", "stool"] as const).find((s) => s === e.target.value) ?? "square" }))}>
                      <option value="square">Square or rectangle</option>
                      <option value="round">Round or oval</option>
                      <option value="booth">Booth</option>
                      <option value="stool">Bar stool</option>
                    </select>
                  </label>
                </>
              ) : (
                <p className="fd-many"><b>{roomLabel(oneEl?.kind ?? "")}</b><br />It is drawn on the plan and on the tablets. Nothing is ordered at it.</p>
              )}
              <div className="fd-size">
                <label>Width
                  <input type="number" min={least} max={PLAN_W} value={lone.w} disabled={!canEdit} onChange={(e) => change((t) => ({ ...t, w: clamp(Number(e.target.value) || least, least, PLAN_W - t.x) }), [lone.id])} />
                </label>
                <label>Depth
                  <input type="number" min={least} max={PLAN_H} value={lone.h} disabled={!canEdit} onChange={(e) => change((t) => ({ ...t, h: clamp(Number(e.target.value) || least, least, PLAN_H - t.y) }), [lone.id])} />
                </label>
              </div>
              <label>Angle
                <span className="fd-angle">
                  <button type="button" className="fd-key" aria-label="Turn left" disabled={!canEdit} onClick={() => change((t) => ({ ...t, rotation: turned(t.rotation - TURN) }), [lone.id])}><RotateCcw aria-hidden="true" /></button>
                  <input type="number" min={0} max={359} value={lone.rotation} disabled={!canEdit} onChange={(e) => change((t) => ({ ...t, rotation: turned(Number(e.target.value) || 0) }), [lone.id])} />
                  <button type="button" className="fd-key" aria-label="Turn right" disabled={!canEdit} onClick={() => change((t) => ({ ...t, rotation: turned(t.rotation + TURN) }), [lone.id])}><RotateCw aria-hidden="true" /></button>
                </span>
              </label>
              {canEdit && <button type="button" className="btn-quiet fd-remove" onClick={() => remove([lone.id])}><Trash2 aria-hidden="true" />{one ? "Remove table" : "Remove it"}</button>}
            </>
          ) : count > 1 ? (
            <>
              <p className="fd-many">{count} picked. Drag one to move them all.</p>
              {canEdit && (
                <>
                  <div className="fd-align" role="group" aria-label="Line them up">
                    <button type="button" title="Line up the left edges" onClick={() => align("left")}><AlignStartVertical aria-hidden="true" /></button>
                    <button type="button" title="Line up the middles, across" onClick={() => align("centre")}><AlignCenterVertical aria-hidden="true" /></button>
                    <button type="button" title="Line up the right edges" onClick={() => align("right")}><AlignEndVertical aria-hidden="true" /></button>
                    <button type="button" title="Line up the top edges" onClick={() => align("top")}><AlignStartHorizontal aria-hidden="true" /></button>
                    <button type="button" title="Line up the middles, down" onClick={() => align("middle")}><AlignCenterHorizontal aria-hidden="true" /></button>
                    <button type="button" title="Line up the bottom edges" onClick={() => align("bottom")}><AlignEndHorizontal aria-hidden="true" /></button>
                  </div>
                  <button type="button" className="btn-quiet fd-remove" onClick={() => remove(sel)}><Trash2 aria-hidden="true" />Remove the {count}</button>
                </>
              )}
            </>
          ) : (
            <ul className="fd-tips">
              {canEdit ? (
                <>
                  <li>Drag a table to place it, and its corner to make it bigger or smaller.</li>
                  <li>Pick a table to change its number, seats or shape. The round handle above it turns it.</li>
                  <li>Walls, doors, windows and a bar are on the left, under Room: they are placed, sized and turned the same way.</li>
                  <li>Hold Shift and pick several to move them together or line them up.</li>
                  <li>The arrow keys move what is picked by one square; Delete removes it; Ctrl Z undoes.</li>
                  <li>The tablets show the plan after Save, at their next sync.</li>
                </>
              ) : (
                <li>Only an owner or a manager can change the plan.</li>
              )}
            </ul>
          )}
        </aside>
      </div>

      {dialog === "template" && (
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <div className="modal wide" role="dialog" aria-label="Start from a template" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>Start from a template</h2><button type="button" className="modal-x" aria-label="Close" onClick={() => setDialog(null)}>×</button></div>
            <div className="modal-body">
              <p className="muted">A template replaces the tables of {floor}; its walls and what else stands in it stay. Move, size and renumber the tables after; nothing is saved until Save plan.</p>
              <div className="fd-templates">
                {TEMPLATES.map((tp) => (
                  <button key={tp.id} type="button" onClick={() => applyTemplate(tp.spots)}>
                    <span className="fd-mini" aria-hidden="true">
                      {tp.spots.map((s, i) => <i key={i} className={s.shape === "round" ? "round" : undefined} style={place(s)} />)}
                    </span>
                    <b>{tp.label}</b>
                    <small>{tp.say}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {dialog === "new" && <AreaName title="Add an area" label="Area name" hint="For example Main, Terrace, Rooftop. It is kept once a table is saved in it." go="Add the area" taken={areas} onClose={() => setDialog(null)}
        onDone={(name) => { setDialog(null); go(href(name)); }} />}
      {dialog === "area" && (
        <AreaName title={`Rename or remove ${floor}`} label="Area name" was={floor} hint={dirty ? "Save the plan first: it has changes that are not saved." : "Every table of the area goes with its name, and what stands in it."} go="Rename"
          taken={areas.filter((a) => a !== floor)} locked={dirty} onClose={() => setDialog(null)}
          onDone={async (name) => {
            if (!saved) { setDialog(null); router.push(href(name)); return; }
            const r = await renameFloor(storeId, floor, name);
            if ("error" in r) return r.error;
            setDialog(null); router.push(href(name)); return;
          }}
          onRemove={async () => {
            const open = initial.filter((t) => busy.has(t.id)).length;
            if (!window.confirm(`Remove ${floor} and its ${initial.length} ${initial.length === 1 ? "table" : "tables"}?${open ? ` ${open} of them have an open order, which stays open under Orders, without a table.` : ""}`)) return;
            if (saved) { const r = await deleteFloor(storeId, floor); if ("error" in r) { setNote(r.error); return; } }
            setDirty(false); setDialog(null); router.push(`/backoffice/tables?store=${storeId}`);
          }}
        />
      )}
    </div>
  );
}

// A name for an area: a new one, or another for the one that is open.
function AreaName({
  title, label, hint, go, was = "", taken, locked = false, onClose, onDone, onRemove,
}: {
  title: string; label: string; hint: string; go: string; was?: string; taken: string[]; locked?: boolean;
  onClose: () => void; onDone: (name: string) => void | Promise<string | void>; onRemove?: () => void;
}) {
  const [name, setName] = useState(was);
  const [said, setSaid] = useState<string | null>(null);
  const clean = name.trim().slice(0, 30);
  const clash = taken.some((t) => t.toLowerCase() === clean.toLowerCase());
  const ready = !locked && clean !== "" && clean !== was && !clash;
  const done = async () => { if (!ready) return; const r = await onDone(clean); if (r) setSaid(r); };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{title}</h2><button type="button" className="modal-x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="modal-body">
          <label>{label}
            <input autoFocus value={name} maxLength={30} disabled={locked} onChange={(e) => { setName(e.target.value); setSaid(null); }} onKeyDown={(e) => e.key === "Enter" && done()} />
          </label>
          <p className={said || clash ? "flag" : "muted"}>{said ?? (clash ? "There is already an area of that name." : hint)}</p>
        </div>
        <div className="modal-foot">
          {onRemove && <button type="button" className="btn-quiet fd-remove" disabled={locked} onClick={onRemove}>Remove this area</button>}
          <span className="spacer" />
          <button type="button" className="btn-quiet" onClick={onClose}>Cancel</button>
          <button type="button" onClick={done} disabled={!ready}>{go}</button>
        </div>
      </div>
    </div>
  );
}
