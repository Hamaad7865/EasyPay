"use client";

import { Printer } from "lucide-react";

// Prints the report as it is on screen (the sidebar and the filters are left
// out by the print styles). "Save as PDF" in the print dialog makes the PDF.
export function PrintButton() {
  return (
    <button type="button" className="btn-quiet" onClick={() => window.print()}>
      <Printer aria-hidden="true" />
      Print or save as PDF
    </button>
  );
}
