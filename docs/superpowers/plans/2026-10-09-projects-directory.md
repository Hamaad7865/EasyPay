# Customers across Neon projects, part 1 of 2: the directory and the routing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in one session. No subagent per task: the owner pays per token, and each subagent would start cold on a codebase this size. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer's data can live in any Neon project, and the till, the back office and the admin area find it by asking a directory kept in the first project; with every customer still in that first project nothing visible changes.

**Why (decided with the owner on 2026-10-09):** clients pay once, so hosting must stay free. Neon's free plan is capped per project (100 CU-hours of compute a month, 1 GB of storage) and allows 100 projects an account. The owner will put about two customers in each project, paired by opening hours. The schema needs no change for that: every table carries `tenant_id` under row-level security, so a project holding two customers is today's database with two tenant rows. What has to change is everything that assumes one database.

**Architecture:** The existing project (`snowy-fire-89764432`, branch `production`) becomes the **home**. It keeps the one Neon Auth (every login, every project), the platform admin, and the **directory**: two tables in the `platform` schema saying which project each login and each tenant live in, and how each project is reached. Other projects (**data projects**, part 2 makes them) carry the same schema and their own tenants; their till API verifies the home's tokens. The till signs in at the home as today, then asks it `GET /where` and keeps the answer as the address of its API. The back office keeps one sign-in and one cookie; after the session it asks the directory where the login's tenant is and opens that project's connection. A login or tenant with no directory row is at home: that is how everything already there keeps working, and how the dev branch's suites keep passing.

**Tech stack:** Postgres on Neon (dev branch `dev-review`), Hono till API in `hello.ts` (Neon Functions), Next.js back office in `web/` on Cloudflare Workers, Android till (Kotlin, Compose, Hilt) in `android/`.

**Part 2** is `2026-10-09-projects-provisioning.md`: the script that opens a project, the release that deploys to all of them, and the platform admin in every project. Nothing in part 1 needs a second project to exist; part 2 needs all of part 1.

**Written lean on purpose.** The owner pays for every token, and whoever executes this has the repository open. Code is given where it fixes a contract (SQL, a key's name, a signature, a test's checks). Screens are described by what they must show.

**House rules that apply to every task.**
- Work on branch `restopos`, one commit per task, message in the repository's style (what and why, in sentences). Never push unless asked; never to `origin`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Before editing a file, read its committed version; another session may have changed it. Before each task: `git status` and `git log -3`. Before naming a migration or a build number, read what the last one is (0086 and build 6 when this was written).
- A migration is fix-forward: a new numbered file, each function taken from its live definition (`node db/scripts/dump-function.cjs <schema.name>`), its header naming what changed.
- Dev only. Production migrations and deploys are the owner's, and **a `v*` or `live-*` tag puts everything on this branch live**: never push one.
- `web/next-env.d.ts` and `.claude/` stay out of commits.
- Secrets: a project's database address holds a password. It is read on the server only, never printed, never sent to a browser or a till, never written to a test's output.

---

## What the directory holds, and the rules

| | |
|---|---|
| `platform.projects` | one row per Neon project: `id` (the Neon project id), `name` (what the admin sees), `api_url` (its till API), `database_url` (pooled, `neondb_owner`), `created_at`, `closed_at` (no new customers here). The home's row has empty `api_url` and `database_url`: "this server's own". |
| `platform.logins` | one row per login: `auth_user_id`, `project_id`, `tenant_id`. Written when a login is created or linked; backfilled for every login that exists. |
| no row | at home. A till is told to stay where it is; the back office uses its own `DATABASE_URL`. |

Rules the tests pin down:
- the tenant role (`app_user`) cannot see either table;
- only a live platform admin can add a project or place a login, and each is in the audit log, without the database address;
- a login is placed once: placing it again in another project is refused (`login-already-placed`), unless part 2's move script does it on purpose (`platform.move_login`, not in this plan);
- a project that is closed takes no new logins (`project-closed`);
- the home row exists after the migration, and every login that existed is placed at home.

---

## File map

| File | Change |
|---|---|
| `db/tests/projects-directory.test.cjs` | New suite, written first. |
| `db/migrations/0087_projects_directory.sql` | The two tables, the home row, the backfill, `platform.add_project`, `platform.close_project`, `platform.place_login`. |
| `where.ts` (repository root, beside `till-release.ts`) | New: the pure decision of what `/where` answers. |
| `where.test.cjs` (root; see how `till-release.test.cjs` is run, or add it the same way) | Its tests. |
| `hello.ts` | `requireAuth` split so a token can be verified without an employee row; `GET /where`; the auth's addresses may be the home's (`HOME_AUTH_*`). |
| `neon.ts` | Passes `HOME_AUTH_JWKS_URL` and `HOME_AUTH_BASE_URL` to the function. |
| `android/.../core/network/Where.kt` | New: which API address the till uses, from what it saved and what it was told. |
| `android/app/src/test/.../core/network/WhereTest.kt` | Its tests, written first. |
| `android/.../core/network/AuthClient.kt` | Keeps the API address beside the till key. |
| `android/.../core/network/ApiClient.kt` | Every call goes to the kept address, or the built-in one. `where()`. |
| `android/.../feature/auth/AuthViewModels.kt` | After sign-in, asks where and keeps the answer, before anything else. |
| `web/lib/db.ts` | An asker and a transaction can be for another project's address; a tenant's address is looked up in the directory and remembered a minute. |
| `web/lib/projects.ts` | New: the directory, read from the home. |
| `web/lib/projects.test.mjs` | Its pure parts. |
| `web/lib/tenant.ts` | The session's login is looked up in the directory first, then in its project. |
| `web/lib/platform-auth.ts` | "Already belongs to a client" asks the directory. |
| `web/app/admin/page.tsx`, `view.tsx` | The list spans every project; a new client is made in a chosen open project and its owner placed. |
| `web/app/admin/tenants/[id]/page.tsx` | Every action runs in the tenant's project; a new login is placed. |

---

### Task 1: the directory's suite, failing

**Files:** Create `db/tests/projects-directory.test.cjs`.

- [ ] **Step 1: write the suite.** One transaction, rolled back, in the shape of `db/tests/platform.test.cjs` (its `check`, `failsWith`, `one`, the dev guard). Checks, by name:

```
D1 app_user cannot select from platform.projects nor platform.logins
D2 the home row exists: id 'snowy-fire-89764432', api_url '' and database_url ''
D3 a stranger cannot add a project (not-a-platform-admin); an admin can, and the audit row
   (action 'project.add') carries the id and name and NOT the database address
D4 adding the same id again is refused (project-exists)
D5 a login placed in a project is found there (select project_id, tenant_id from platform.logins)
D6 placing the same login again, in another project, is refused (login-already-placed);
   placing it again in the same project and tenant is a no-op
D7 a closed project takes no new login (project-closed); one already placed there is still found
D8 the backfill: a tenant made with platform.create_tenant before the migration has its
   owner's login placed at home. In the test: insert an employee with an auth_user_id and
   call platform.backfill_logins(); the row appears with project 'snowy-fire-89764432'
D9 the lookup the back office and the API use, as one statement each:
     select p.database_url from platform.logins l join platform.projects p on p.id = l.project_id where l.tenant_id = $1
     select p.api_url from platform.logins l join platform.projects p on p.id = l.project_id where l.auth_user_id = $1
   both answer '' for a login at home and the url for one placed elsewhere
```

For D3, D5 to D7 the admin is a throwaway row in `platform.admins`, the project a made-up id such as `'test-' || substr(gen_random_uuid()::text, 1, 8)` with `api_url 'https://api.test.invalid'` and `database_url 'postgresql://x:y@db.test.invalid/neondb'`.

- [ ] **Step 2: run it.** `node db/tests/projects-directory.test.cjs`. Expected: fails on D1 (relation does not exist).
- [ ] **Step 3: commit** the suite alone.

### Task 2: migration 0087

**Files:** Create `db/migrations/0087_projects_directory.sql`.

- [ ] **Step 1: write it.** Header in the house style (what, why, the owner's decision). Then:

```sql
create table if not exists platform.projects (
  id text primary key,
  name text not null,
  api_url text not null default '',
  database_url text not null default '',
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create table if not exists platform.logins (
  auth_user_id uuid primary key,
  project_id text not null references platform.projects (id),
  tenant_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_platform_logins_tenant on platform.logins (tenant_id);

insert into platform.projects (id, name) values ('snowy-fire-89764432', 'Home')
  on conflict (id) do nothing;

create or replace function platform.add_project(p_admin uuid, p_id text, p_name text, p_api_url text, p_database_url text)
returns void language plpgsql set search_path = public as $fn$
begin
  perform platform.require_admin(p_admin);
  if btrim(coalesce(p_id, '')) = '' or btrim(coalesce(p_name, '')) = '' then raise exception 'name-required'; end if;
  if exists (select 1 from platform.projects where id = p_id) then raise exception 'project-exists'; end if;
  insert into platform.projects (id, name, api_url, database_url) values (p_id, btrim(p_name), coalesce(p_api_url, ''), coalesce(p_database_url, ''));
  insert into platform.audit (admin_auth_user_id, action, detail)
    values (p_admin, 'project.add', jsonb_build_object('project', p_id, 'name', btrim(p_name), 'api_url', coalesce(p_api_url, '')));
end $fn$;

create or replace function platform.close_project(p_admin uuid, p_id text)
returns void language plpgsql set search_path = public as $fn$
begin
  perform platform.require_admin(p_admin);
  update platform.projects set closed_at = coalesce(closed_at, now()) where id = p_id;
  if not found then raise exception 'unknown-project'; end if;
  insert into platform.audit (admin_auth_user_id, action, detail) values (p_admin, 'project.close', jsonb_build_object('project', p_id));
end $fn$;

create or replace function platform.place_login(p_admin uuid, p_auth uuid, p_project text, p_tenant uuid)
returns void language plpgsql set search_path = public as $fn$
declare v_closed timestamptz; v_have record;
begin
  perform platform.require_admin(p_admin);
  if p_auth is null then raise exception 'login-required'; end if;
  select closed_at into v_closed from platform.projects where id = p_project;
  if not found then raise exception 'unknown-project'; end if;
  select project_id, tenant_id into v_have from platform.logins where auth_user_id = p_auth;
  if found then
    if v_have.project_id = p_project and v_have.tenant_id = p_tenant then return; end if;
    raise exception 'login-already-placed';
  end if;
  if v_closed is not null then raise exception 'project-closed'; end if;
  insert into platform.logins (auth_user_id, project_id, tenant_id) values (p_auth, p_project, p_tenant);
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'login.place', p_tenant, jsonb_build_object('project', p_project, 'login', p_auth));
end $fn$;

-- Every login that exists is at home. Run by this migration, and again by part 2's
-- scripts after a copy, so it is a function.
create or replace function platform.backfill_logins() returns integer
language plpgsql set search_path = public as $fn$
declare n integer;
begin
  insert into platform.logins (auth_user_id, project_id, tenant_id)
    select e.auth_user_id, 'snowy-fire-89764432', e.tenant_id from employees e
     where e.auth_user_id is not null and e.deleted_at is null
    on conflict (auth_user_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $fn$;
select platform.backfill_logins();
```

The schema's privileges already keep `app_user` out (0044 revoked usage on `platform` from public); D1 confirms it.

- [ ] **Step 2: apply to dev.** `node db/migrate.cjs`. Then `node db/tests/projects-directory.test.cjs`: all pass. Then `node db/tests/platform.test.cjs` and `node db/tests/premium-gate.test.cjs` still pass.
- [ ] **Step 3: commit.** Add `project-exists`, `unknown-project`, `login-already-placed`, `project-closed` to `MESSAGES` in `web/lib/platform.ts` in this commit too ("That project id is already registered.", "That project does not exist.", "That login already belongs to a client in another project.", "That project takes no new clients.").

### Task 3: the API answers where a login's data is

**Files:** Create `where.ts`, `where.test.cjs`. Modify `hello.ts`, `neon.ts`.

- [ ] **Step 1: the pure decision, tested first.** `where.ts` exports:

```ts
// What GET /where answers a login. `placed` is the directory's api_url for the
// login, null when it has no row. An empty address means "stay where you are".
export type Where = { api: string };
export function whereFor(placed: string | null | undefined): Where {
  const api = (placed ?? "").trim().replace(/\/+$/, "");
  return { api: /^https:\/\//.test(api) ? api : "" };
}
```

`where.test.cjs` (run as `till-release.test.cjs` is; read how that one loads its TypeScript): null → `""`; `""` → `""`; `"https://x.neon.tech/"` → `"https://x.neon.tech"`; `"http://x"` → `""` (never an insecure address). Run, see it fail, write `where.ts`, run, pass.

- [ ] **Step 2: `hello.ts`.** Split `requireAuth` into `subjectOf(req): Promise<string>` (the token check alone, throwing the 401 Response as today) and `requireAuth`, which calls it and then does the employee lookup unchanged. The auth's addresses: where `NEON_AUTH_JWKS_URL` and `NEON_AUTH_BASE_URL` are read, read `process.env.HOME_AUTH_JWKS_URL || process.env.NEON_AUTH_JWKS_URL` and `process.env.HOME_AUTH_BASE_URL || process.env.NEON_AUTH_BASE_URL`, with a comment: a data project verifies the home's tokens. Then:

```ts
// Where this login's business lives. A login is placed in a project by the
// platform admin (platform.logins, migration 0087); one with no row is here.
// Verified token only: the login's employee row is in its own project, which
// may not be this one. Answered the same for a login that is placed nowhere
// and one that does not exist, so nothing is learnt by asking.
app.get("/where", async (c) => {
  let sub: string;
  try { sub = await subjectOf(c.req.raw); } catch (res) { return res as Response; }
  const found = await pool.query(
    `select p.api_url from platform.logins l join platform.projects p on p.id = l.project_id where l.auth_user_id = $1`,
    [sub],
  );
  return c.json(whereFor(found.rows[0]?.api_url ?? null));
});
```

Raise the `build` string in `/health` to `"v2-0087"`.

- [ ] **Step 3: `neon.ts`.** In the function's `env`, add `HOME_AUTH_JWKS_URL: process.env.HOME_AUTH_JWKS_URL?.trim() || ""` and `HOME_AUTH_BASE_URL: process.env.HOME_AUTH_BASE_URL?.trim() || ""`, with a comment: set only when deploying a data project (part 2), empty at home and on dev, where the project's own auth is the one.
- [ ] **Step 4: deploy to dev and check.** `neon deploy --branch dev-review --env .env.local --env-pull=false` (as the other sessions do). Then `curl -s $NEON_FUNCTION_API_BASE_URL/where` (no token) → 401; `curl -s .../health` shows `v2-0087`. `node db/tests/api-till-key.test.cjs` still passes (its health check reads the build string with `>=`).
- [ ] **Step 5: commit.**

### Task 4: the till keeps the address it was told

**Files:** Create `android/app/src/main/java/com/restopos/core/network/Where.kt`, `android/app/src/test/java/com/restopos/core/network/WhereTest.kt`. Modify `AuthClient.kt`, `ApiClient.kt`, `feature/auth/AuthViewModels.kt`.

- [ ] **Step 1: the decision, tested first.** `Where.kt`:

```kotlin
package com.restopos.core.network

// Which server a till talks to. The build carries one address (the home,
// BuildConfig.FUNCTION_URL); a business whose data is in another project is
// told that project's address by GET /where after sign-in, and the tablet
// keeps it beside its till key. An empty answer means the home.
object Where {
    // the address every call goes to
    fun api(kept: String?, builtIn: String): String = kept?.trim()?.trimEnd('/')?.takeIf { it.startsWith("https://") } ?: builtIn.trimEnd('/')
    // what to keep after /where answered: the address, or null for "the home"
    fun keep(answer: String?): String? = answer?.trim()?.trimEnd('/')?.takeIf { it.startsWith("https://") }
}
```

`WhereTest.kt` (JUnit 4, as `QuietTest.kt`): nothing kept → the built-in one, without its trailing slash; kept `https://x/` → `https://x`; kept `http://x` is ignored → built-in; `keep("")` → null; `keep("https://x/")` → `"https://x"`. Run `android/gradlew -p android --priority low --max-workers 2 :app:testDebugUnitTest --tests '*WhereTest*'`: fails to compile, then write `Where.kt`, passes.

- [ ] **Step 2: `AuthClient.kt`.** Beside the till key: `private const val KEY_API_URL = "api_url"`, and

```kotlin
    // The address of the business's own till API, told by GET /where at sign-in
    // (core/network/Where.kt). Kept like the till key: through sign-outs and
    // ended sessions, replaced at the next sign-in. Null: the built-in one.
    suspend fun apiUrl(): String? = withContext(Dispatchers.IO) { secrets.get(KEY_API_URL) }
    suspend fun saveApiUrl(url: String?) = withContext(Dispatchers.IO) { if (url == null) secrets.remove(KEY_API_URL) else secrets.put(KEY_API_URL, url) }
```

- [ ] **Step 3: `ApiClient.kt`.** `functionUrl` becomes `private val builtIn = baseUrl.trimEnd('/')` and `private suspend fun url(path: String) = Where.api(auth.apiUrl(), builtIn) + path`. Every `"$functionUrl/..."` becomes `url("/...")` (health, me, devices/register, devices/key twice, sync/pull, sync/push, crash, and any other). Add:

```kotlin
    // Where this login's business lives: the address to keep, or null for the
    // home. Asked of the home itself (the built-in address, never a kept one:
    // only the home has the directory), with the login, never the till key.
    suspend fun where(): String? =
        Where.keep(authed { a -> http.get("$builtIn/where") { header(HttpHeaders.Authorization, a) } }.body<WhereResponse>().api)
```

with `@Serializable data class WhereResponse(val api: String = "")` in `dto/`.

- [ ] **Step 4: `AuthViewModels.kt`.** In `onAction`, right after `auth.signIn` succeeds and before `session.tenantId()` is read:

```kotlin
        // Where this business's data is: the home's answer, kept for every call
        // from now on. Without it a login of another project would be checked
        // against the home, which does not know it.
        val where = runCatching { api.where() }
        if (where.isFailure) {
            _state.value = AuthUiState.Error("The server could not say where this business is kept. Check the connection and try again.")
            return@launch
        }
        auth.saveApiUrl(where.getOrNull())
```

A tablet already set up for a business keeps checking `me.tenantId == tenant` as today, now against the right project.

- [ ] **Step 5: build and see.** `android/gradlew -p android --priority low --max-workers 2 :app:testDebugUnitTest :app:assembleDebug`. All unit tests pass. On the emulator `easypay_claude_till` (port 5586; never the owner's), install the debug build; the made-up restaurant needs no login and must still sell and sync as before, since nothing is kept and the built-in address is used. A sign-in cannot be tried by Claude (no account on the hosted auth): say so in the report, and give the owner the one check: sign in on dev, then `adb shell` is not needed, the till simply works as before.
- [ ] **Step 6: commit.** Do not raise `versionCode`: a release is the owner's call, and this must go out together with the back office.

### Task 5: the back office reaches a tenant's own project

**Files:** Create `web/lib/projects.ts`, `web/lib/projects.test.mjs`. Modify `web/lib/db.ts`, `web/lib/tenant.ts`.

- [ ] **Step 1: `projects.ts`, pure part tested first.** Exports:

```ts
export type Placement = { projectId: string; tenantId: string; databaseUrl: string | null; apiUrl: string };
// '' in the directory means the home: the server's own DATABASE_URL (null here)
export function placement(row: { project_id: string; tenant_id: string; database_url: string; api_url: string } | undefined): Placement | null {
  if (!row) return null;
  const url = row.database_url.trim();
  return { projectId: row.project_id, tenantId: row.tenant_id, databaseUrl: url === "" ? null : url, apiUrl: row.api_url.trim() };
}
// the directory, read from the home (lib/db's own address)
export async function placementOfLogin(authUserId: string): Promise<Placement | null>   // by platform.logins.auth_user_id
export async function placementOfTenant(tenantId: string): Promise<Placement | null>    // by platform.logins.tenant_id (any login of it)
export async function openProjects(): Promise<{ id: string; name: string }[]>           // closed_at is null, ordered by created_at
```

`projects.test.mjs` (run as `node web/lib/projects.test.mjs`, like `counts.test.mjs`): `placement(undefined)` is null; a home row gives `databaseUrl: null`; a placed row gives its url trimmed. The three async functions use `ask()` from `db.ts` with no address (the home).

- [ ] **Step 2: `db.ts`.** Every way in takes an optional address, the home when absent:
  - `pool()` becomes `pool(url = process.env.DATABASE_URL!)` with one `Pool` per address in a `Map` on `globalThis` (`__easypayPools`), same options; `own(url)` likewise; `db(url?)`, `ask(sql, params, url?)`, `take(url?)`.
  - `begin(tenantId, readOnly)` first finds the tenant's address: `const url = await addressOfTenant(tenantId)`, then `take(url)`. `addressOfTenant` asks the home `select p.database_url from platform.logins l join platform.projects p on p.id = l.project_id where l.tenant_id = $1 limit 1` and remembers the answer for 60 seconds in a module-level `Map<string, { url: string | undefined; until: number }>` (`undefined` for "home", so a miss is not asked again every time). The comment says why a minute: a tenant moves only when the owner runs part 2's move script, and a Worker that is already running may follow a minute late.
  - `withTenant` and `readTenant` keep their signatures: callers pass the tenant id as before, so the 63 call sites do not change.
  - Export `dbOfTenant(tenantId): Promise<Asker>` for the admin actions: `db(await addressOfTenant(tenantId))`.
- [ ] **Step 3: `tenant.ts`.** In `tenantContext`, after the session: `const where = await placementOfLogin(user.id)`; the employee query runs `ask(sql, [user.id], where?.databaseUrl ?? undefined)`. Same in `loginStanding`. A comment: the login's employee row is in its project; a login with no placement is at home.
- [ ] **Step 4: check.** `npm run typecheck` in `web/`. `node web/lib/projects.test.mjs`. Start the dev back office (launch entry `web`); the owner's dev login still reaches its pages (every dev login is at home). The suites that render pages read-only (`db/tests/pos-pages.test.cjs`, `backoffice-saves.test.cjs`) still pass.
- [ ] **Step 5: commit.**

### Task 6: the admin area knows projects

**Files:** Modify `web/lib/platform-auth.ts`, `web/app/admin/page.tsx`, `web/app/admin/view.tsx`, `web/app/admin/tenants/[id]/page.tsx`.

- [ ] **Step 1: `platform-auth.ts`.** In `loginForRestaurant`, `linked` becomes `exists (select 1 from platform.logins l where l.auth_user_id = u.id)`: the employees table of the home no longer knows every client.
- [ ] **Step 2: creating a client (`admin/page.tsx`).** The form gains `project` (an open project's id; the home is the default). `createTenant`: after `loginForRestaurant`, run `create_tenant_of_type` on `db(await addressOfProject(project))` (add `addressOfProject(id)` to `projects.ts`: the row's `database_url`, null for the home, and refuse an unknown or closed id with `adminMessage`), then `platform.place_login($admin, $userId, $project, $tenantId)` on the **home** (`db()`). If placing fails, the tenant was already made in its project: say so in the error ("The client was created but its owner's login could not be placed: ") and do not remove the login. The list: for every project in `openProjects()` plus the closed ones (`allProjects()`), run today's tenants query on `db(address)` and concatenate; each `TenantRow` gains `project: string` (the name). `AdminHome` gets `projects: { id: string; name: string }[]` for the form.
- [ ] **Step 3: `view.tsx`.** Under Plan, a "Project" field: a radio group of the open projects, the home checked, with the help text "Where this client's data is kept. Two clients with the same opening hours share a project well." Shown only when there is more than one open project. The table gets a Project column, shown under the same condition.
- [ ] **Step 4: the client page (`tenants/[id]/page.tsx`).** `tenantOf` also returns `at: await dbOfTenant(tenantId)`; every `db().query('select platform.<fn>...')` becomes `at.query(...)`, and the page's own reads too. `addLogin`: after `platform.add_login` succeeds, `platform.place_login` on the home with the tenant's project id (`placementOfTenant(tenantId)?.projectId ?? "snowy-fire-89764432"`). Export the home id once, `HOME_PROJECT_ID`, from `projects.ts`, and use it here and in the admin page rather than the literal.
- [ ] **Step 5: check.** `npm run typecheck`. `node db/tests/backoffice-access.test.cjs` and `make-platform-admin.test.cjs` still pass. In the browser (the owner's admin login on dev): the admin home lists the same clients, with no Project column (one project); creating a client works and its owner now has a `platform.logins` row (`select * from platform.logins order by created_at desc limit 1` on dev). Claude cannot sign in to `/admin` (hosted auth); give the owner these two checks, or render the pages with `render_all.cjs` if it is still in the old scratchpad.
- [ ] **Step 6: commit.**

### Task 7: what the owner has to know, written down

**Files:** Modify this plan's status line below; update memory `restopos-projects-per-customer-group.md` (what is built, what part 2 still needs).

- [ ] **Step 1:** Note in the plan: part 1 built on dev; the next release tag carries migration 0087, `/where`, and the back office that reads the directory, and the till build after it keeps an address. Until part 2 opens a second project, nothing is placed anywhere but home.
- [ ] **Step 2:** Tell the owner in the report: the first two customers can go live without part 2; part 2 is needed on the day a third customer is signed, to open the second project.

---

## Self-review notes

- Coverage: directory tables and functions (T1, T2), API `/where` and the home's tokens (T3), till (T4), back office routing (T5), admin (T6). Part 2 covers opening a project, deploys and admins per project.
- Names used across tasks: `platform.projects`, `platform.logins`, `platform.add_project`, `platform.close_project`, `platform.place_login`, `platform.backfill_logins`; `whereFor` (API), `Where.api`/`Where.keep` (till), `apiUrl`/`saveApiUrl` (AuthClient), `where()` (ApiClient); `placement`, `placementOfLogin`, `placementOfTenant`, `openProjects`, `addressOfProject`, `HOME_PROJECT_ID` (projects.ts); `addressOfTenant`, `dbOfTenant`, `ask(sql, params, url?)`, `db(url?)` (db.ts).
- The one thing not testable by Claude: a real sign-in on the till and in the browser, which needs an account on the hosted auth. Both are the owner's checks, named in T4 and T6.
