# Usage in the admin area: design

Asked 2026-10-09: "In the super admin thing, I want to be able to see how much compute used, how much
left, how much used per client etc. Can we build this?" The owner's answers are quoted where they decide
something. Approved the same day: "yes go ahead and write the spec, build it deploy then let me know".

## What Neon can and cannot say

Asked of Neon that day (`neon projects get`, `neon branches list`, `/projects/<id>/endpoints`):

- For the project and for each branch: `compute_time_seconds` (compute seconds; 3,600 make a compute
  hour, the unit the allowance is in) and `active_time_seconds` (time awake), since the period began.
- The period: `consumption_period_start` and `consumption_period_end`. It began 2026-10-08 18:31 UTC,
  not on the 1st, so the page never assumes a calendar month.
- `owner.subscription_type` (`free_v3`), `owner.branches_limit` (10),
  `branch_logical_size_limit_bytes` (1 GB), and each compute's `current_state` (`active` or `idle`).
- Not the allowance: 100 compute hours a month is the free plan's figure, kept in the page's code
  beside the plan's name. A plan the page does not know shows what was used and no "left".
- Nothing per day: the free plan keeps no history. And nothing per client: Neon meters a project and a
  branch. **Every per-client figure is our own estimate.**

That day: 3.05 of 100 compute hours used, 1.87 of them by `dev-review` and 1.18 by production.

## The owner's two choices

- The page covers "Compute and storage". Cloudflare's requests are left out.
- "GitHub reads them hourly": Neon's totals are read by a scheduled job and kept in the database; the
  back office never holds a Neon key. Neon has no read-only key: one that can read usage can delete
  every branch, the restore copies included, and the back office is on the internet.

## 1. Which client was active when

`platform.usage_hours (tenant_id, hour, slots)`: one row for each hour a client was active in. `slots`
has one bit for each five minutes of that hour (bit 0 is minutes 0 to 4). Five minutes because Neon
puts a compute to sleep after five idle minutes: one request keeps it awake about one slot.

`platform.usage_mark(tenant, at default now())` sets the bit. It reads first and writes only when the
bit is not set, so a client costs at most twelve small writes an hour. Two callers, both on the owner's
connection (a client's own connection cannot see the `platform` schema):

- **Tills:** `device_heard`, which the till API already calls on every sync, calls it. No change to
  the API's code, so no API deploy.
- **Back office:** `web/lib/db.ts`, after a client's transaction has closed, on the same connection.
  Not inside it: a page that only reads runs in a read-only transaction. Each server process notes a
  client once per slot and remembers that it did, so most requests ask nothing extra. A mark that
  fails is dropped: it is never in the way of a page.

Not counted to any client: `/admin`, sign-in, releases and migrations, a till's calls before it has a
key. They fall under "Not a client's".

## 2. Neon's totals, read hourly

`db/scripts/read-usage.cjs` asks Neon for the project, its branches and its computes, and saves one
reading with `platform.usage_read(jsonb)` into `platform.usage_days (project_id, day, ...)`: one row a
day (the day in Mauritius), each reading replacing that day's. So the newest row is the latest reading
and the rows together are the history Neon does not keep. A day's use is its figure less the day
before's, or its own figure on the first day of a period.

It saves only while the branch's compute is `active`: it never wakes a sleeping database. It is not
free, though: a write restarts the five-minute timer, so a reading can keep the database awake up to
five minutes longer. About 1 of the 100 hours a month. (The owner was first told "costs no compute",
then corrected.)

`.github/workflows/usage.yml` runs it every hour against production, and by hand with a switch to save
even when asleep. The repository is public, so its log is: the script prints "saved", "asleep" or "not
released yet" and never a figure, a client's name or the database's address. It stops with an error
naming the field when Neon's answer lacks one it needs. Before the migration is on production it says
"not released yet" and succeeds.

Readings carry the project's id, so a second project is more rows, not a new design.

## 3. The page

`/admin/usage`, a third entry in the admin bar. No charts.

- **Compute.** Used of the allowance, what is left, when the period ends, production against the
  other branches by name, and the day-by-day list. Where it is heading: used so far, carried at the
  same pace to the period's end, shown once the period is three days old; if that passes the
  allowance, the day it would run out. The reading's time is in the head; a reading more than a day
  old is flagged, since the job may have stopped.
- **Clients.** For each client, since the period began (or since counting began, if later), up to the
  reading's time:
  - *Share*: every slot in which production was awake for a client is split equally between the
    clients active in it. In compute hours, by production's own ratio of compute seconds to awake
    seconds. If the shares add up to more than Neon measured, they are scaled down to it.
  - *By itself*: its own active slots, in compute hours: what it would use with a database to itself.
    The figure for deciding who shares a project.
  - *Usual hours*: over the last fourteen days, the hours of the day (in Mauritius) it was active on
    at least half of its active days, from the first to the last. "Too early to say" under three days.
  - *Storage*: see below.
  - A last row, *Not a client's*: what production used less the shares; storage likewise.
  - With no reading yet there is nothing of Neon's to measure against: the slots are counted up to
    now, at a quarter of a compute hour an hour awake (the size every compute is capped at), and
    there is no last row.
- **Storage.** The database's size against Neon's limit, and the branches against theirs, with their
  names.

Storage per client is counted when the page opens: for every table that has a `tenant_id`, the
client's rows over all rows, times the table's size with its indexes (`platform.storage_by_tenant()`).
Quick at 50 MB; it reads every table, so it slows as the data grows, and is then to be kept from one
day to the next.

With no reading yet the page says so and how to run the job; the clients and the storage are shown
all the same, since they come from the database itself.

## What it costs to run

Marks ride on work the database is already doing. The hourly reading: about 1 compute hour a month.
Opening the page: one count of every table.

## How it is checked

- `db/tests/usage.test.cjs` on dev: a mark sets its bit once, a second in the same slot writes
  nothing, a till heard from marks its client, a client's connection can neither read nor write any of
  it, a reading replaces its day, storage adds up.
- `web/lib/usage.test.mjs`: the split, by itself, the scaling, the usual hours, the pace, the days.
- `db/scripts/read-usage.test.cjs`: Neon's answer turned into a reading; a missing field named.
- The script run against `dev-review`, and the page opened on dev's own rows through a temporary page
  that needs no sign-in, deleted before committing.

Not checked by me: anything on production, and the job on GitHub. Production is the owner's: the
migration and the back office go out with their next release tag, and the job starts when the branch
is pushed.

## Not included

Alerts when the hours run low, charts, Cloudflare's requests, a view across several projects.
