"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

// The box for a password the admin makes up and then gives to its owner: the
// eye shows what was typed, so it can be read back. The eye is a plain
// button, so it never sends the form. `inline` is for a line of fields; in a
// labelled field the box takes the field's width.
export function Password({ label, placeholder, inline }: { label: string; placeholder?: string; inline?: boolean }) {
  const [shown, setShown] = useState(false);
  const eye = shown ? "Hide password" : "Show password";
  return (
    <span className={inline ? "pw-field inline" : "pw-field"}>
      <input
        name="password"
        type={shown ? "text" : "password"}
        placeholder={placeholder}
        aria-label={label}
        required
        minLength={8}
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <button type="button" className="pw-eye" onClick={() => setShown(!shown)} aria-label={eye} aria-pressed={shown} title={eye}>
        {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </span>
  );
}
