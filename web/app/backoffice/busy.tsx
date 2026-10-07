"use client";

import { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";

// What is pressed says it is at work until the answer is back. From here a
// save is a trip to the server and back, a second or so: without a sign, a
// button looks as if it had not been pressed, and gets pressed again.

// Is the form this button belongs to on its way? A form with a server action
// says so itself; a form that only changes the address (Go, below) says so here.
const Going = createContext(false);

// A form's button. While the form is away the one that was pressed turns its
// words into a small ring, at the same width, and none of the form's buttons
// takes a click. `busy` is for a button outside its form (the foot of a
// panel), which cannot see the form and is told.
export function Submit({ busy, disabled, children, ...rest }: React.ComponentProps<"button"> & { busy?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { pending } = useFormStatus();
  const going = useContext(Going);
  // Save and Remove sit in one form: the ring goes on the one that sent it
  const [mine, setMine] = useState(false);
  useEffect(() => {
    const sent = (e: SubmitEvent) => setMine(e.submitter === ref.current);
    document.addEventListener("submit", sent, true);
    return () => document.removeEventListener("submit", sent, true);
  }, []);
  const away = busy ?? (pending || going);
  return (
    <button type="submit" {...rest} ref={ref} disabled={disabled || away} aria-busy={(away && mine) || undefined}>
      {children}
    </button>
  );
}

// A form that asks for the same page another way (other dates, another
// filter): it goes there without loading the whole back office again, and its
// button turns until the page has what was asked for.
export function Go({ action, children, ...rest }: Omit<React.ComponentProps<"form">, "action" | "method" | "onSubmit"> & { action: string }) {
  const router = useRouter();
  const [going, start] = useTransition();
  return (
    <form
      {...rest}
      action={action}
      onSubmit={(e) => {
        e.preventDefault();
        const asked = new URLSearchParams();
        for (const [k, v] of new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter)) if (typeof v === "string") asked.append(k, v);
        const s = asked.toString();
        start(() => router.push(action + (s ? "?" + s : "")));
      }}
    >
      <Going value={going}>{children}</Going>
    </form>
  );
}

// Inside a link: nothing, until the link has been clicked and its page is not
// there yet. In the menu it is a small ring at the end of the line; anywhere
// else the stylesheet makes the link itself breathe (a:has(.wait[data-on])).
export function Wait() {
  const { pending } = useLinkStatus();
  return <span className="wait" data-on={pending || undefined} aria-hidden="true" />;
}
