# Android — RestoPOS till

Kotlin + Compose + Hilt + Room + WorkManager + Ktor (OkHttp). Min SDK 26,
compile SDK 36.

Built: owner sign-in, store and device setup, the menu mirrored into Room by
the pull worker, the sale grid, ticket building with modifiers and a discount,
payment of the whole bill (cash with change, or card/wallet with a reference),
the receipts list, and the outbox with its push worker.

Not built yet: splitting a bill by item (the server supports it, the screen
has no line selection), service charge and rounding settings, refunds, staff
PIN, printing, the kitchen display.

It compiles and its unit tests pass. It has not been run on a tablet yet; the
three checks below are the first thing to do on one.

## Build

1. Android Studio (SDK 36) and JDK 17.
2. Create `android/local.properties` (gitignored):
   ```
   sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
   functionUrl=https://br-...-api.compute.c-4.ap-southeast-1.aws.neon.tech
   authUrl=https://ep-....neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth
   ```
   The URLs are `NEON_FUNCTION_API_BASE_URL` and `NEON_AUTH_BASE_URL` from the
   root `.env.local`. They become `BuildConfig` fields; a trailing slash is
   fine. Use the dev branch values unless you mean to point a build at
   production.
3. `cd android && ./gradlew :app:assembleDebug`
   The APK lands in `app/build/outputs/apk/debug/`.
4. `./gradlew :app:testDebugUnitTest` checks that the till's totals match the
   figures the server stores for the same sales.

## Check on a device (Phase 1 exit)

1. Web: edit an item price, save.
2. Tablet: sign in with the owner email, pick the store, give the device a
   code that no other till in the store uses, seed the demo menu if empty. The
   pull runs on start; the grid updates within seconds.
3. Airplane mode on, force-stop, reopen: the app opens straight on the menu
   (a set-up tablet does not ask for sign-in again) and the menu still shows.

## How sync and sign-in behave

- **Pull:** pages until `has_more` is false, each page and its cursor in one
  Room transaction. Network errors retry with backoff; a rewritten table on
  the server (the `epochs` map changes) clears the mirror and pulls from 0.
- **Session:** the auth cookies are stored on the device, and the API token is
  refreshed from them shortly before it expires or when a call returns 401.
  If the session itself is gone, the worker stops and the next sign-in resumes.
- **Push:** outbox rows go up in order, 50 at a time. `applied` removes the
  row, `rejected` moves it to the dead-letter state with the server's code,
  `retry` leaves it queued. A line carries the price and modifier prices this
  till charged, and a discount carries the amount it took off, so the server
  stores the receipt as printed.
- **Receipt numbers:** the sequence is kept on the device row and only moves
  forward; a pull never lowers it.
- **Sign-out:** refused while unsynced changes are in the outbox; otherwise it
  clears the session and the local database, online or not.
