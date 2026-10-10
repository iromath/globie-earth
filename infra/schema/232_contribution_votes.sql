-- Globie Earth :: 232 :: the community decides
--
-- 230_species_contributions_approval.sql gave a moderator the power to approve:
-- one row in api.moderators, and a contributed photograph could be moved
-- pending -> approved by hand. That works, but it puts every contribution
-- behind a queue only a moderator can clear, and a queue is where a good
-- photograph goes to wait. This migration lets the crowd clear it instead.
--
-- The rule, and it is deliberately the only rule here:
--
--   * A contribution opens a seven-day voting window when it is submitted.
--   * Any device except the contributor may vote yes or no, once.
--   * Once at least five votes are in:
--       - more than 75% yes  -> approved
--       * more than 75% no   -> rejected
--       * anything between   -> stays open, for a steward or for the clock.
--
-- The two guards around the 75% line matter as much as the line itself. A bare
-- "75% of the votes so far" would approve a photograph on a single yes vote,
-- and a 3-2 split would swing on whichever vote arrived last; requiring a
-- quorum of five and refusing to decide a near-split is what makes the outcome
-- mean anything. A window that never closes would leave a two-vote contribution
-- pending forever, so it closes after seven days and a steward settles it - the
-- 230 path, unchanged.
--
-- The reward, and it is the reason a stranger bothers to vote at all:
--
--   * The contributor is paid 300 eco-tokens when the crowd approves their
--     photograph, and nothing when it is refused.
--   * Every voter on the winning side is paid 50.
--
-- Points are the same eco-tokens the rest of the app earns (090_starting_
-- grant.sql), written through a new shared helper so a payee who has never
-- earned before is still given the opening grant - the exact bug 090 exists to
-- prevent.
--
-- Recording the vote, moving the tally, deciding and paying are one SECURITY
-- DEFINER call, and they have to be one transaction: two voters arriving
-- together must not both decide on the tally they each saw. It has to be
-- DEFINER for a second reason - api.award_eco_tokens() can only ever pay the
-- caller (it resolves private.device_id()), and this must pay other devices.
--
-- Depends on 231_contribution_organs.sql: the review view selects the `photos`
-- and `organs` columns 231 adds. Apply 231 first.

-- ------------------------------------------------------- the running score --

alter table api.species_contributions
  -- Running tallies, kept on the row so the species page and the review queue
  -- read the score without a join and without exposing who voted.
  add column if not exists vote_up integer not null default 0,
  add column if not exists vote_down integer not null default 0,
  -- When the crowd's chance to decide runs out. Set at submission, so an
  -- untouched contribution cannot stay pending forever.
  add column if not exists voting_closes_at timestamptz not null
    default now() + interval '7 days',
  -- Who decided: a moderator by hand (230) or the crowd (this file). NULL while
  -- pending.
  add column if not exists review_source text
    check (review_source in ('moderator','community')),
  add column if not exists decided_at timestamptz,
  -- When the rewards for a community decision were paid. The idempotency guard:
  -- a decision is paid once, however the RPC is replayed.
  add column if not exists points_paid_at timestamptz;

comment on column api.species_contributions.vote_up is
  'Running count of yes votes in the community review, kept on the row so the score needs no join.';
comment on column api.species_contributions.vote_down is
  'Running count of no votes in the community review.';
comment on column api.species_contributions.voting_closes_at is
  'When the community vote stops deciding on its own; a near-split past this point is a steward''s call (230).';
comment on column api.species_contributions.review_source is
  'How the row was decided: moderator (230, by hand) or community (this file''s vote). NULL while pending.';
comment on column api.species_contributions.decided_at is
  'When the decision was taken, whether by a moderator or the crowd.';
comment on column api.species_contributions.points_paid_at is
  'When the rewards for a community decision were paid. Stamped once; the guard against paying twice.';

-- Rows a moderator already settled predate review_source. Record the truth
-- rather than leaving it NULL on a row that is not pending: both the queue and
-- the species page read "decided, and by whom".
update api.species_contributions
   set review_source = 'moderator',
       decided_at    = coalesce(reviewed_at, updated_at)
 where status <> 'pending'
   and review_source is null;

-- ---------------------------------------------------------- the votes ------

create table if not exists api.contribution_votes (
  id              uuid primary key default gen_random_uuid(),
  contribution_id uuid not null
                  references api.species_contributions(id) on delete cascade,
  device_id       uuid not null references api.devices(id) on delete cascade,
  vote            boolean not null,
  created_at      timestamptz not null default now(),
  -- One device, one vote, ever. This is the whole "you cannot vote twice"
  -- guarantee: the RPC does not have to test for it, the index refuses it.
  unique (contribution_id, device_id)
);

comment on table api.contribution_votes is
  'One row per device per contributed photograph: the crowd''s verdict on it. Written only by api.cast_contribution_vote(); a device may read its own vote and nothing else.';

alter table api.contribution_votes enable row level security;

-- 010_bootstrap.sql granted anon insert, update and delete on every new api
-- table by default. A vote is cast through the RPC (SECURITY DEFINER, so it
-- bypasses these policies), never by a direct table write, so the three are
-- taken back. The default select stays, narrowed below to the caller's own row.
revoke insert, update, delete on api.contribution_votes from anon;

drop policy if exists contribution_votes_self_select on api.contribution_votes;
create policy contribution_votes_self_select on api.contribution_votes
  for select to anon using (device_id = private.device_id());

-- ---------------------------------------------------- the public queue -----

-- The review queue, for devices that are not moderators. A pending row has to
-- be readable by anyone who might vote on it, but the base table's row policy
-- cannot hide a single column: granting select on api.species_contributions
-- would expose device_id - who submitted it - to the whole world. A view
-- selects the fields a voter needs and nothing else, so the submitter stays
-- private.
--
-- The view is owned by the migration role, whose own rows are not filtered by
-- these tables' policies (they are not FORCE ROW LEVEL SECURITY), so the view
-- really does read the whole queue - which is the point of a queue.
create or replace view api.review_queue as
select
  c.id,
  c.species_type,
  c.species_id,
  c.species_name,
  c.photo_url,
  c.photos,
  c.organs,
  c.ai_subject,
  c.vote_up,
  c.vote_down,
  c.created_at,
  c.voting_closes_at
from api.species_contributions c
where c.status = 'pending';

comment on view api.review_queue is
  'Pending contributions as a voter sees them: the photo(s), the species, the tally and the closing time - never the submitter. Backed by api.species_contributions; a view rather than a row policy because RLS cannot hide one column of a row.';

-- The view is the only way it is reached. Writes are taken back outright: a
-- view is auto-updatable, and left granted, a default-privilege UPDATE would
-- run as the owner and rewrite the base row behind the vote RPC's back.
revoke all on api.review_queue from anon;
grant select on api.review_queue to anon;

-- ------------------------------------------------- paying any device -------
--
-- 090_starting_grant.sql made api.award_eco_tokens create the balance row on
-- the opening grant. That function resolves its payee from the request
-- (private.device_id()), so it can only ever pay the caller - exactly right for
-- an award the device earns itself, exactly wrong for a payout owed to somebody
-- else. This is the same body with the payee passed in, so there is still one
-- place that credits an eco-token balance; api.award_eco_tokens is re-stated
-- below to call it rather than repeat it.
create or replace function private.credit_eco_tokens(
  p_device      uuid,
  p_account     uuid,
  p_delta       integer,
  p_reason      text,
  p_source_type text default null,
  p_source_id   text default null
) returns api.eco_token_balance
language plpgsql
security definer
set search_path = api, public
as $$
declare
  -- Must equal INITIAL_ECO_TOKENS in src/App.tsx, as in 090.
  v_grant   constant integer := 1010;
  v_created api.eco_token_balance;
  v_balance api.eco_token_balance;
begin
  if p_device is null then
    raise exception 'An eco-token credit needs a device' using errcode = '22004';
  end if;

  insert into api.devices (id) values (p_device) on conflict (id) do nothing;
  if p_account is not null then
    insert into api.users (id) values (p_account) on conflict (id) do nothing;
  end if;

  -- A new row opens on the grant, so a device whose first ever credit is a vote
  -- payout is not quietly denied the opening figure - the bug 090 fixed.
  insert into api.eco_token_balance (device_id, user_id, balance)
  values (p_device, p_account, v_grant)
  on conflict (device_id) do nothing
  returning * into v_created;

  if v_created.device_id is not null then
    insert into api.eco_token_ledger (
      device_id, user_id, delta, balance_after, reason, source_type, source_id
    ) values (
      p_device, p_account, v_grant, v_grant, 'welcome', 'welcome', null
    );
  end if;

  update api.eco_token_balance b
     set balance    = b.balance + p_delta,
         user_id    = coalesce(b.user_id, p_account),
         updated_at = now()
   where b.device_id = p_device
  returning * into v_balance;

  if v_balance.balance < 0 then
    raise exception 'Insufficient eco-token balance' using errcode = '23514';
  end if;

  insert into api.eco_token_ledger (
    device_id, user_id, delta, balance_after, reason, source_type, source_id
  ) values (
    p_device, coalesce(v_balance.user_id, p_account), p_delta, v_balance.balance,
    p_reason, p_source_type, p_source_id
  );

  return v_balance;
end;
$$;

comment on function private.credit_eco_tokens(uuid, uuid, integer, text, text, text) is
  'Credits any device''s eco-token balance, creating it on the opening grant first. The shared body of api.award_eco_tokens() and of the community vote payout.';

-- The public award keeps its shape and its behaviour: resolve the caller, then
-- credit them through the shared body.
create or replace function api.award_eco_tokens(
  p_delta       integer,
  p_reason      text,
  p_source_type text default null,
  p_source_id   text default null
) returns api.eco_token_balance
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device uuid := private.device_id();
begin
  if v_device is null then
    raise exception 'Missing or invalid X-Device-Id header' using errcode = '28000';
  end if;
  return private.credit_eco_tokens(
    v_device, private.user_id(), p_delta, p_reason, p_source_type, p_source_id
  );
end;
$$;

grant execute on function api.award_eco_tokens(integer, text, text, text) to anon;

-- -------------------------------------------------------- the vote itself --

create or replace function api.cast_contribution_vote(
  p_contribution uuid,
  p_vote         boolean
) returns jsonb
language plpgsql
security definer
set search_path = api, public
as $$
declare
  -- The decision rule, in one place.
  c_quorum             constant integer := 5;
  c_contributor_reward constant integer := 300;
  c_voter_reward       constant integer := 50;
  v_device uuid := private.device_id();
  v_row    api.species_contributions;
  v_vote   api.contribution_votes;
  v_total  integer;
begin
  if v_device is null then
    raise exception 'Missing or invalid X-Device-Id header' using errcode = '28000';
  end if;

  -- Lock the row before reading the tally. Two voters arriving together must
  -- not both decide on the score each saw; the second waits here and then reads
  -- the first one's tally.
  select * into v_row
    from api.species_contributions
   where id = p_contribution
   for update;

  if v_row.id is null then
    raise exception 'No such contribution' using errcode = 'P0002';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'This contribution has already been decided' using errcode = '23514';
  end if;
  if v_row.voting_closes_at is not null and now() >= v_row.voting_closes_at then
    raise exception 'Voting has closed for this contribution' using errcode = '23514';
  end if;
  if v_row.device_id = v_device then
    raise exception 'The contributor cannot vote on their own photograph' using errcode = '23514';
  end if;

  -- The voting device must exist before the vote can reference it.
  insert into api.devices (id) values (v_device) on conflict (id) do nothing;

  begin
    insert into api.contribution_votes (contribution_id, device_id, vote)
    values (p_contribution, v_device, p_vote);
  exception
    when unique_violation then
      raise exception 'This device has already voted on this contribution' using errcode = '23505';
  end;

  update api.species_contributions s
     set vote_up   = s.vote_up   + case when p_vote then 1 else 0 end,
         vote_down = s.vote_down + case when p_vote then 0 else 1 end
   where s.id = p_contribution
  returning * into v_row;

  -- Decide, but only on a clear enough crowd. `* 4 > total * 3` is "> 75%",
  -- in integers so nothing rounds a 3-2 into a decision.
  v_total := v_row.vote_up + v_row.vote_down;
  if v_total >= c_quorum and v_row.vote_up * 4 > v_total * 3 then
    update api.species_contributions
       set status = 'approved', review_source = 'community', decided_at = now()
     where id = p_contribution
    returning * into v_row;
  elsif v_total >= c_quorum and v_row.vote_down * 4 > v_total * 3 then
    update api.species_contributions
       set status = 'rejected', review_source = 'community', decided_at = now()
     where id = p_contribution
    returning * into v_row;
  end if;

  -- Pay, once, in the same transaction that decided. points_paid_at is the
  -- guard: a replayed call, or the next voter who finds the row already
  -- decided, pays nothing again.
  if v_row.status <> 'pending' and v_row.points_paid_at is null then
    if v_row.status = 'approved' then
      perform private.credit_eco_tokens(
        v_row.device_id, null, c_contributor_reward,
        'contribution_accepted', 'contribution', p_contribution::text
      );
    end if;

    -- A correct vote is a vote on the side that carried: yes on an approval,
    -- no on a refusal.
    for v_vote in
      select *
        from api.contribution_votes
       where contribution_id = p_contribution
         and vote = (v_row.status = 'approved')
    loop
      perform private.credit_eco_tokens(
        v_vote.device_id, null, c_voter_reward,
        'contribution_vote', 'contribution', p_contribution::text
      );
    end loop;

    update api.species_contributions
       set points_paid_at = now()
     where id = p_contribution
    returning * into v_row;
  end if;

  -- Only the fields a voter may see. The row itself carries device_id - who
  -- submitted it - and that does not leave this function.
  return jsonb_build_object(
    'id',               v_row.id,
    'status',           v_row.status,
    'vote_up',          v_row.vote_up,
    'vote_down',        v_row.vote_down,
    'votes_required',   c_quorum,
    'decided_at',       v_row.decided_at,
    'voting_closes_at', v_row.voting_closes_at
  );
end;
$$;

comment on function api.cast_contribution_vote(uuid, boolean) is
  'Records one device''s yes/no vote on a pending contribution, then decides and pays when a quorum of 5 has formed and the split is clear (>75% one way). One call, one transaction; the caller cannot be the contributor and cannot vote twice.';

grant execute on function api.cast_contribution_vote(uuid, boolean) to anon;

-- A new table, a new view and a new function are all invisible to PostgREST
-- until it is told to re-read the schema.
notify pgrst, 'reload schema';
