import { pbkdf2Sync, randomBytes } from "node:crypto";

// A staff PIN is checked on the till, offline, against this hash (spec 7.2),
// so the till must be able to compute it: PBKDF2-HMAC-SHA256, which Node and
// Android both have built in. Stored as
//   pbkdf2-sha256$<iterations>$<salt, base64>$<hash, base64>
// The till's copy of this is core/common/PinHash.kt; they must agree.
//
// A 4-digit PIN has 10,000 values, so the hash does not keep it secret from
// someone who has the tablet's database. It keeps PINs out of plain sight and
// stops one member of staff reading another's.
const ITERATIONS = 20000;

export const isPin = (pin: string) => /^\d{4}$/.test(pin);

export function hashPin(pin: string, salt: Buffer = randomBytes(16)): string {
  const hash = pbkdf2Sync(pin, salt, ITERATIONS, 32, "sha256");
  return `pbkdf2-sha256$${ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
