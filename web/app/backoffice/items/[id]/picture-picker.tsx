"use client";

import { useRef, useState, useTransition } from "react";

// A picture chosen on this computer, made small here before it is sent: a
// JPEG of 640 pixels on its long side at most, the size a till's card is drawn
// from (migration 0143). A phone's photograph of several megabytes goes up as
// some forty kilobytes, turned the way it was taken.
//
// It sends itself through the page's action, with `fields` saying what the
// picture is for (the product, a colour, a line), so it can sit inside another
// form (the lines table) without sending that one.

const MOST = 640;

export function PicturePicker({ action, fields, src, label, size = 64 }: {
  action: (f: FormData) => Promise<void>;
  fields: Record<string, string>;
  src: string | null;
  label: string;
  size?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, start] = useTransition();
  const [said, setSaid] = useState<string | null>(null);

  const send = (fill: (f: FormData) => void) =>
    start(async () => {
      const f = new FormData();
      for (const [k, v] of Object.entries(fields)) f.set(k, v);
      fill(f);
      await action(f);
    });

  const chosen = async (file: File) => {
    setSaid(null);
    try {
      const picture = await createImageBitmap(file, { imageOrientation: "from-image" });
      const scale = Math.min(1, MOST / Math.max(picture.width, picture.height));
      const w = Math.max(1, Math.round(picture.width * scale));
      const h = Math.max(1, Math.round(picture.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext("2d");
      if (!g) throw new Error("no canvas");
      // a picture with see-through parts (a PNG) on white, as a JPEG has none
      g.fillStyle = "#fff";
      g.fillRect(0, 0, w, h);
      g.drawImage(picture, 0, 0, w, h);
      const jpeg = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.82));
      if (!jpeg) throw new Error("not made");
      send((f) => {
        f.set("jpeg", jpeg, "picture.jpg");
        f.set("width", String(w));
        f.set("height", String(h));
      });
    } catch {
      setSaid("That file is not a picture this browser can read.");
    }
  };

  return (
    <div className="picture-picker" style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button
        type="button"
        className="picture-thumb"
        onClick={() => input.current?.click()}
        disabled={busy}
        aria-label={src ? `Change the picture of ${label}` : `Add a picture to ${label}`}
        style={{ width: size, height: size }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- the business's own picture, served by the back office */}
        {src ? <img src={src} alt="" /> : <span aria-hidden>+</span>}
      </button>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        {label && <span className="strong" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>}
        <span style={{ display: "flex", gap: 10 }}>
          <button type="button" className="btn-link" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? "Saving…" : src ? "Change" : "Add a picture"}
          </button>
          {src && !busy && (
            <button type="button" className="btn-link danger" onClick={() => send((f) => f.set("remove", "1"))}>
              Remove
            </button>
          )}
        </span>
        {said && <span className="help" style={{ color: "var(--red)" }}>{said}</span>}
      </span>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) chosen(file);
        }}
      />
    </div>
  );
}
