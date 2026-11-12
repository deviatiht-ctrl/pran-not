-- =====================================================================
-- PRAN NÒT - 08_live_enhancements.sql
-- 1. Tab pou transfè nòt an dirèk ant etidyan sou sit la (kod 6 karaktè)
-- 2. Ogmante quota IA chak jou a 500 pou etidyan yo pa bloke pandan kou
-- 3. Ajoute sesyon kou (started_at, ended_at, duration_seconds) sou nòt yo
-- =====================================================================

-- 1. Transfè nòt an dirèk sou sit la
create table if not exists public.pran_not_live_transfers (
  id              uuid primary key default gen_random_uuid(),
  code            text not null,
  sender_id       uuid not null references auth.users(id) on delete cascade,
  sender_name     text,
  note_id         uuid references public.pran_not_notes(id) on delete cascade,
  note_title      text not null,
  note_payload    jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'claimed', 'expired')),
  claimed_by      uuid references auth.users(id) on delete set null,
  claimed_at      timestamptz,
  expires_at      timestamptz not null default (now() + interval '30 minutes'),
  created_at      timestamptz not null default now()
);

create index if not exists pran_not_live_transfers_code_idx
  on public.pran_not_live_transfers(code)
  where status = 'pending';

create index if not exists pran_not_live_transfers_sender_idx
  on public.pran_not_live_transfers(sender_id);

-- RLS pou transfè nòt
alter table public.pran_not_live_transfers enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'pran_not_live_transfers' and policyname = 'pran_not_live_transfers_select'
  ) then
    create policy pran_not_live_transfers_select on public.pran_not_live_transfers
      for select using (auth.uid() is not null);
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'pran_not_live_transfers' and policyname = 'pran_not_live_transfers_insert'
  ) then
    create policy pran_not_live_transfers_insert on public.pran_not_live_transfers
      for insert with check (auth.uid() = sender_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'pran_not_live_transfers' and policyname = 'pran_not_live_transfers_update'
  ) then
    create policy pran_not_live_transfers_update on public.pran_not_live_transfers
      for update using (auth.uid() is not null);
  end if;
end;
$$;

-- 2. Ogmante quota IA pou etidyan yo pa bloke pandan kou
alter table public.pran_not_profiles
  alter column ai_daily_quota set default 500;

update public.pran_not_profiles
  set ai_daily_quota = greatest(coalesce(ai_daily_quota, 0), 500);

-- 3. Kolòn sesyon kou sou nòt yo pou pèmèt revizyon egzamen pa peryòd dat
alter table public.pran_not_notes
  add column if not exists live_started_at timestamptz,
  add column if not exists live_ended_at timestamptz,
  add column if not exists live_duration_seconds int;

create index if not exists pran_not_notes_live_dates_idx
  on public.pran_not_notes(user_id, live_started_at);
