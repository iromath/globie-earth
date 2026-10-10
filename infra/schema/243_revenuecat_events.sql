-- Globie Earth :: 243 :: the RevenueCat event ledger and the reconciliation view
--
-- Until now there was no server-side record of a payment at all. The store
-- (Google Play, Stripe, via RevenueCat) was the only source of truth, and this
-- database held just a copy of the transaction id the client happened to send
-- to api.create_adoption. Four consequences were accepted knowingly:
--
--   1. user_id is stamped only when the caller is signed in, so a row written
--      before 080 - or by a device-only caller - can never be attributed to an
--      account after the fact: a device is not a user, and there was no second
--      witness to a purchase.
--   3. the product -> species map lives only in src/lib/revenuecat.ts, so the
--      server cannot say which tree a payment was meant to buy.
--   4. nothing validates a purchase server-side, so a client that never calls
--      create_adoption leaves no trace anywhere.
--   7. adoptions.status allows 'refunded' but no code path ever sets it, so a
--      refund is invisible.
--
-- This file adds the missing witness. RevenueCat posts every event to the
-- `revenuecat` service (infra/revenuecat), which appends it here verbatim and
-- answers 200. The ledger is the server's own copy of the store's truth; the
-- view below joins it to the trees the app minted and names every row that does
-- not reconcile.
--
-- It does NOT mint anything. A web-billing appUserID is the account id, not a
-- device id, so there is no X-Device-Id to derive and api.create_adoption
-- cannot be replayed as the server; and minting from a second source is exactly
-- the double-mint this ledger exists to detect. The ledger records, the view
-- reports, a human decides. See the header of infra/revenuecat/src/server.ts.
--
-- Additive and idempotent. Apply it to a live database by hand - the `db`
-- service only runs /docker-entrypoint-initdb.d on the first init of an empty
-- volume, so a running stack needs this run against it once:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f infra/schema/243_revenuecat_events.sql
--
-- Depends on 070 (api.users, the user_id columns) and 080 (the create_adoption
-- body that stamps them).

-- ------------------------------------------------------------ the ledger ----

create table if not exists api.rc_events (
  -- event.id, RevenueCat's own id for the event. The primary key is what makes
  -- a retried delivery idempotent: RevenueCat re-sends with the same id and the
  -- same event_timestamp_ms, so the insert is `on conflict do nothing`.
  event_id                text primary key,
  type                    text not null,
  app_user_id             text,
  original_app_user_id    text,
  aliases                 text[] not null default '{}',
  product_id              text,
  transaction_id          text,
  original_transaction_id text,
  store                   text,
  environment             text,
  period_type             text,
  currency                text,
  price                   numeric(12,4),
  cancel_reason           text,
  entitlement_ids         text[] not null default '{}',
  country_code            text,
  event_timestamp_ms      bigint,
  purchased_at_ms         bigint,
  expiration_at_ms        bigint,
  -- The whole event object, so nothing RevenueCat adds later is lost to a
  -- column that does not exist yet. Every named column above is a convenience
  -- index into this, not a replacement for it.
  raw                     jsonb not null,
  received_at             timestamptz not null default now()
);

comment on table api.rc_events is
  'Append-only ledger of RevenueCat webhook events, one row per event.id. The server''s own copy of the store''s truth; written only by the `revenuecat` service (migration role). Never exposed to a device: a single row names a customer''s payment, so per-row access would be a leak, not a feature. See private.payment_reconciliation.';

comment on column api.rc_events.event_id is
  'RevenueCat event.id. The primary key, and the idempotency key for a retried delivery.';
comment on column api.rc_events.app_user_id is
  'RevenueCat appUserID: a device id for the app, or an api.users.id under web billing. The join back to a steward.';
comment on column api.rc_events.transaction_id is
  'The store transaction id, the same value api.adoptions.rc_transaction_id copies. The join key for reconciliation.';

create index if not exists rc_events_transaction_idx
  on api.rc_events (transaction_id) where transaction_id is not null;
create index if not exists rc_events_app_user_idx
  on api.rc_events (app_user_id) where app_user_id is not null;
create index if not exists rc_events_type_idx
  on api.rc_events (type, received_at desc);

-- The ledger spans every customer, so no device may read it. RLS with no policy
-- denies every non-owner row, and the revoke removes the table privileges 010's
-- default privileges would otherwise have granted to anon - the same two-lock
-- posture api.embeddings uses in 030_rls.sql. The webhook writes as the
-- migration role, which owns the table and is unaffected by either.
alter table api.rc_events enable row level security;
revoke all on api.rc_events from anon;

-- --------------------------------------------------- reconciliation view ----
--
-- One row per minted asset (an adoption's species, or a guardian pledge),
-- full-outer-joined to the events for its transaction. A payment that minted
-- nothing appears once with the minted columns null; a minted row with no event
-- appears once with the event columns null. `issue` names which gap a row is:
--
--   ok                      the payment and the minted row agree.
--   paid_no_trees           RevenueCat recorded a purchase this database never
--                           turned into a tree (gap 4). Ops mints or refunds.
--   trees_without_event     A tree exists whose transaction has no event in the
--                           ledger - either it predates this file (gap 1/4) or
--                           the webhook is not configured yet.
--   refund_not_reconciled   The transaction has a CANCELLATION event but the
--                           minted row is still active (gap 7).
--   account_unattributed    The event's appUserID is an account, but the minted
--                           row's user_id is null - the payment names its
--                           steward and the row can be attributed (gap 1).
--
-- The view lives in `private`, not `api`, on purpose: PostgREST exposes only
-- the `api` schema, and a view runs with its owner's rights, so an api view
-- would hand every customer's payments to any anon caller - the underlying
-- tables' RLS would not apply. Ops reads it over DATABASE_URL instead:
--
--   select issue, count(*) from private.payment_reconciliation group by 1;

create or replace view private.payment_reconciliation as
with events as (
  -- One row per transaction. A transaction can carry several events over its
  -- life (INITIAL_PURCHASE, RENEWAL, CANCELLATION, ...), so they collapse to
  -- the latest event's shape plus the facts reconciliation needs: was this ever
  -- paid, and was it ever cancelled or refunded.
  select
    e.transaction_id,
    (array_agg(e.type     order by e.event_timestamp_ms desc nulls last, e.received_at desc))[1] as last_event_type,
    (array_agg(e.product_id order by e.event_timestamp_ms desc nulls last, e.received_at desc))[1] as product_id,
    (array_agg(e.store    order by e.event_timestamp_ms desc nulls last, e.received_at desc))[1] as store,
    (array_agg(e.environment order by e.event_timestamp_ms desc nulls last, e.received_at desc))[1] as environment,
    (array_agg(e.app_user_id order by e.event_timestamp_ms desc nulls last, e.received_at desc))[1] as app_user_id,
    min(e.purchased_at_ms)                                                                  as purchased_at_ms,
    bool_or(e.type = 'CANCELLATION')                                                        as has_refund,
    count(*)                                                                                as event_count,
    min(e.received_at)                                                                      as first_received_at,
    max(e.received_at)                                                                      as last_received_at
  from api.rc_events e
  where e.transaction_id is not null
  group by e.transaction_id
),
minted as (
  -- Every row the app turned a transaction into, adoptions and guardian
  -- pledges alike, in one shape so the join below has a single right-hand side.
  select
    a.rc_transaction_id as transaction_id,
    'adoption'::text    as source,
    a.id                as adoption_id,
    a.species_id        as species_id,
    null::text          as guardian_id,
    a.device_id         as device_id,
    a.user_id           as user_id,
    a.rc_product_id     as product_id,
    a.pledge_thb        as pledge_thb,
    a.status            as minted_status,
    a.adopted_at        as minted_at,
    d.deed_no           as deed_no,
    d.trees_planted     as trees_planted
  from api.adoptions a
  left join api.living_deeds d on d.adoption_id = a.id
  where a.rc_transaction_id is not null

  union all

  select
    p.rc_transaction_id,
    'guardian_pledge',
    null,
    null,
    p.guardian_id,
    p.device_id,
    p.user_id,
    p.rc_product_id,
    null,
    p.status,
    p.pledged_at,
    null,
    null
  from api.guardian_pledges p
  where p.rc_transaction_id is not null
)
select
  coalesce(m.transaction_id, e.transaction_id)      as transaction_id,
  m.source                                          as source,
  m.species_id                                      as species_id,
  m.guardian_id                                     as guardian_id,
  m.product_id                                      as product_id,
  e.product_id                                      as event_product_id,
  m.adoption_id                                     as adoption_id,
  m.deed_no                                         as deed_no,
  m.trees_planted                                   as trees_planted,
  m.pledge_thb                                      as pledge_thb,
  m.device_id                                       as device_id,
  m.user_id                                         as user_id,
  coalesce(m.user_id::text, m.device_id::text)      as steward,
  e.app_user_id                                     as app_user_id,
  e.last_event_type                                 as last_event_type,
  e.store                                           as store,
  e.environment                                     as environment,
  e.event_count                                     as event_count,
  to_timestamp((e.purchased_at_ms::double precision) / 1000.0) as paid_at,
  m.minted_status                                   as minted_status,
  m.minted_at                                       as minted_at,
  e.first_received_at                               as event_first_received_at,
  e.last_received_at                                as event_last_received_at,
  case
    when m.transaction_id is null then 'paid_no_trees'
    when e.transaction_id is null then 'trees_without_event'
    when e.has_refund and m.minted_status <> 'refunded' then 'refund_not_reconciled'
    when m.user_id is null
         and e.app_user_id is not null
         and exists (select 1 from api.users u where u.id::text = e.app_user_id)
      then 'account_unattributed'
    else 'ok'
  end                                               as issue
from minted m
full outer join events e on e.transaction_id = m.transaction_id;

comment on view private.payment_reconciliation is
  'Every payment joined to the trees it minted, or not. `issue` labels the gaps: paid_no_trees, trees_without_event, refund_not_reconciled, account_unattributed. Lives in `private` so PostgREST never serves it; read it over DATABASE_URL.';

notify pgrst, 'reload schema';
