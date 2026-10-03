# Android — RestoPOS till (Phase 1)

Kotlin + Compose + Hilt + Room + WorkManager + Ktor. Min SDK 26.
Written spec-faithful; **not yet compiled here (no Android SDK in this
environment)** — first `assembleDebug` on a dev machine is the gate.

## Setup

1. Install Android Studio (SDK 35) + JDK 17.
2. Create `android/local.properties` (never committed):
   ```
   sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
   functionUrl=https://br-...-api.compute.c-4.ap-southeast-1.aws.neon.tech/
   authUrl=https://ep-....neonauth.c-4.ap-southeast-1.aws.neon.tech/
   ```
   URLs come from root `.env.local` (`NEON_FUNCTION_API_BASE_URL`,
   `NEON_AUTH_BASE_URL`). The two `*Url` lines become BuildConfig fields.
3. `cd android && ./gradlew :app:assembleDebug` (wrapper jar not vendored;
   use the Studio-managed Gradle or `gradle wrapper` once).

## Verify on device (Phase 1 exit)

1. Web: edit an item price → save.
2. Tablet: sign in (owner email), pick store, register device, seed demo menu
   if empty. Pull runs on start; grid updates within seconds.
3. Airplane mode on, force-stop, reopen: menu still renders (Room).

## Phase 2 (sales vertical, in this tree, uncompiled)

- Room v2 (`MIGRATION_1_2`): tickets, lines, receipt snapshots, outbox.
- `TicketRepository`: every mutation writes data + outbox in one txn, then an
  immediate push when online. Receipt numbers `{store}-{device}-{seq}` resume
  from the mirrored device row. Qty edits void + re-add with a reason.
- `PushWorker`: batches of 50, applied/duplicate delete, rejected dead-letters,
  401 refreshes JWT once, network retries with backoff.
- UI: ticket panel, modifiers sheet, split payment (cash quick/change,
  wallet/QR reference, partial chunks keep the ticket open), receipts list,
  result screen.

## Assumptions to confirm on device

- Managed Auth REST paths in `core/network/AuthClient.kt`
  (`/sign-in/email`, `/sign-up/email`, `/token`, `/get-session`).
- First-sync progress UI is still a spinner (WorkManager progress comes later).
- `requires_approval` discounts are selectable without a manager PIN
  (Phase 4 gates them); live stock guard is availability-only (Phase 9).
