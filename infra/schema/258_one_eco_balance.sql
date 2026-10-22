-- Globie Earth :: 258 :: One eco-token balance
--
-- 256 gave the games a wallet (api.eco_ledger) and 232 already had one for
-- adoptions (api.eco_token_balance). Both are real, but they are two numbers
-- behind one word: a household that adopts a sapling and then plays Memory saw
-- 100 on the home badge and 30 on the game tally. Neither number was wrong; the
-- product was.
--
-- This migration collapses the read side. api.eco_balance() is now the single
-- definition of "how many eco-tokens does this caller have", and it sums both
-- sources:
--
--   * api.eco_ledger        - what the games paid (api.eco_award)
--   * api.eco_token_balance - the starting grant and what adoptions paid
--                             (private.credit_eco_tokens / api.award_eco_tokens)
--
-- api.eco_award() now returns that same total, so the tally the TV prints after
-- a match cannot disagree with the badge on the home screen. Nothing else
-- changes: the ledger stays append-only, api.eco_award stays idempotent on
-- (device_id, award_key), and no client changes.
--
-- Scope. The game wallet is device-scoped, while the adoption balance is also
-- readable by a signed-in account across its devices (the two RLS policies on
-- api.eco_token_balance). The function keeps that wider scope for the balance
-- rows, and attributes a second device's game rows to the account through the
-- balance row that names its user. A device that has only ever played games has
-- no balance row and is therefore visible only to itself, which is the same
-- privacy the table already gives it.
--
-- Depends on 232 (api.eco_token_balance, api.award_eco_tokens) and 256
-- (api.eco_ledger, api.eco_balance, api.eco_award). Apply those first.

-- --------------------------------------------------------------- balance ----

-- Still `coalesce`d, so a device that has never earned anything reads 0 rather
-- than null. The account branch mirrors the two select policies on
-- api.eco_token_balance; being SECURITY DEFINER, the function has to express
-- that scope itself because RLS does not apply to the function's reads.
create or replace function api.eco_balance()
returns integer
language plpgsql
security definer
set search_path = api, public
as $$
declare
  v_device  uuid := private.device_id();
  v_user    uuid := private.user_id();
  v_balance integer;
begin
  if v_device is null then
    raise exception 'the eco wallet needs an X-Device-Id header' using errcode = '28000';
  end if;

  select coalesce(sum(x.amount), 0)::integer
    into v_balance
    from (
      -- Games. The caller's own device, plus any device already tied to their
      -- account by a balance row - the same rows the badge used to sum.
      select l.amount::bigint as amount
        from api.eco_ledger l
       where l.device_id = v_device
          or (
               v_user is not null
               and exists (
                 select 1
                   from api.eco_token_balance b
                  where b.device_id = l.device_id
                    and b.user_id = v_user
               )
             )
      union all
      -- Adoptions and the opening grant, under the same scope.
      select b.balance::bigint
        from api.eco_token_balance b
       where b.device_id = v_device
          or (v_user is not null and b.user_id = v_user)
    ) x;

  return v_balance;
end;
$$;

grant execute on function api.eco_balance() to anon;

-- ---------------------------------------------------------------- award ----

-- The body is 256's, with one change: the returned `balance` is the combined
-- total. `awarded` stays what this call actually added, so a replay still
-- answers 0 and the balance does not move.
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

  insert into api.eco_ledger (device_id, award_key, amount)
  values (v_device, p_key, p_amount)
  on conflict (device_id, award_key) do nothing
  returning amount into v_awarded;

  v_awarded := coalesce(v_awarded, 0);

  -- Read the total through the one definition rather than repeating its sum
  -- here, so the games and the badge cannot drift apart again.
  return query select api.eco_balance(), v_awarded;
end;
$$;

grant execute on function api.eco_award(text, integer) to anon;

-- PostgREST caches the schema and this file is applied by hand, so ask it to
-- re-read or the first call answers PGRST202.
notify pgrst, 'reload schema';
