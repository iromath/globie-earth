-- Globie Earth :: 259 :: The wardrobe - the first way to spend a token
--
-- 256 gave the games a ledger and 258 gave both wallets one total. Every row in
-- it was a credit, so the number only ever went up: a scoreboard, not a
-- currency. This file adds the first debit.
--
-- What it buys is a mascot skin. All three already ship - Yang Na is the
-- default, Kae Na and Mother Tree are drawn, named and rendered elsewhere in
-- the app - so the sink is ownership plus a choice, not new art.
--
-- Three decisions worth naming:
--
--   * A spend is a NEGATIVE row in api.eco_ledger. api.eco_balance() sums the
--     ledger together with api.eco_token_balance, so a debit written here is
--     reflected in the badge, the game tally and the wardrobe from the one
--     definition. A second spend table would have to be subtracted somewhere,
--     which is the drift 258 removed.
--
--   * The price is not the client's to send. api.eco_items holds it and
--     api.eco_spend reads it here; the relay and the television only name the
--     item. A client-priced sink is a sink a modified client can skip.
--
--   * Ownership needs no second table. The ledger row IS the receipt, and
--     (device_id, award_key) already makes a retried purchase debit once -
--     exactly the property api.eco_award has for a retried match.
--
-- 256's amount check was `between 1 and 500`. It is widened here to admit a
-- debit, and api.eco_award is restated with an explicit positive-only guard so
-- the widening does not hand anon a way to write its own negative row.

-- --------------------------------------------------- the ledger may debit ----

alter table api.eco_ledger drop constraint if exists eco_ledger_amount_check;

-- A zero row would be a purchase that cost nothing and an award that paid
-- nothing; both are bugs, so the range excludes it.
alter table api.eco_ledger
  add constraint eco_ledger_amount_check
  check (amount <> 0 and amount between -500 and 500);

-- 258's body, plus the bound the check used to enforce by itself. Without
-- this, `eco_award(key, -500)` would be a debit that skipped api.eco_spend's
-- balance test and its idempotent item key.
create or replace function api.eco_award(p_key text, p_amount integer)
returns table (balance integer, awarded integer)
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device  uuid := private.device_id();
  v_awarded integer := 0;
begin
  if v_device is null then
    raise exception 'the eco wallet needs an X-Device-Id header' using errcode = '28000';
  end if;

  if p_key is null or length(p_key) not between 1 and 120 then
    raise exception 'an award needs a key of 1 to 120 characters' using errcode = '22023';
  end if;

  if p_amount is null or p_amount < 1 or p_amount > 500 then
    raise exception 'an award must be between 1 and 500 eco-tokens' using errcode = '23514';
  end if;

  insert into api.eco_ledger (device_id, award_key, amount)
  values (v_device, p_key, p_amount)
  on conflict (device_id, award_key) do nothing
  returning amount into v_awarded;

  v_awarded := coalesce(v_awarded, 0);

  return query select api.eco_balance(), v_awarded;
end;
$$;

grant execute on function api.eco_award(text, integer) to anon;

-- ------------------------------------------------------------ the catalogue ----

-- No label: the television already owns the three names and the three images
-- (MASCOT_NAME / MASCOT_SOURCE in MascotStage.tsx), and copying them here
-- would give the product two sources of truth for one word.
create table if not exists api.eco_items (
  item_key      text primary key check (item_key ~ '^[a-z0-9-]{1,40}$'),
  -- What one purchase costs. 0 is reserved for what every viewer starts with.
  price         integer not null check (price between 0 and 500),
  default_owned boolean not null default false,
  sort_order    smallint not null default 0
);

comment on table api.eco_items is
  'The priced catalogue behind the wardrobe. The price is read by api.eco_spend, never sent by a client.';

alter table api.eco_items enable row level security;

drop policy if exists eco_items_read on api.eco_items;
create policy eco_items_read on api.eco_items
  for select to anon using (true);

revoke insert, update, delete on api.eco_items from anon;
grant select on api.eco_items to anon;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete on api.eco_items from authenticated';
  end if;
end;
$$;

-- Yang Na is the default, so the panel can say "Included" without a special
-- case in the client. Prices: 80 is under three six-pair Memory sessions (30
-- each), 240 is a commitment of about eight; both are payable from the 1010
-- welcome grant, so no household is locked out.
insert into api.eco_items as i (item_key, price, default_owned, sort_order)
values
  ('yang-na',     0,   true,  0),
  ('kae-na',      80,  false, 1),
  ('mother-tree', 240, false, 2)
on conflict (item_key) do update set
  price         = excluded.price,
  default_owned = excluded.default_owned,
  sort_order    = excluded.sort_order;

-- --------------------------------------------------------------- the spend ----

-- One item, priced here, debited once, refused when unaffordable.
--
-- The advisory lock is per device and lasts the transaction: two concurrent
-- purchases from the same television cannot both read the same balance and
-- both write a debit. It is released on commit or on the raise below.
--
-- Returns the total after the call. `spent` is 0 for a replay or for an item
-- the viewer already starts with, so a double tap answers the same number as
-- the first tap and never claims a second charge.
create or replace function api.eco_spend(p_item text)
returns table (balance integer, spent integer, owned boolean)
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device  uuid := private.device_id();
  v_price   integer;
  v_default boolean;
  v_key     text;
  v_spent   integer := 0;
  v_owned   boolean := false;
begin
  if v_device is null then
    raise exception 'the eco wallet needs an X-Device-Id header' using errcode = '28000';
  end if;

  select i.price, i.default_owned
    into v_price, v_default
    from api.eco_items i
   where i.item_key = p_item;

  -- P0002 is the "not there" the challenge routes already answer with.
  if v_price is null then
    raise exception 'unknown wardrobe item %', p_item using errcode = 'P0002';
  end if;

  v_key := 'wardrobe:' || p_item;

  perform pg_advisory_xact_lock(hashtextextended(v_device::text, 0));

  if v_default or exists (
    select 1
      from api.eco_ledger l
     where l.device_id = v_device
       and l.award_key = v_key
  ) then
    v_owned := true;
  elsif api.eco_balance() < v_price then
    -- 23514 is what private.credit_eco_tokens already raises for an overdraft,
    -- so the relay has one code to recognise for "you cannot afford this".
    raise exception 'not enough eco-tokens for %', p_item using errcode = '23514';
  else
    insert into api.eco_ledger (device_id, award_key, amount)
    values (v_device, v_key, -v_price);

    v_spent := v_price;
    v_owned := true;
  end if;

  return query select api.eco_balance(), v_spent, v_owned;
end;
$$;

revoke execute on function api.eco_spend(text) from public;
grant execute on function api.eco_spend(text) to anon;

-- -------------------------------------------------------------- the wardrobe ----

-- One read for the panel: the total it can spend, and every item with its price
-- and whether this device owns it. Default items are owned without a ledger
-- row, which is why `default_owned or exists(...)` is the whole rule.
create or replace function api.eco_wardrobe()
returns jsonb
language plpgsql
stable
security definer
set search_path = api, public
as $$
declare
  v_device uuid := private.device_id();
begin
  if v_device is null then
    raise exception 'the eco wallet needs an X-Device-Id header' using errcode = '28000';
  end if;

  return jsonb_build_object(
    'balance', api.eco_balance(),
    'items', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'itemKey', i.item_key,
                 'price',   i.price,
                 'owned',   i.default_owned or exists (
                   select 1
                     from api.eco_ledger l
                    where l.device_id = v_device
                      and l.award_key = 'wardrobe:' || i.item_key
                 )
               )
               order by i.sort_order
             )
        from api.eco_items i
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function api.eco_wardrobe() from public;
grant execute on function api.eco_wardrobe() to anon;

-- PostgREST caches the schema and this file is applied by hand, so ask it to
-- re-read or the first call answers PGRST202.
notify pgrst, 'reload schema';
