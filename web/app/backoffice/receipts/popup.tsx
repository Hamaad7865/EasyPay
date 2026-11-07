"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Mail, MessageCircle, Printer, X } from "lucide-react";

// A receipt in a pop-up over the Receipts list (2026-11-07, after
// Carfectionist's tickets): the paper as the till prints it, with what can be
// done with it. The address says which receipt is open (?r=), so Back and a
// link both work; closing takes it away. It is the browser's own dialog: the
// list behind cannot be reached while it is open, and Esc closes it.
// Nothing is sent from here: WhatsApp and the mail app are handed the receipt
// as text, as the tablet hands it to its own apps (Pay.kt share).
export function ReceiptPopup({
  title, subtitle, close, text, whatsapp, email, subject, children, foot,
}: {
  title: string; subtitle: string; close: string; text: string;
  // the customer's number as WhatsApp takes it, and their address, when the sale has a customer
  whatsapp: string | null; email: string | null; subject: string;
  children: React.ReactNode; foot?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const leave = () => router.replace(close, { scroll: false });

  // the clipboard as browsers have it now; where one refuses it, the old way
  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = copyByHand(ref.current, text);
    }
    setCopied(ok ? "yes" : "no");
    setTimeout(() => setCopied(null), 2000);
  };

  // three back-quotes make WhatsApp keep the paper's columns
  const wa = `https://wa.me/${whatsapp ?? ""}?text=${encodeURIComponent("```\n" + text + "\n```")}`;
  const mail = `mailto:${email ?? ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;

  return (
    <dialog
      ref={ref}
      className="rc-pop"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        leave();
      }}
      onClick={(e) => e.target === ref.current && leave()}
    >
      <header className="modal-head">
        <div>
          <h2>{title}</h2>
          <p className="muted">{subtitle}</p>
        </div>
        <button type="button" className="modal-x" onClick={leave} aria-label="Close">
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="rc-body">{children}</div>
      <footer className="rc-foot">
        <div className="rc-foot-links">{foot}</div>
        <button type="button" className="btn-quiet" onClick={copy}>
          {copied === "yes" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied === "yes" ? "Copied" : copied === "no" ? "This browser refused" : "Copy"}
        </button>
        <a className="btn-quiet" href={wa} target="_blank" rel="noreferrer">
          <MessageCircle aria-hidden="true" />
          WhatsApp
        </a>
        <a className="btn-quiet" href={mail}>
          <Mail aria-hidden="true" />
          Email
        </a>
        <button type="button" onClick={() => printPaper(ref.current, subject)}>
          <Printer aria-hidden="true" />
          Print
        </button>
      </footer>
    </dialog>
  );
}

// The text put in a field of the dialog (the page behind cannot take focus while it is open), selected and copied.
function copyByHand(dialog: HTMLDialogElement | null, text: string): boolean {
  const t = document.createElement("textarea");
  t.value = text;
  t.setAttribute("readonly", "");
  t.style.cssText = "position:fixed;left:-9999px;top:0";
  (dialog ?? document.body).appendChild(t);
  t.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  t.remove();
  return ok;
}

// The paper alone, on the printer's paper: a page of its own in a frame that
// is never seen, so nothing of the back office goes with it. The print dialog
// also saves it as a PDF, named after the receipt.
const PRINT_CSS = `
@page { margin: 4mm; }
html, body { margin: 0; background: #fff; }
.pp { width: 72mm; color: #000; font-family: "Courier New", ui-monospace, monospace; font-size: 2.45mm; line-height: 1.35; }
.pp-line { white-space: pre-wrap; word-break: break-all; min-height: 1.35em; }
.pp-line.b { font-weight: 700; }
.pp-line.big { font-size: 4.9mm; }
.pp-line.tall { height: 2.7em; transform: scaleY(2); transform-origin: top; }
.pp-bars { height: 9mm; width: 72%; margin: 1mm auto; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  background: repeating-linear-gradient(90deg, #000 0 2px, #fff 2px 3px, #000 3px 4px, #fff 4px 7px, #000 7px 10px, #fff 10px 12px); }
.pp-logo { display: block; max-width: 70%; max-height: 24mm; margin: 0 auto 2mm; filter: grayscale(1) contrast(1.4); }
.pp-logo.left { margin-left: 0; }
.pp-logo.right { margin-right: 0; }
`;

function printPaper(dialog: HTMLDialogElement | null, title: string) {
  const paper = dialog?.querySelector(".pp");
  if (!paper) return;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  // inside the dialog, so it is in the same layer and the page behind stays as it is
  dialog!.appendChild(frame);
  const w = frame.contentWindow;
  if (!w) return frame.remove();
  const safe = title.replace(/[<>&"]/g, "");
  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${safe}</title><style>${PRINT_CSS}</style></head><body>${paper.outerHTML}</body></html>`);
  w.document.close();
  let gone = false;
  const done = () => {
    if (gone) return;
    gone = true;
    frame.remove();
  };
  w.addEventListener("afterprint", () => setTimeout(done, 0));
  setTimeout(done, 120_000);
  // the logo is drawn before the paper goes
  const pictures = Array.from(w.document.images).map((i) => (i.complete ? Promise.resolve() : new Promise<void>((r) => { i.onload = i.onerror = () => r(); })));
  Promise.all(pictures).then(() => {
    w.focus();
    w.print();
  });
}
