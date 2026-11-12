-- =====================================================================
-- PRAN NÒT - 07_live_notifications.sql
-- Migration idempotente pou lè kou yo, rapèl klas an dirèk ak son notifikasyon.
-- Ou ka ekzekite l nan Supabase SQL Editor nenpòt lè san danje.
-- =====================================================================

-- 1. Lè ak rapèl sou kou yo
alter table public.pran_not_courses
  add column if not exists schedule_start_time time,
  add column if not exists schedule_end_time time,
  add column if not exists notify_before_minutes int not null default 15;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pran_not_courses_notify_before_check'
      and conrelid = 'public.pran_not_courses'::regclass
  ) then
    alter table public.pran_not_courses
      add constraint pran_not_courses_notify_before_check
      check (notify_before_minutes between 0 and 120);
  end if;
end;
$$;

-- 2. Preferans notifikasyon ak son sou pwofil etidyan yo
alter table public.pran_not_profiles
  add column if not exists notify_sound boolean not null default true,
  add column if not exists notify_classes boolean not null default true;

-- 3. Modèl WhatsApp pou kou ki pral kòmanse
alter table public.pran_not_wa_settings
  add column if not exists class_reminder_enabled boolean not null default true,
  add column if not exists class_template_ht text not null default '{Bonjou|Alo} {name}, kou ou "{course}" ap kòmanse a {time}. Antre nan Klas an Dirèk la isit la : {url}',
  add column if not exists class_template_fr text not null default '{Bonjour|Salut} {name}, votre cours "{course}" commence à {time}. Ouvrez le mode Cours en Direct : {url}';
