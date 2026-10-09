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

// The same box for the PIN a login opens the till with: four digits, and the
// eye to read them back before they are handed over. `optional` is for the
// form that makes a client, where the PIN can wait.
export function Pin({ label, placeholder, inline, optional }: { label: string; placeholder?: string; inline?: boolean; optional?: boolean }) {
  const [shown, setShown] = useState(false);
  const eye = shown ? "Hide PIN" : "Show PIN";
  return (
    <span className={inline ? "pw-field inline pin" : "pw-field"}>
      <input
        name="pin"
        type={shown ? "text" : "password"}
        inputMode="numeric"
        pattern="\d{4}"
        maxLength={4}
        placeholder={placeholder}
        aria-label={label}
        required={!optional}
        autoComplete="off"
      />
      <button type="button" className="pw-eye" onClick={() => setShown(!shown)} aria-label={eye} aria-pressed={shown} title={eye}>
        {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </span>
  );
}
