"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

// A password box with an eye to show what was typed. The eye is a plain
// button, so it never sends the form.
export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  autoFocus,
  minLength,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
  minLength?: number;
}) {
  const [shown, setShown] = useState(false);
  const label = shown ? "Hide password" : "Show password";
  return (
    <span className="pw-field">
      <input
        id={id}
        type={shown ? "text" : "password"}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        minLength={minLength}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
      />
      <button type="button" className="pw-eye" onClick={() => setShown(!shown)} aria-label={label} aria-pressed={shown} title={label}>
        {shown ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
      </button>
    </span>
  );
}
