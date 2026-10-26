"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { pickBranch } from "./branch-actions";

// The branch a report or a stock page is for (web/lib/branch.ts), at the top of the page. Drawn only when the
// account has two or more branches. On paper it stays, as the words "Branch: Port Louis", so a printed report says
// which branch it was.
export function BranchPicker({ all, picked }: { all: { id: string; name: string }[]; picked: string | null }) {
  const path = usePathname();
  const router = useRouter();
  const [going, start] = useTransition();
  if (all.length < 2) return null;
  const name = all.find((b) => b.id === picked)?.name ?? "All branches";
  return (
    <label className="branch-pick" data-branch-picker data-branch={name}>
      Branch
      <select
        key={picked ?? "all"}
        defaultValue={picked ?? ""}
        disabled={going}
        onChange={(e) => {
          const v = e.target.value;
          start(async () => {
            await pickBranch(v, path);
            router.refresh();
          });
        }}
      >
        <option value="">All branches</option>
        {all.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
    </label>
  );
}
