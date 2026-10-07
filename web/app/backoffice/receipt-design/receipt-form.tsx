"use client";

import { useState } from "react";
import { Submit } from "../busy";

type Company = { name: string; brn: string; vat: string; address: string; phone: string };

// The form and, next to it, the receipt as it will print: the preview follows
// every keystroke and can be flipped between the two paper widths.
export function ReceiptForm({
  action,
  initial,
  company,
  canEdit,
}: {
  action: (f: FormData) => Promise<void>;
  initial: { header: string; footer: string; logo: string | null; showLogo: boolean };
  company: Company;
  canEdit: boolean;
}) {
  const [header, setHeader] = useState(initial.header);
  const [footer, setFooter] = useState(initial.footer);
  const [logo, setLogo] = useState<string | null>(initial.logo);
  const [showLogo, setShowLogo] = useState(initial.showLogo);
  const [paper, setPaper] = useState<58 | 80>(80);
  const [problem, setProblem] = useState("");

  // A logo is drawn onto a small canvas first: a thermal printer is 384 or 576
  // dots wide, so a phone photo would only slow every sync down.
  function pick(file: File | undefined) {
    setProblem("");
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return setProblem("The logo must be a PNG or a JPEG image.");
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 384 / img.width, 200 / img.height);
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      const g = cv.getContext("2d");
      if (!g) return setProblem("This browser could not read the image.");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, cv.width, cv.height);
      g.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      setLogo(cv.toDataURL("image/png"));
      setShowLogo(true);
    };
    img.onerror = () => setProblem("That file could not be read as an image.");
    img.src = url;
  }

  const lines = (t: string) => t.split("\n").map((l, i) => <div key={i}>{l || " "}</div>);
  return (
    <div className="grid-2">
      <form action={action}>
        <section className="card flush">
          <div className="card-head">
            <div>
              <h2>What prints</h2>
              <p>The business name, address, BRN and VAT number come from Company details.</p>
            </div>
          </div>
          <div className="card-body">
            <input type="hidden" name="logo" value={logo ?? ""} />
            <div className="field" style={{ maxWidth: "none" }}>
              Logo
              <div className="bo-toolbar" style={{ margin: "6px 0 0" }}>
                <input type="file" accept="image/png,image/jpeg" onChange={(e) => pick(e.target.files?.[0])} disabled={!canEdit} />
                {logo && (
                  <button type="button" className="btn-quiet btn-sm" onClick={() => setLogo(null)} disabled={!canEdit}>
                    Remove logo
                  </button>
                )}
              </div>
              <span className="help">PNG or JPEG. It prints in black and white at the top, so a simple dark logo on white works best.</span>
              {problem && <span className="help flag">{problem}</span>}
            </div>
            <label className="check">
              <input type="checkbox" name="showLogo" checked={showLogo} onChange={(e) => setShowLogo(e.target.checked)} disabled={!canEdit} />
              <span>Print the logo</span>
            </label>
            <label className="field" style={{ maxWidth: "none" }}>
              Header note
              <textarea name="header" value={header} onChange={(e) => setHeader(e.target.value)} maxLength={300} rows={3} placeholder="Open every day, 10:00 to 22:00" disabled={!canEdit} />
              <span className="help">Printed under the business details.</span>
            </label>
            <label className="field" style={{ maxWidth: "none" }}>
              Footer note
              <textarea name="footer" value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={300} rows={3} placeholder="Thank you. See you again soon." disabled={!canEdit} />
              <span className="help">Printed at the very end.</span>
            </label>
          </div>
          <div className="card-foot">
            <Submit disabled={!canEdit}>Save receipt design</Submit>
          </div>
        </section>
      </form>
      <div>
        <div className="bo-toolbar">
          <strong>Preview</strong>
          <span className="spacer" />
          <div className="seg">
            <label>
              <input type="radio" name="paper" checked={paper === 80} onChange={() => setPaper(80)} />
              80 mm
            </label>
            <label>
              <input type="radio" name="paper" checked={paper === 58} onChange={() => setPaper(58)} />
              58 mm
            </label>
          </div>
        </div>
        <div className="paper-wrap">
          <div className={"paper " + (paper === 58 ? "w58" : "w80")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {showLogo && logo && <img src={logo} alt="" />}
            <div className="c big">{company.name || "Your restaurant"}</div>
            {company.address && <div className="c">{lines(company.address)}</div>}
            {company.phone && <div className="c">Tel: {company.phone}</div>}
            {company.brn && <div className="c">BRN: {company.brn}</div>}
            {company.vat && <div className="c">VAT: {company.vat}</div>}
            {header.trim() && <div className="c">{lines(header)}</div>}
            <hr />
            <div className="row"><span>Receipt</span><span>S1-T1-000128</span></div>
            <div className="row"><span>04/10/2026 19:42</span><span>Table 4</span></div>
            <div className="row"><span>Served by</span><span>Priya</span></div>
            <hr />
            <div className="row"><span>2 Dholl puri</span><span>100.00</span></div>
            <div className="row"><span>{"  + Achard"}</span><span>20.00</span></div>
            <div className="row"><span>1 Briyani poulet</span><span>350.00</span></div>
            <div className="row"><span>2 Alouda</span><span>180.00</span></div>
            <hr />
            <div className="row"><span>Subtotal</span><span>650.00</span></div>
            <div className="row"><span>VAT 15% (incl.)</span><span>84.78</span></div>
            <div className="row b big"><span>TOTAL</span><span>Rs 650.00</span></div>
            <div className="row"><span>Cash</span><span>1,000.00</span></div>
            <div className="row"><span>Change</span><span>350.00</span></div>
            <hr />
            {footer.trim() && <div className="c">{lines(footer)}</div>}
          </div>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>The paper width of each printer is set under Printers. This preview is a guide: fonts differ a little between printers.</p>
      </div>
    </div>
  );
}
