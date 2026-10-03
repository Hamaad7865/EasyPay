-- 0023_revoke_seeder.sql — seed_demo_catalog is server-side only.
-- PUBLIC (hence any authenticated tenant role) could execute it directly;
-- it runs SECURITY DEFINER as owner. The API calls it over its owner
-- connection, which is unaffected. Never edit after merge.

revoke all on function seed_demo_catalog(uuid) from public;
