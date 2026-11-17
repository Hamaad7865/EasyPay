"use client";

import { useRef, useState } from "react";
import { FileUp } from "lucide-react";

// After EasyUI's File Upload (easyui.site, MIT, Suraj Maurya), in this app's
// own CSS (eu.css): a box a file is dropped on, or clicked to choose one. It
// lifts while a file is held over it. The kinds it takes are shown beside.

export function FileDrop({ accept, kinds, title, hint, disabled, onFile, label }: {
  accept: string;
  kinds?: string[];
  title: string;
  hint?: string;
  disabled?: boolean;
  onFile: (f: File | undefined) => void;
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // a drag over the box's own words fires leave and enter again: it counts them
  const depth = useRef(0);

  return (
    <label
      className={"eu-drop" + (over ? " over" : "") + (disabled ? " off" : "")}
      onDragEnter={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (!disabled) onFile(e.dataTransfer.files?.[0]);
      }}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <span className="eu-drop-mark" aria-hidden>
        <FileUp />
      </span>
      <span>
        <b>{over ? "Let go to read it" : title}</b>
        {hint && <small>{hint}</small>}
      </span>
      {kinds && (
        <span className="eu-drop-kinds" aria-hidden>
          {kinds.map((k) => (
            <span key={k}>{k}</span>
          ))}
        </span>
      )}
    </label>
  );
}
