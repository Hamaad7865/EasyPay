-- 0027_seed_vat_included.sql — owner decision: menu prices INCLUDE VAT.
-- Seed VAT is type 'included' (was 'added'). Replaces the 0005 definition;
-- 0005 untouched. Existing rows keep their type (per-tenant edit in back
-- office); only new seeds change. Never edit after merge.
-- from the design prototype (idea-level): 8 categories, 43 items (Rs -> cents),
-- modifier sets, VAT 15%, dining options, MU payment types, 4 discounts.
-- SECURITY DEFINER (owner bypasses RLS by design); the API allows only
-- Owner/Manager employees to call it. Guarded: refuses if catalog exists.
-- Known approximations, all editable in back office (Phase 1/5):
--   live stock counts (prototype 'X left') arrive with inventory (Phase 9);
--     only Calamars frits (stock 0) seeds as unavailable.
--   every item links to VAT; zero-rated/exempt flags are a back-office edit.
--   Happy-hour category scope (drinks+bar) has no schema home yet (Phase 5 rules).
-- Never edit after merge.

create or replace function seed_demo_catalog(p_tenant_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  n_cat int; n_items int; n_groups int; n_mods int;
begin
  if exists (select 1 from categories where tenant_id = p_tenant_id and deleted_at is null) then
    return jsonb_build_object('seeded', false, 'reason', 'catalog exists');
  end if;

  create temp table _c(key text, label text, hue int, ord int) on commit drop;
  insert into _c values
    ('starters','Starters',60,0), ('street','Street food',35,1),
    ('mains','Curries & mains',25,2), ('rice','Rice & noodles',140,3),
    ('seafood','Grill & seafood',220,4), ('desserts','Desserts',340,5),
    ('drinks','Drinks',190,6), ('bar','Bar',290,7);
  insert into categories (tenant_id, name, color, sort_order)
    select p_tenant_id, label, 'oklch(0.65 0.13 ' || hue || ')', ord from _c;

  create temp table _i(key text, name text, cat text, price_c bigint, avail boolean, id uuid) on commit drop;
  insert into _i (key, name, cat, price_c, avail) values
    ('gp','Gateaux piments (6)','Starters',9500,true), ('sam','Samoussa (6)','Starters',11000,true),
    ('pal','Salade de palmiste','Starters',29000,true), ('soup','Soupe de crabe','Starters',26000,true),
    ('crev','Crevettes sautées à l''ail','Starters',35000,true),
    ('dp','Dholl puri','Street food',5000,true), ('far','Farata rougaille','Street food',8500,true),
    ('mb','Mine bouillie','Street food',9000,true), ('arr','Gato arouille (6)','Street food',8000,true),
    ('cp','Cari poulet','Curries & mains',38000,true), ('rs','Rougaille saucisse','Curries & mains',32000,true),
    ('cou','Cari ourite','Curries & mains',45000,true), ('vin','Vindaye de poisson','Curries & mains',42000,true),
    ('bp','Briyani poulet','Curries & mains',42000,true), ('bm','Briyani mouton','Curries & mains',48000,true),
    ('sf','Steak frites','Curries & mains',59000,true), ('mag','Magret de canard','Curries & mains',72000,true),
    ('mf','Mine frire poulet','Rice & noodles',28000,true), ('rfc','Riz frit crevettes','Rice & noodles',31000,true),
    ('br','Bol renversé','Rice & noodles',34000,true), ('sv','Sauté de légumes','Rice & noodles',24000,true),
    ('pas','Porc aigre-doux','Rice & noodles',36000,true),
    ('pg','Poisson grillé (capitaine)','Grill & seafood',65000,true), ('cam','Camarons grillés','Grill & seafood',78000,true),
    ('lang','Langouste grillée','Grill & seafood',145000,true), ('cal','Calamars frits','Grill & seafood',42000,false),
    ('gpat','Gâteau patate','Desserts',14000,true), ('cb','Crème brûlée vanille','Desserts',22000,true),
    ('sfr','Salade de fruits','Desserts',16000,true), ('gc','Glace coco','Desserts',15000,true),
    ('nap','Napolitaine','Desserts',7000,true),
    ('alo','Alouda','Drinks',9000,true), ('the','Thé vanille','Drinks',8000,true),
    ('eau','Eau Cristal 50cl','Drinks',4000,true), ('coke','Coca-Cola','Drinks',6000,true),
    ('ana','Jus d''ananas','Drinks',11000,true), ('las','Lassi','Drinks',12000,true),
    ('pho','Phoenix 330ml','Bar',16000,true), ('tpu','Ti punch','Bar',30000,true),
    ('ra','Rhum arrangé','Bar',26000,true), ('pc','Piña colada','Bar',38000,true),
    ('gt','Gin tonic','Bar',34000,true), ('vr','Vin rouge (verre)','Bar',28000,true);
  update _i set id = gen_random_uuid();
  insert into items (id, tenant_id, category_id, name, price, is_available)
    select i.id, p_tenant_id, c.id, i.name, i.price_c, i.avail
    from _i i join categories c on c.tenant_id = p_tenant_id and c.name = i.cat;

  create temp table _g(name text, min_s int, max_s int) on commit drop;
  insert into _g values
    ('Curry spice',1,1), ('Curry add-ons',0,3),
    ('Street spice',1,1), ('Street add-ons',0,3),
    ('Wok spice',1,1), ('Wok add-ons',0,3),
    ('Cooking',1,1), ('Side',0,1), ('Fish side',0,1),
    ('Ice',0,1), ('Measure',1,1);
  insert into modifier_groups (tenant_id, name, min_select, max_select)
    select p_tenant_id, name, min_s, max_s from _g;

  create temp table _o(grp text, name text, price_c bigint) on commit drop;
  insert into _o values
    ('Curry spice','No chili',0), ('Curry spice','Mild',0), ('Curry spice','Medium',0), ('Curry spice','Hot',0),
    ('Curry add-ons','Extra rice',4000), ('Curry add-ons','Extra chutney',2500), ('Curry add-ons','Fried egg',3000),
    ('Street spice','No chili',0), ('Street spice','Mild',0), ('Street spice','Medium',0), ('Street spice','Hot',0),
    ('Street add-ons','Extra rougaille',2500), ('Street add-ons','Extra chutney',1500), ('Street add-ons','Achard',2000),
    ('Wok spice','No chili',0), ('Wok spice','Mild',0), ('Wok spice','Medium',0), ('Wok spice','Hot',0),
    ('Wok add-ons','Fried egg',3000), ('Wok add-ons','Extra chicken',9000), ('Wok add-ons','Extra sauce',2000),
    ('Cooking','Rare',0), ('Cooking','Medium',0), ('Cooking','Well done',0),
    ('Side','Frites',0), ('Side','Légumes sautés',0), ('Side','Riz blanc',0),
    ('Fish side','Riz blanc',0), ('Fish side','Frites',0), ('Fish side','Légumes sautés',0),
    ('Ice','Normal ice',0), ('Ice','Less ice',0), ('Ice','No ice',0),
    ('Measure','Single',0), ('Measure','Double',15000);
  insert into modifiers (tenant_id, group_id, name, price)
    select p_tenant_id, g.id, o.name, o.price_c
    from _o o join modifier_groups g on g.tenant_id = p_tenant_id and g.name = o.grp;

  create temp table _l(ikey text, grp text) on commit drop;
  insert into _l values
    ('cp','Curry spice'), ('cp','Curry add-ons'), ('rs','Curry spice'), ('rs','Curry add-ons'),
    ('cou','Curry spice'), ('cou','Curry add-ons'), ('vin','Curry spice'), ('vin','Curry add-ons'),
    ('bp','Curry spice'), ('bp','Curry add-ons'), ('bm','Curry spice'), ('bm','Curry add-ons'),
    ('dp','Street spice'), ('dp','Street add-ons'), ('far','Street spice'), ('far','Street add-ons'),
    ('mb','Street spice'), ('mb','Street add-ons'), ('arr','Street spice'), ('arr','Street add-ons'),
    ('mf','Wok spice'), ('mf','Wok add-ons'), ('rfc','Wok spice'), ('rfc','Wok add-ons'),
    ('br','Wok spice'), ('br','Wok add-ons'), ('sv','Wok spice'), ('sv','Wok add-ons'),
    ('pas','Wok spice'), ('pas','Wok add-ons'),
    ('sf','Cooking'), ('sf','Side'), ('mag','Cooking'), ('mag','Side'),
    ('pg','Fish side'), ('cam','Fish side'), ('lang','Fish side'),
    ('alo','Ice'), ('ana','Ice'), ('las','Ice'),
    ('tpu','Measure'), ('ra','Measure'), ('gt','Measure');
  insert into item_modifier_groups (tenant_id, item_id, group_id)
    select p_tenant_id, i.id, g.id from _l l
    join _i i on i.key = l.ikey
    join modifier_groups g on g.tenant_id = p_tenant_id and g.name = l.grp;

  insert into taxes (tenant_id, name, rate_bp, type, is_default)
    values (p_tenant_id, 'VAT', 1500, 'included', true);
  insert into item_taxes (tenant_id, item_id, tax_id)
    select p_tenant_id, i.id, t.id from _i i,
      (select id from taxes where tenant_id = p_tenant_id and name = 'VAT') t;

  insert into discounts (tenant_id, name, type, value, requires_approval) values
    (p_tenant_id, 'Happy hour', 'percent', 25, false),
    (p_tenant_id, 'Loyalty member', 'percent', 10, false),
    (p_tenant_id, 'Staff meal', 'percent', 30, true),
    (p_tenant_id, 'Manager goodwill', 'amount', 10000, true);

  insert into dining_options (tenant_id, name, is_default, sort_order) values
    (p_tenant_id, 'Dine-in', true, 0),
    (p_tenant_id, 'Takeaway', false, 1),
    (p_tenant_id, 'Bar tab', false, 2);

  insert into payment_types (tenant_id, name, kind, opens_drawer, sort_order) values
    (p_tenant_id, 'Cash', 'cash', true, 0),
    (p_tenant_id, 'Card', 'card', false, 1),
    (p_tenant_id, 'Juice by MCB', 'wallet', false, 2),
    (p_tenant_id, 'my.t money', 'wallet', false, 3),
    (p_tenant_id, 'Blink', 'wallet', false, 4),
    (p_tenant_id, 'MauCAS QR', 'qr', false, 5),
    (p_tenant_id, 'Bank transfer', 'other', false, 6);

  select count(*) into n_cat from categories where tenant_id = p_tenant_id;
  select count(*) into n_items from items where tenant_id = p_tenant_id;
  select count(*) into n_groups from modifier_groups where tenant_id = p_tenant_id;
  select count(*) into n_mods from modifiers where tenant_id = p_tenant_id;
  return jsonb_build_object('seeded', true, 'categories', n_cat, 'items', n_items,
    'modifier_groups', n_groups, 'modifiers', n_mods);
end $$;
