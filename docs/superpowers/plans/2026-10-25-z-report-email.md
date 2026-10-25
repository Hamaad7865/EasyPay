# Plan: the Z report by email

Design: `docs/superpowers/specs/2026-10-25-z-report-email-design.md`. One session, in
the main folder, in this order. No migration, no Room version, nothing on Neon.

## 1. The mail service (`cloudflare/mail/`)

- `wrangler.toml`: Worker `easypay-mail`, custom domain `mail.easypaypos.com`,
  `workers_dev = false`, `send_email` binding `EMAIL`, Durable Object `BOOK`
  (class `Book`, SQLite), no vars and no secrets.
- `src/rules.js`, pure and tested by `src/rules.test.mjs` (`node --test`): an address
  as taken, the limits of a body, a mail's subject, text and HTML from a Z's lines
  (every character escaped), the confirm and stop mails and pages, the day's counter
  keys.
- `src/index.js`: `GET /health`; `POST /v1/ask`, `/v1/state`, `/v1/z`, `/v1/stop`
  (JSON, the till's key in the body, never in the address); `GET`/`POST /c/<token>`
  (confirm) and `/s/<token>` (stop). The `Book` holds asks, confirmed addresses (the
  key's SHA-256), mail ids taken, and the day's counters.
- `test/flow.mjs`: the whole exchange against `wrangler dev` here (the binding is
  simulated there: the mail is written to a file, nothing is sent).
- `deploy.cjs`: dry by default (is easypaypos.com onboarded for sending, is the
  Worker live), `--apply` deploys and asks `/health`.
- `README.md`.

## 2. The tablet

- `BuildConfig.MAIL_URL` (`mailUrl` in `local.properties` for a debug build; the
  release's is `https://mail.easypaypos.com`).
- `core/data/ZMailRules.kt`, pure and tested: the setting as kept (JSON), the address
  check, which closings are due (after the mark, within 31 days, oldest first, a few
  at a time), what an answer of the service does to the setting, what the page says.
- `SessionStore`: one key, `z_mail`, written with `edit` (one write, all or nothing).
- `Ops.dayClosesAfter(device, after, limit)`: a query, no schema change.
- `Docs.zLook` beside `reportLook`: the Z as lines of text.
- `core/network/MailClient.kt`: the four calls, its own HTTP client.
- `core/data/ZMail.kt`: save (on, address), the state, `run()` (ask, check, send what
  is due); `core/sync/ZMailWorker.kt` with `ZMailWork.soon/start/stop` (network
  constraint; started and stopped beside the MRA's in `SyncScheduler`).
- `CashOps`: `ZMailWork.soon` after each of the five closings.
- Settings > Cash drawer: `ZMailPanel` under "Close the day automatically", guarded by
  `settings.device`. The till's Help, in both businesses' words.

## 3. Release

- `versionName` 0.9.27, `versionCode` 39 (`v0.9.26` is live).
- Unit tests (`testDebugUnitTest`), the Worker's tests and flow; the setting seen on
  an emulator against the Worker running here.
- Commit, push `restopos` to `github`. Hand the owner the Cloudflare steps and the tag.
