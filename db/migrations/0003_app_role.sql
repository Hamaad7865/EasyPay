-- 0003_app_role.sql — least-privilege runtime role for Neon Functions and tests.
-- Background: neondb_owner carries BYPASSRLS, so even FORCE RLS never filters it.
-- All tenant-scoped runtime access must SET ROLE app_user (no BYPASSRLS) plus
-- SET LOCAL app.tenant_id. Owner keeps BYPASSRLS for migrations/admin/signup.
-- Never edit after merge.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

grant connect, temporary on database neondb to app_user;
grant usage on schema public to app_user;

grant select, insert, update, delete on all tables in schema public to app_user;
grant usage, select on all sequences in schema public to app_user;

-- Future tables/sequences created by later migrations inherit the same grants.
alter default privileges for role neondb_owner in schema public
  grant select, insert, update, delete on tables to app_user;
alter default privileges for role neondb_owner in schema public
  grant usage, select on sequences to app_user;

-- Lets the owner (migrations, Functions runtime, tests) drop into the role.
grant app_user to neondb_owner;
