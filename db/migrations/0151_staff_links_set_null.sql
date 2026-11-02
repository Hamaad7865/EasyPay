-- 0151_staff_links_set_null.sql — who issued a credit note, and who put a promotion on or lifted it,
-- forget the person when that person's row goes, and only the person.
--
-- 0109 (credit_notes.issued_by) and 0110 (promotions.applied_by, lifted_by) wrote these keys as a plain
-- "on delete set null" over (tenant_id, <person>). On a key of two columns that nulls both, tenant_id
-- with it: deleting a member of staff who had issued a credit note or touched a promotion either failed
-- on tenant_id's not null, or would have left the row with no business. 0033 set the rule for every
-- composite key then in the database: a nullable person is nulled by name, "set null (<column>)", and
-- tenant_id stays. These three came after it; db/tests/fk-setnull.test.cjs found them (2026-11-03).
-- The same names, the same columns, the same parent; only the delete rule changes. Earlier migrations
-- untouched.
-- Never edit after merge.

alter table credit_notes drop constraint if exists credit_notes_tenant_id_issued_by_fkey;
alter table credit_notes add constraint credit_notes_tenant_id_issued_by_fkey
  foreign key (tenant_id, issued_by) references employees (tenant_id, id) on delete set null (issued_by);

alter table promotions drop constraint if exists promotions_tenant_id_applied_by_fkey;
alter table promotions add constraint promotions_tenant_id_applied_by_fkey
  foreign key (tenant_id, applied_by) references employees (tenant_id, id) on delete set null (applied_by);

alter table promotions drop constraint if exists promotions_tenant_id_lifted_by_fkey;
alter table promotions add constraint promotions_tenant_id_lifted_by_fkey
  foreign key (tenant_id, lifted_by) references employees (tenant_id, id) on delete set null (lifted_by);
