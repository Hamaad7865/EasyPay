# Customers across Neon projects, part 2 of 2: opening a project, and releasing to all of them

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in one session. No subagent per task: the owner pays per token, and each subagent would start cold on a codebase this size. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command opens a new Neon project ready for customers; one release tag puts every project up to date; the platform admin exists in every project.

**Needs:** all of part 1, `2026-10-09-projects-directory.md`, built and committed (migration 0087, `/where`, the directory in the back office). Read part 1's design section first: the **home** project holds the one Neon Auth and the directory; a **data project** carries the same schema, its own tenants, and a till API that verifies the home's tokens.

**Architecture:** A data project is made by a script on the owner's PC with the Neon CLI signed in, never by the back office (the admin area has no key to Neon, and must not). The script creates the project in Singapore beside the others, names its branch `production` so every tool treats it like the home's, caps its compute at 0.25 CU as the home's is, applies every migration, copies the platform admins, deploys the till API with the home's auth addresses, and registers the project in the directory with its pooled address, which goes from Neon to the home's database through the script and nowhere else. The release workflow then lists the projects from the directory and runs its database and API jobs once per project.

**Tech stack:** Neon CLI (`neon`), Node scripts in `db/scripts/` and `cloudflare/`, GitHub Actions (`.github/workflows/deploy.yml`).

**House rules:** the same as part 1. In addition: every script here reads the home's address from the Neon CLI as `db/migrate-production.cjs` does, and refuses to run unless it is talking to the home's `production` branch or, with `--dev`, to the dev branch; nothing in them prints a database address.

---

## File map

| File | Change |
|---|---|
| `db/scripts/new-project.cjs` | New: opens a data project (the steps below), `--dry-run` says what it would do. |
| `db/scripts/new-project.test.cjs` | The pure parts: the project's name, the branch check, what is printed. |
| `db/tests/production-hosts.json` | New: the production hosts of every project, read by the test guard. |
| `db/tests/require-dev.cjs` | Reads that file as well as its built-in list. |
| `db/migrate-production.cjs` | `--project <id>`: another project's `production` branch; the host check becomes "that project's branch is named production". |
| `db/scripts/platform-admin.cjs` | `grant` also writes the admin into every data project. |
| `.github/workflows/deploy.yml` | A `projects` job lists them; `database` and `api` run per project. |
| `docs/superpowers/plans/2026-10-09-projects-provisioning.md` | This file: a status line when done. |

---

### Task 1: the test guard knows every production host

**Files:** Create `db/tests/production-hosts.json`. Modify `db/tests/require-dev.cjs`, `db/tests/guard.test.cjs`.

- [ ] **Step 1: the check first.** In `guard.test.cjs`, add: with `production-hosts.json` holding `["ep-made-up-host-1234"]`, `requireDev({ NEON_BRANCH: 'dev-review', DATABASE_URL: 'postgresql://u:p@ep-made-up-host-1234-pooler.x.neon.tech/neondb' })` throws "points at the production endpoint". Read how the suite drives `requireDev` today and follow it. Run: fails.
- [ ] **Step 2:** `production-hosts.json` is `["ep-soft-poetry-b3lyjmxs"]` (the home). `prodHosts()` in `require-dev.cjs` concatenates the file's list (read with `fs`, relative to `__dirname`), `PROD_HOSTS` and `RESTOPOS_PROD_HOSTS`. Run: passes. Every suite still runs on dev (`node db/tests/platform.test.cjs`).
- [ ] **Step 3: commit.**

### Task 2: migrating another project

**Files:** Modify `db/migrate-production.cjs`.

- [ ] **Step 1:** Take `--project <id>` (default the home, `PROJECT`). When it is not the home, skip the `HOST` prefix check and instead require that `neon branches list --project-id <id> --output json` has a branch named `production` that is the project's default (`default: true`); otherwise stop: "this project has no production branch: nothing was done". Everything else unchanged: dry run by default, `--apply` applies, each migration one transaction.
- [ ] **Step 2:** Check by hand against the home with no flag: `node db/migrate-production.cjs` still says "Nothing to apply." or lists the pending ones, and changes nothing. (Production is the owner's: do not pass `--apply`.)
- [ ] **Step 3: commit.**

### Task 3: the script that opens a project

**Files:** Create `db/scripts/new-project.cjs`, `db/scripts/new-project.test.cjs`.

- [ ] **Step 1: the pure parts, tested first.** `new-project.cjs` exports (when required as a module, as `cloudflare/production-settings.cjs` does for its test):

```js
// 'Project 2' -> 'easypay-project-2': what Neon shows, lowercase, dashes
function projectName(label)
// the connection string's host, without the '-pooler' suffix: what production-hosts.json keeps
function hostOf(connectionString)
// what the owner is shown at the end: never a database address
function summary({ id, name, apiUrl, host })
```

`new-project.test.cjs`: `projectName('Project 2')` → `easypay-project-2`; a name with spaces and capitals; `hostOf('postgresql://u:p@ep-a-b-pooler.c.neon.tech/neondb')` → `ep-a-b`; `summary(...)` contains the id, the name and the API address and nothing that starts with `postgresql://`. Run: fails; write them; passes.

- [ ] **Step 2: the steps, in order, each printed as it runs.** `node db/scripts/new-project.cjs "Project 2"` (`--dry-run` prints the plan and stops before step 1):

  1. **Refuse if the home is not reachable**: `neon connection-string production --project-id snowy-fire-89764432 --role-name neondb_owner` must answer and its host must start with `ep-soft-poetry` (the home check `migrate-production.cjs` makes). The home's address is kept in a variable, never printed.
  2. **Create**: `neon projects create --name <projectName> --region-id aws-ap-southeast-1 --output json`; read the new id. Then `neon branches rename main production --project-id <id>` (the CLI's branch commands; check `neon branches --help` for the exact verb, and say in a comment which it was). Then cap the compute as the home's is: `MSYS_NO_PATHCONV=1 neon api PATCH /projects/<id>/endpoints/<endpointId> --data '{"endpoint":{"autoscaling_limit_min_cu":0.25,"autoscaling_limit_max_cu":0.25}}'` for the branch's endpoint (`neon branches list --output json` gives it), and the same for the project's default (`PATCH /projects/<id>` with `default_endpoint_settings`). These are the calls made on 2026-10-08 for the home (memory `restopos-business-model`).
  3. **Migrate**: the new project's unpooled owner address into `DATABASE_URL_UNPOOLED` of a child process running `node db/migrate.cjs` (it reads the environment before `.env.local`). Then `select count(*) from schema_migrations` there must equal the home's.
  4. **Admins**: copy `platform.admins` rows from the home (`select auth_user_id, email, created_at, revoked_at`) into the new project with `insert ... on conflict (auth_user_id) do update set revoked_at = excluded.revoked_at`.
  5. **Deploy the API**: `neon deploy --project-id <id> --branch production --no-env-pull --update-existing --allow-protected` with, in the child's environment, `HOME_AUTH_JWKS_URL` and `HOME_AUTH_BASE_URL` read from the home by `neon env pull --project-id snowy-fire-89764432 --branch production -e NEON_AUTH_JWKS_URL,NEON_AUTH_BASE_URL` into a temp file (the way `cloudflare/production-settings.cjs` pulls, line 101), and `MIN_TILL_VERSION`, `LATEST_TILL_*`, `TILL_APK_URL` empty (the data project reads till.json like the home: `releaseFile()` in `hello.ts` reads it on any branch named `production`). Then the new project's API address: `neon env pull --project-id <id> --branch production -e NEON_FUNCTION_API_BASE_URL`. `GET <api>/health` must answer `ok: true` and a `build` of at least `v2-0087`.
  6. **Register**: on the home, `select platform.add_project($1, $2, $3, $4, $5)` with the admin's id (`--admin <email>`: looked up in `platform.admins` by email; required), the project id, the label, the API address, and the **pooled** owner address of the new project (`neon connection-string production --project-id <id> --role-name neondb_owner --pooled`).
  7. **Guard**: append `hostOf(pooled)` to `db/tests/production-hosts.json` (sorted, unique) and say to commit it.
  8. **Print** `summary(...)`, and the one thing left to the owner: nothing. The next release tag deploys to it like the others (Task 5).

  A step that fails stops the script with the step's name; the steps before it stand (a half-made project is listed by `neon projects list` and can be deleted with `neon projects delete <id>`; say so in the error).

- [ ] **Step 3: try it against dev, not production.** `--dev` makes the "home" the dev branch (`dev-review`, host `ep-falling-surf`) for steps 1, 4 and 6, so the directory row lands in dev's `platform.projects`. The new project is real either way (one of the 100): make one named "Claude test", check `/where` from the dev API answers its address for a login placed there (`select platform.place_login(...)` on dev for a throwaway auth id, then the SQL of part 1's D9), then **delete the project** (`neon projects delete`) and the dev directory row (`delete from platform.logins where project_id = ...; delete from platform.projects where id = ...` on dev, in one transaction). Say in the report that this spent one project creation and a few minutes of its compute.
- [ ] **Step 4: commit.**

### Task 4: the platform admin in every project

**Files:** Modify `db/scripts/platform-admin.cjs`.

- [ ] **Step 1:** After `grant` has written the home's `platform.admins` row, read `select id, database_url from platform.projects where database_url <> ''` from the home and upsert the same row into each (as Task 3 step 4 does; share the function by exporting it from `new-project.cjs`). `revoke` does the same with `revoked_at`. A project it cannot reach is named and the rest continue; the command's exit code says one failed.
- [ ] **Step 2:** `node db/tests/make-platform-admin.test.cjs` still passes. Commit.

### Task 5: one tag releases to every project

**Files:** Modify `.github/workflows/deploy.yml`.

- [ ] **Step 1: a `projects` job** after `checks`: with `NEON_API_KEY`, read the home's production address (as the `database` job does), run

```bash
node -e '
  const { Client } = require("pg");
  (async () => {
    const c = new Client({ connectionString: process.env.HOME_URL, ssl: { require: true } });
    await c.connect();
    const r = await c.query("select id from platform.projects where database_url <> $1 order by created_at", [""]);
    await c.end();
    console.log(JSON.stringify([process.env.NEON_PROJECT_ID, ...r.rows.map((x) => x.id)]));
  })().catch((e) => { console.error(e.message); process.exit(1); });
' > projects.json
echo "list=$(cat projects.json)" >> "$GITHUB_OUTPUT"
```

and expose `outputs.list`. Before migration 0087 has run on production the query fails on the missing table: catch that one case (`relation "platform.projects" does not exist`) and output the home alone, so the release that carries 0087 can run.

- [ ] **Step 2: `database` and `api` per project.** Both jobs get `strategy: { fail-fast: true, matrix: { project: "${{ fromJson(needs.projects.outputs.list) }}" } }` and `needs: [checks, projects]` (`api` also `database`). Replace `"$NEON_PROJECT_ID"` with `"${{ matrix.project }}"` in their steps; the migration steps call `node db/migrate-production.cjs --project "${{ matrix.project }}"`; the restore-point step names its branch the same way (ten branches per project, two restore points kept, as today). The `api` deploy step adds `HOME_AUTH_JWKS_URL` and `HOME_AUTH_BASE_URL`, read in a step before it from the home with `neon env pull` (masked with `::add-mask::`), **only when `matrix.project` is not the home** (an `if:` on the step, and empty values for the home). The `backoffice` and `site` jobs' `needs` and `if:` conditions keep referring to `needs.database.result` and `needs.api.result`, which for a matrix job is the whole matrix's result: all projects, or nothing goes further.
- [ ] **Step 3: the workflow's header** says what changed: one tag, every project; a project that fails stops the release there, the others already done stay done, and the run can be started again.
- [ ] **Step 4: check what can be checked without a tag.** `node -e 'require("js-yaml")'` is not available: validate with `npx --yes @action-validator/cli .github/workflows/deploy.yml` or `actionlint` if either installs cleanly; otherwise read it twice. **Do not push a tag.** Tell the owner the next tag is the first to run this.
- [ ] **Step 5: commit.**

### Task 6: dev in its own project (optional, the owner's call)

Every test run on `dev-review` spends the home's compute hours. Once customers are live at home, dev should be its own free project. What it costs: the dev branch's Neon Auth logins (the owner's dev admin and the test clients' logins) belong to the home's auth. `neon_auth."user"` is a table in the database, so a copy of the branch may carry them, but whether the new project's auth accepts those rows is not known.

- [ ] **Step 1 (only if the owner says yes):** open a project with Task 3's script as `--dev-project` (no directory row, no admins copy, no API auth override), restore a dump of `dev-review` into it (`pg_dump` of the branch, `psql` into the project; Neon documents this for moving between projects), deploy the API there with its own auth, and try one sign-in on the dev back office. If the sign-in fails, the logins are re-made with `platform-admin.cjs grant` and the admin page, and the owner is told.
- [ ] **Step 2:** `.env.local`, `web/.env.local` and `android/local.properties` point at it (the owner's files, gitignored; say which keys). `db/tests/require-dev.cjs` keeps refusing production: the new dev host is not in `production-hosts.json`, so nothing changes there.

---

## Not in this plan, on purpose

- **Moving a customer between projects** (`platform.move_login`, a copy of their rows): needed the day a project fills up, which is months away. It is a plan of its own.
- **Ageing out old receipts** to keep a project under 1 GB: about eighteen months away for a project of five busy restaurants.
- **A second Neon organization** for a customer that trades around the clock: a pricing decision first.

## Self-review notes

- Coverage: guard (T1), migrations to another project (T2), opening a project (T3), admins everywhere (T4), release to all (T5), dev project (T6, optional).
- Names: `--project` on `migrate-production.cjs`; `projectName`, `hostOf`, `summary` in `new-project.cjs`; `production-hosts.json`; `HOME_AUTH_JWKS_URL`, `HOME_AUTH_BASE_URL` as in part 1's `neon.ts`; `platform.add_project` and `platform.projects.database_url` as in part 1's migration 0087.
- Unverified when written: the exact Neon CLI verb for renaming a branch, and whether `neon deploy` accepts `--project-id` for a project that was never linked on the PC. T3 says to check `--help` and to note the answer in a comment.
