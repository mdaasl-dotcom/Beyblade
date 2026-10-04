-- Spin Battle Tracker — license key system
-- Run this once in your Supabase project's SQL Editor (Dashboard -> SQL Editor -> New query).

create table if not exists licenses (
  key text primary key,
  claimed boolean not null default false,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table licenses enable row level security;
-- Deliberately no direct select/insert/update policies for the public (anon)
-- role — every interaction goes through the two SECURITY DEFINER functions
-- below, so a buyer can never list keys, forge their own, or un-claim one.

-- Hands out the next unclaimed key (called once, right after a Stripe
-- payment succeeds, from claim.html). `for update skip locked` makes this
-- safe even if two buyers claim at the exact same moment — they can't both
-- walk away with the same key.
create or replace function claim_license()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_key text;
begin
  select key into claimed_key
  from licenses
  where claimed = false
  order by created_at
  limit 1
  for update skip locked;

  if claimed_key is null then
    raise exception 'No licenses available';
  end if;

  update licenses set claimed = true, claimed_at = now() where key = claimed_key;
  return claimed_key;
end;
$$;

-- Checks whether a key a visitor typed into the app is a real, already-
-- claimed license. Used every time the app's login gate needs to verify one.
create or replace function verify_license(input_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists(select 1 from licenses where key = input_key and claimed = true);
end;
$$;

-- The anon key (public, used by the deployed app) may only ever call these
-- two functions — never read/write the table directly.
grant execute on function claim_license() to anon;
grant execute on function verify_license(text) to anon;

-- Seeds 100 sellable keys, formatted like BEY-A1B2-C3D4. Re-run this insert
-- (or bump the 100) any time you want to top up the pool — it only ever
-- adds new rows, it won't touch existing ones.
insert into licenses (key)
select 'BEY-' || upper(substr(md5(random()::text || clock_timestamp()::text || i), 1, 4))
     || '-' || upper(substr(md5(random()::text || clock_timestamp()::text || i || 'b'), 1, 4))
from generate_series(1, 100) as i;

-- Your own permanent free key as the app's owner — pre-claimed so it works
-- immediately, and never counted against (or pulled from) the sellable pool
-- above. Keep this string private; anyone who has it gets free access.
insert into licenses (key, claimed, claimed_at)
values ('BEY-OWNER-FREE-ACCESS', true, now())
on conflict (key) do nothing;
