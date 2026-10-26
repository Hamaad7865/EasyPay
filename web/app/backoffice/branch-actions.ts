"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { UUID } from "@/lib/action";
import { BRANCH_COOKIE } from "@/lib/branch";

// What the branch picker sends: a branch's id, or "" for All branches. Whether it is one of the account's
// branches is asked where it is read (lib/branch.ts, pickedOf), so a pick is never trusted here.
export async function pickBranch(id: string, path: string) {
  const v = UUID.test(id) ? id : "";
  (await cookies()).set(BRANCH_COOKIE, v, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/backoffice",
    // kept a year; All branches is no cookie at all
    maxAge: v ? 60 * 60 * 24 * 365 : 0,
  });
  if (path.startsWith("/backoffice")) revalidatePath(path);
}
