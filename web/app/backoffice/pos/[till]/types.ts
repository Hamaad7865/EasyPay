import type { PosSettings } from "@/lib/settings";
import type { Asked, Till } from "@/lib/pos";

// What every tab of a till's page is handed: the till, the business's
// timezone and settings, whether this role sees money, today, the newest
// build among the tills, the dates the address asked for, what this person
// may ask of a till, and what was asked of this one and still waits.
export type Base = {
  tz: string; ok: boolean; s: PosSettings; t: Till; day: string; newest: number; ref: string; from: string; to: string;
  may: { close: boolean; cash: boolean }; waiting: Asked[];
};
