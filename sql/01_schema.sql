-- =====================================================================
-- PRAN NÒT - 01_schema.sql
-- Schéma complet de la base de données (PostgreSQL / Supabase)
-- Exécuter en premier, dans l'éditeur SQL de Supabase.
-- =====================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------
-- Fonction utilitaire : mise à jour automatique de updated_at
-- ---------------------------------------------------------------------
create or replace function public.pran_not_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- =====================================================================
-- TABLES DE RÉFÉRENCE
-- =====================================================================

-- Facultés (id lisible : 'medecine', 'droit', ...)
create table if not exists public.pran_not_faculties (
  id            text primary key,
  name_fr       text not null,
  name_ht       text not null,
  persona       text not null default '',      -- façon de raisonner du tuteur
  case_label_fr text not null default 'Cas pratique',
  case_label_ht text not null default 'Ka pratik',
  icon          text not null default 'graduation-cap', -- nom d'icône Lucide
  position      int  not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Administrateurs (par email)
create table if not exists public.pran_not_admin_users (
  email      text primary key,
  created_at timestamptz not null default now()
);

-- =====================================================================
-- PROFILS
-- =====================================================================
create table if not exists public.pran_not_profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               text,
  full_name           text,
  avatar_url          text,
  faculty_id          text references public.pran_not_faculties(id) on delete set null,
  level               text check (level in ('L1','L2','L3','L4','L5','L6','master')),
  university          text,
  language            text not null default 'ht' check (language in ('ht','fr')),
  daily_goal_minutes  int  not null default 30 check (daily_goal_minutes between 5 and 600),
  reminder_time       time not null default '19:00',
  timezone            text not null default 'America/Port-au-Prince',
  onboarded           boolean not null default false,
  xp                  int  not null default 0,
  xp_level            int  not null default 1,
  data_saver          boolean not null default false,
  notify_email        boolean not null default true,
  notify_weekly       boolean not null default true,
  notify_deadlines    boolean not null default true,
  notify_sound        boolean not null default true,
  notify_classes      boolean not null default true,
  whatsapp_phone      text,
  notify_whatsapp     boolean not null default true,
  last_wa_reminder_at timestamptz,
  unsubscribe_token   uuid not null default gen_random_uuid(),
  ai_daily_quota      int  not null default 60,
  is_banned           boolean not null default false,
  theme_config        jsonb not null default '{}'::jsonb check (jsonb_typeof(theme_config) = 'object'),
  last_seen_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists pran_not_profiles_faculty_idx on public.pran_not_profiles(faculty_id);
create unique index if not exists pran_not_profiles_unsub_idx on public.pran_not_profiles(unsubscribe_token);

-- Colonnes WhatsApp et thème ajoutées de façon idempotente pour les bases existantes
alter table public.pran_not_profiles
  add column if not exists whatsapp_phone text,
  add column if not exists notify_whatsapp boolean not null default true,
  add column if not exists last_wa_reminder_at timestamptz,
  add column if not exists theme_config jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pran_not_profiles_theme_config_check'
      and conrelid = 'public.pran_not_profiles'::regclass
  ) then
    alter table public.pran_not_profiles
      add constraint pran_not_profiles_theme_config_check check (jsonb_typeof(theme_config) = 'object');
  end if;
end;
$$;

-- =====================================================================
-- COURS ET SYLLABUS
-- =====================================================================
create table if not exists public.pran_not_courses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 160),
  professor      text,
  semester       text,
  credits               int check (credits between 0 and 30),
  schedule_days         text[] not null default '{}',  -- ex: {'mon','wed'}
  schedule_start_time   time,
  schedule_end_time     time,
  notify_before_minutes int not null default 15,
  color                 text not null default '#F97316',
  exam_date      date,
  mastery        numeric(5,2) not null default 0,
  archived       boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists pran_not_courses_user_idx on public.pran_not_courses(user_id);

create table if not exists public.pran_not_syllabi (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  course_id     uuid not null references public.pran_not_courses(id) on delete cascade,
  source_type   text not null default 'text' check (source_type in ('pdf','image','text')),
  storage_path  text,
  raw_text      text,
  analysis      jsonb,           -- voir CONTRACT : {units, objectives, evaluation, calendar, study_order}
  status        text not null default 'pending' check (status in ('pending','processing','done','error')),
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists pran_not_syllabi_user_idx on public.pran_not_syllabi(user_id);
create index if not exists pran_not_syllabi_course_idx on public.pran_not_syllabi(course_id);

create table if not exists public.pran_not_syllabus_units (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  course_id     uuid not null references public.pran_not_courses(id) on delete cascade,
  syllabus_id   uuid references public.pran_not_syllabi(id) on delete set null,
  position      int not null default 0,
  title         text not null,
  description   text,
  objectives    text[] not null default '{}',
  keywords      text[] not null default '{}',
  planned_week  int,
  planned_date  date,
  weight        numeric(5,2),
  status        text not null default 'todo' check (status in ('todo','in_progress','mastered')),
  mastery       numeric(5,2) not null default 0,
  studied_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists pran_not_units_user_idx on public.pran_not_syllabus_units(user_id);
create index if not exists pran_not_units_course_idx on public.pran_not_syllabus_units(course_id);
create index if not exists pran_not_units_syllabus_idx on public.pran_not_syllabus_units(syllabus_id);

-- =====================================================================
-- NOTES
-- =====================================================================
create table if not exists public.pran_not_notes (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  course_id             uuid references public.pran_not_courses(id) on delete set null,
  unit_id               uuid references public.pran_not_syllabus_units(id) on delete set null,
  client_id             text,      -- identifiant généré côté client (idempotence hors-ligne)
  title                 text not null default 'Nòt san tit',
  content_html          text not null default '',
  content_text          text not null default '',
  raw_text              text,      -- texte brut avant traitement IA (OCR / transcription / saisie)
  structured            jsonb,     -- voir CONTRACT : sortie structurée de l'IA
  summary               text,
  language              text not null default 'mix' check (language in ('ht','fr','mix')),
  capture_mode          text not null default 'text' check (capture_mode in ('photo','audio','flash','text','import')),
  status                text not null default 'draft' check (status in ('draft','queued','processing','ready','error')),
  ai_course_suggestion  uuid references public.pran_not_courses(id) on delete set null,
  ai_error              text,
  is_pinned             boolean not null default false,
  word_count            int not null default 0,
  search                tsvector generated always as (
                          setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
                          setweight(to_tsvector('simple', coalesce(summary,'')), 'B') ||
                          setweight(to_tsvector('simple', coalesce(content_text,'')), 'C')
                        ) stored,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists pran_not_notes_user_idx on public.pran_not_notes(user_id);
create index if not exists pran_not_notes_course_idx on public.pran_not_notes(course_id);
create index if not exists pran_not_notes_unit_idx on public.pran_not_notes(unit_id);
create index if not exists pran_not_notes_suggestion_idx on public.pran_not_notes(ai_course_suggestion);
create index if not exists pran_not_notes_search_idx on public.pran_not_notes using gin(search);
create index if not exists pran_not_notes_user_created_idx on public.pran_not_notes(user_id, created_at desc);
create unique index if not exists pran_not_notes_client_idx on public.pran_not_notes(user_id, client_id) where client_id is not null;

create table if not exists public.pran_not_note_sources (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  note_id           uuid not null references public.pran_not_notes(id) on delete cascade,
  kind              text not null check (kind in ('image','audio','pdf')),
  storage_path      text not null,
  mime              text,
  size_bytes        bigint,
  chunk_index       int not null default 0,
  duration_seconds  int,
  ocr_text          text,
  transcript        text,
  uncertain         jsonb not null default '[]',  -- [{text, suggestion, reason}]
  status            text not null default 'uploaded' check (status in ('uploaded','processing','done','error')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists pran_not_note_sources_user_idx on public.pran_not_note_sources(user_id);
create index if not exists pran_not_note_sources_note_idx on public.pran_not_note_sources(note_id);

create table if not exists public.pran_not_keywords (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  course_id   uuid references public.pran_not_courses(id) on delete cascade,
  unit_id     uuid references public.pran_not_syllabus_units(id) on delete set null,
  note_id     uuid references public.pran_not_notes(id) on delete set null,
  term        text not null,
  definition  text,
  weakness    numeric(5,2) not null default 0,  -- 0 = maîtrisé, 100 = très faible
  miss_count  int not null default 0,
  hit_count   int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pran_not_keywords_user_idx on public.pran_not_keywords(user_id);
create index if not exists pran_not_keywords_course_idx on public.pran_not_keywords(course_id);
create index if not exists pran_not_keywords_unit_idx on public.pran_not_keywords(unit_id);
create index if not exists pran_not_keywords_note_idx on public.pran_not_keywords(note_id);
create unique index if not exists pran_not_keywords_unique_term on public.pran_not_keywords(user_id, coalesce(course_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(term));

-- =====================================================================
-- FLASHCARDS ET RÉPÉTITION ESPACÉE
-- =====================================================================
create table if not exists public.pran_not_flashcard_decks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  course_id    uuid references public.pran_not_courses(id) on delete cascade,
  unit_id      uuid references public.pran_not_syllabus_units(id) on delete set null,
  note_id      uuid references public.pran_not_notes(id) on delete set null,
  title        text not null,
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pran_not_decks_user_idx on public.pran_not_flashcard_decks(user_id);
create index if not exists pran_not_decks_course_idx on public.pran_not_flashcard_decks(course_id);
create index if not exists pran_not_decks_unit_idx on public.pran_not_flashcard_decks(unit_id);
create index if not exists pran_not_decks_note_idx on public.pran_not_flashcard_decks(note_id);

create table if not exists public.pran_not_flashcards (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  deck_id           uuid not null references public.pran_not_flashcard_decks(id) on delete cascade,
  course_id         uuid references public.pran_not_courses(id) on delete set null,
  unit_id           uuid references public.pran_not_syllabus_units(id) on delete set null,
  note_id           uuid references public.pran_not_notes(id) on delete set null,
  type              text not null default 'qa' check (type in ('qa','definition','cloze','true_false','formula','case')),
  front             text not null,
  back              text not null,
  extra             jsonb not null default '{}',  -- ex: {explanation, answer_bool}
  tags              text[] not null default '{}',
  ease              numeric(4,2) not null default 2.5,
  interval_days     int not null default 0,
  repetitions       int not null default 0,
  lapses            int not null default 0,
  due_at            timestamptz not null default now(),
  last_reviewed_at  timestamptz,
  suspended         boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists pran_not_cards_user_idx on public.pran_not_flashcards(user_id);
create index if not exists pran_not_cards_deck_idx on public.pran_not_flashcards(deck_id);
create index if not exists pran_not_cards_course_idx on public.pran_not_flashcards(course_id);
create index if not exists pran_not_cards_unit_idx on public.pran_not_flashcards(unit_id);
create index if not exists pran_not_cards_note_idx on public.pran_not_flashcards(note_id);
create index if not exists pran_not_cards_due_idx on public.pran_not_flashcards(user_id, due_at) where suspended = false;

create table if not exists public.pran_not_card_reviews (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  card_id        uuid not null references public.pran_not_flashcards(id) on delete cascade,
  rating         smallint not null check (rating between 0 and 3), -- 0 à revoir, 1 difficile, 2 bien, 3 facile
  prev_interval  int,
  new_interval   int,
  new_ease       numeric(4,2),
  duration_ms    int,
  client_id      text,
  reviewed_at    timestamptz not null default now()
);
create index if not exists pran_not_reviews_user_idx on public.pran_not_card_reviews(user_id, reviewed_at desc);
create index if not exists pran_not_reviews_card_idx on public.pran_not_card_reviews(card_id);
create unique index if not exists pran_not_reviews_client_idx on public.pran_not_card_reviews(user_id, client_id) where client_id is not null;

-- =====================================================================
-- TESTS
-- =====================================================================
create table if not exists public.pran_not_tests (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  course_id           uuid references public.pran_not_courses(id) on delete cascade,
  unit_id             uuid references public.pran_not_syllabus_units(id) on delete set null,
  note_id             uuid references public.pran_not_notes(id) on delete set null,
  title               text not null,
  difficulty          text not null default 'medium' check (difficulty in ('easy','medium','exam')),
  kind                text not null default 'standard' check (kind in ('standard','remedial','flash')),
  source              text not null default 'ai' check (source in ('ai','manual')),
  question_count      int not null default 0,
  time_limit_minutes  int,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists pran_not_tests_user_idx on public.pran_not_tests(user_id);
create index if not exists pran_not_tests_course_idx on public.pran_not_tests(course_id);
create index if not exists pran_not_tests_unit_idx on public.pran_not_tests(unit_id);
create index if not exists pran_not_tests_note_idx on public.pran_not_tests(note_id);

create table if not exists public.pran_not_test_questions (
  id           uuid primary key default gen_random_uuid(),
  test_id      uuid not null references public.pran_not_tests(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  unit_id      uuid references public.pran_not_syllabus_units(id) on delete set null,
  position     int not null default 0,
  type         text not null check (type in ('mcq','true_false','short','case')),
  prompt       text not null,
  options      jsonb not null default '[]',  -- QCM : ["A","B","C","D"]
  answer       jsonb not null,              -- QCM : index ; V/F : bool ; court/cas : texte modèle
  explanation  text,
  keyword      text,
  points       numeric(5,2) not null default 1,
  created_at   timestamptz not null default now()
);
create index if not exists pran_not_questions_test_idx on public.pran_not_test_questions(test_id);
create index if not exists pran_not_questions_user_idx on public.pran_not_test_questions(user_id);
create index if not exists pran_not_questions_unit_idx on public.pran_not_test_questions(unit_id);

create table if not exists public.pran_not_test_attempts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  test_id        uuid not null references public.pran_not_tests(id) on delete cascade,
  course_id      uuid references public.pran_not_courses(id) on delete set null,
  unit_id        uuid references public.pran_not_syllabus_units(id) on delete set null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  score          numeric(6,2) not null default 0,
  max_score      numeric(6,2) not null default 0,
  percent        numeric(5,2) generated always as (case when max_score > 0 then round(score * 100 / max_score, 2) else 0 end) stored,
  answers        jsonb not null default '[]', -- [{question_id, given, correct, points, feedback}]
  weak_keywords  text[] not null default '{}',
  created_at     timestamptz not null default now()
);
create index if not exists pran_not_attempts_user_idx on public.pran_not_test_attempts(user_id, created_at desc);
create index if not exists pran_not_attempts_test_idx on public.pran_not_test_attempts(test_id);
create index if not exists pran_not_attempts_course_idx on public.pran_not_test_attempts(course_id);
create index if not exists pran_not_attempts_unit_idx on public.pran_not_test_attempts(unit_id);

-- =====================================================================
-- DEVOIRS
-- =====================================================================
create table if not exists public.pran_not_assignments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  course_id       uuid references public.pran_not_courses(id) on delete set null,
  title           text not null,
  instructions    text,
  due_at          timestamptz,
  status          text not null default 'todo' check (status in ('todo','in_progress','done','submitted')),
  plan            jsonb,          -- voir CONTRACT : {outline, research_leads, sources_to_find, structure, tips}
  content_html    text not null default '',
  cover           jsonb not null default '{}', -- {template, university, faculty, professor, student, level, date}
  reminders_sent  text[] not null default '{}', -- {'J7','J3','J1'}
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists pran_not_assignments_user_idx on public.pran_not_assignments(user_id);
create index if not exists pran_not_assignments_course_idx on public.pran_not_assignments(course_id);
create index if not exists pran_not_assignments_due_idx on public.pran_not_assignments(user_id, due_at);

create table if not exists public.pran_not_assignment_files (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  assignment_id  uuid not null references public.pran_not_assignments(id) on delete cascade,
  storage_path   text not null,
  name           text not null,
  mime           text,
  size_bytes     bigint,
  created_at     timestamptz not null default now()
);
create index if not exists pran_not_assignment_files_user_idx on public.pran_not_assignment_files(user_id);
create index if not exists pran_not_assignment_files_assignment_idx on public.pran_not_assignment_files(assignment_id);

-- =====================================================================
-- ÉTUDE, PLAN DU JOUR, GAMIFICATION
-- =====================================================================
create table if not exists public.pran_not_study_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  course_id         uuid references public.pran_not_courses(id) on delete set null,
  kind              text not null default 'pomodoro' check (kind in ('pomodoro','review','test','note','tutor','reading','assignment')),
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  duration_minutes  int not null default 0 check (duration_minutes between 0 and 600),
  client_id         text,
  created_at        timestamptz not null default now()
);
create index if not exists pran_not_sessions_user_idx on public.pran_not_study_sessions(user_id, started_at desc);
create index if not exists pran_not_sessions_course_idx on public.pran_not_study_sessions(course_id);
create unique index if not exists pran_not_sessions_client_idx on public.pran_not_study_sessions(user_id, client_id) where client_id is not null;

create table if not exists public.pran_not_daily_plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  plan_date   date not null,
  tasks       jsonb not null default '[]', -- voir CONTRACT
  challenge   jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, plan_date)
);
create index if not exists pran_not_daily_plans_user_idx on public.pran_not_daily_plans(user_id, plan_date desc);

create table if not exists public.pran_not_streaks (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  current           int not null default 0,
  longest           int not null default 0,
  last_active_date  date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.pran_not_xp_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  amount      int not null check (amount between -1000 and 1000),
  reason      text not null,
  ref_id      uuid,
  created_at  timestamptz not null default now()
);
create index if not exists pran_not_xp_events_user_idx on public.pran_not_xp_events(user_id, created_at desc);

create table if not exists public.pran_not_badges (
  id              text primary key,
  name_fr         text not null,
  name_ht         text not null,
  description_fr  text not null,
  description_ht  text not null,
  icon            text not null default 'award',
  criteria        jsonb not null, -- {"type":"streak|xp|notes|reviews|tests|perfect_test","value":N}
  position        int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.pran_not_user_badges (
  user_id    uuid not null references auth.users(id) on delete cascade,
  badge_id   text not null references public.pran_not_badges(id) on delete cascade,
  earned_at  timestamptz not null default now(),
  primary key (user_id, badge_id)
);
create index if not exists pran_not_user_badges_badge_idx on public.pran_not_user_badges(badge_id);

-- =====================================================================
-- TUTEUR IA
-- =====================================================================
create table if not exists public.pran_not_tutor_conversations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  course_id     uuid references public.pran_not_courses(id) on delete set null,
  context_type  text not null default 'general' check (context_type in ('general','note','course','card','deck','test','assignment','unit')),
  context_id    uuid,
  title         text not null default 'Nouvo konvèsasyon',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists pran_not_tutor_conv_user_idx on public.pran_not_tutor_conversations(user_id, updated_at desc);
create index if not exists pran_not_tutor_conv_course_idx on public.pran_not_tutor_conversations(course_id);

create table if not exists public.pran_not_tutor_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.pran_not_tutor_conversations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  role             text not null check (role in ('user','assistant')),
  content          text not null,
  mode             text,
  created_at       timestamptz not null default now()
);
create index if not exists pran_not_tutor_msg_conv_idx on public.pran_not_tutor_messages(conversation_id, created_at);
create index if not exists pran_not_tutor_msg_user_idx on public.pran_not_tutor_messages(user_id);

-- =====================================================================
-- GROUPES D'ÉTUDE ET PARTAGE
-- =====================================================================
create table if not exists public.pran_not_study_groups (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  name         text not null check (char_length(name) between 2 and 80),
  description  text,
  invite_code  text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pran_not_groups_owner_idx on public.pran_not_study_groups(owner_id);

create table if not exists public.pran_not_group_members (
  group_id   uuid not null references public.pran_not_study_groups(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'viewer' check (role in ('owner','editor','viewer')),
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists pran_not_group_members_user_idx on public.pran_not_group_members(user_id);

create table if not exists public.pran_not_shared_items (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.pran_not_study_groups(id) on delete cascade,
  shared_by   uuid not null references auth.users(id) on delete cascade,
  item_type   text not null check (item_type in ('note','deck')),
  item_id     uuid not null,
  permission  text not null default 'view' check (permission in ('view','copy')),
  created_at  timestamptz not null default now(),
  unique (group_id, item_type, item_id)
);
create index if not exists pran_not_shared_items_group_idx on public.pran_not_shared_items(group_id);
create index if not exists pran_not_shared_items_by_idx on public.pran_not_shared_items(shared_by);
create index if not exists pran_not_shared_items_item_idx on public.pran_not_shared_items(item_type, item_id);

-- =====================================================================
-- NOTIFICATIONS, ANNONCES, SIGNALEMENTS
-- =====================================================================
create table if not exists public.pran_not_notifications (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  kind           text not null default 'info' check (kind in ('info','reminder','deadline','streak','report','badge','announcement','ai')),
  title          text not null,
  body           text,
  link           text,
  read_at        timestamptz,
  sent_email_at  timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists pran_not_notifications_user_idx on public.pran_not_notifications(user_id, created_at desc);

create table if not exists public.pran_not_announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  level       text not null default 'info' check (level in ('info','warning','success')),
  active      boolean not null default true,
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pran_not_announcements_created_by_idx on public.pran_not_announcements(created_by);

create table if not exists public.pran_not_content_reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references auth.users(id) on delete cascade,
  item_type    text not null check (item_type in ('note','deck','flashcard','group','ai_output')),
  item_id      uuid not null,
  reason       text not null,
  status       text not null default 'open' check (status in ('open','reviewed','dismissed','removed')),
  admin_note   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pran_not_reports_reporter_idx on public.pran_not_content_reports(reporter_id);
create index if not exists pran_not_reports_status_idx on public.pran_not_content_reports(status);

-- =====================================================================
-- IA : FOURNISSEURS, PROMPTS, USAGE, CACHE, FILE D'ATTENTE
-- =====================================================================
create table if not exists public.pran_not_ai_providers (
  id              text primary key,            -- 'gemini' | 'groq' | 'mistral' | 'openrouter'
  name            text not null,
  tasks           text[] not null default '{}',
  priority        int not null default 10,     -- plus petit = prioritaire
  daily_quota     int not null default 1000,   -- requêtes par jour (global)
  used_today      int not null default 0,
  quota_date      date not null default current_date,
  status          text not null default 'active' check (status in ('active','disabled','exhausted')),
  model_text      text,
  model_vision    text,
  model_audio     text,
  last_error      text,
  last_error_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.pran_not_ai_prompts (
  id             uuid primary key default gen_random_uuid(),
  task           text not null,
  faculty_id     text references public.pran_not_faculties(id) on delete cascade,
  system_prompt  text not null,
  version        int not null default 1,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists pran_not_ai_prompts_faculty_idx on public.pran_not_ai_prompts(faculty_id);
create unique index if not exists pran_not_ai_prompts_task_faculty_idx on public.pran_not_ai_prompts(task, coalesce(faculty_id, '_all')) where active;

create table if not exists public.pran_not_ai_usage (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  task        text not null,
  provider    text,
  model       text,
  tokens_in   int not null default 0,
  tokens_out  int not null default 0,
  cost        numeric(10,5) not null default 0,
  cached      boolean not null default false,
  success     boolean not null default true,
  error       text,
  latency_ms  int,
  created_at  timestamptz not null default now()
);
create index if not exists pran_not_ai_usage_user_idx on public.pran_not_ai_usage(user_id, created_at desc);
create index if not exists pran_not_ai_usage_created_idx on public.pran_not_ai_usage(created_at desc);
create index if not exists pran_not_ai_usage_provider_idx on public.pran_not_ai_usage(provider, created_at desc);

create table if not exists public.pran_not_ai_cache (
  hash        text primary key,      -- sha256(task + faculty + language + payload)
  task        text not null,
  result      jsonb not null,
  hits        int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists pran_not_ai_cache_created_idx on public.pran_not_ai_cache(created_at);

create table if not exists public.pran_not_ai_jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  task        text not null,
  payload     jsonb not null default '{}',
  status      text not null default 'queued' check (status in ('queued','running','done','error')),
  attempts    int not null default 0,
  result      jsonb,
  error       text,
  run_after   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pran_not_ai_jobs_user_idx on public.pran_not_ai_jobs(user_id);
create index if not exists pran_not_ai_jobs_status_idx on public.pran_not_ai_jobs(status, run_after);

-- =====================================================================
-- WHATSAPP GATEWAY CVISUAL : PARAMÈTRES SERVEUR & JOURNAUX
-- =====================================================================
create table if not exists public.pran_not_wa_settings (
  id                      text primary key default 'default',
  base_url                text not null default 'https://cvisual-whatsapp-gateway.onrender.com',
  api_key                 text, -- priorité au-dessus de la variable d'environnement serveur (jamais exposé au frontend)
  webhook_secret          text, -- secret HMAC-SHA256 pour X-CVISUAL-Signature
  enabled                 boolean not null default true,
  welcome_enabled         boolean not null default false,
  inactivity_days         int not null default 2 check (inactivity_days between 1 and 30),
  reminder_cooldown_hours int not null default 48 check (reminder_cooldown_hours between 12 and 168),
  deadline_enabled        boolean not null default true,
  class_reminder_enabled  boolean not null default true,
  inactive_template_ht    text not null default '{Bonjou|Alo|Koman ou ye} {name}, sa fe {days} jou nou pa we w sou Pran Not. Ou gen {due} kat memwa ki ap tann ou. Tounen etidye : {url}',
  inactive_template_fr    text not null default '{Bonjour|Salut} {name}, cela fait {days} jour(s) que vous n''etes pas passe sur Pran Not. Vous avez {due} carte(s) a reviser : {url}',
  deadline_template_ht    text not null default '{Rapel|Atansyon} {name} : devwa ou yo ({deadlines}) ap rive talè. Louvri Pran Not : {url}',
  deadline_template_fr    text not null default '{Rappel|Attention} {name} : vos echeances ({deadlines}) approchent. Ouvrez Pran Not : {url}',
  class_template_ht       text not null default '{Bonjou|Alo} {name}, kou ou "{course}" ap kòmanse a {time}. Antre nan Klas an Dirèk la isit la : {url}',
  class_template_fr       text not null default '{Bonjour|Salut} {name}, votre cours "{course}" commence à {time}. Ouvrez le mode Cours en Direct : {url}',
  updated_by              uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists public.pran_not_wa_logs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references auth.users(id) on delete set null,
  phone              text not null,
  kind               text not null,
  lane               text not null check (lane in ('fast','slow')),
  mode               text not null check (mode in ('async','sync')),
  gateway_message_id text,
  status             text not null default 'queued',
  error_code         text,
  error_message      text,
  payload            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists pran_not_wa_logs_user_idx on public.pran_not_wa_logs(user_id, created_at desc);
create index if not exists pran_not_wa_logs_gw_idx on public.pran_not_wa_logs(gateway_message_id);

-- =====================================================================
-- TRIGGERS updated_at (uniquement les tables pran_not_* ayant une colonne updated_at)
-- =====================================================================
do $$
declare
  t record;
begin
  for t in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public'
      and c.table_name like 'pran\_not\_%' escape '\'
      and c.column_name = 'updated_at'
  loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$I', t.table_name);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$I
                    for each row execute function public.pran_not_set_updated_at()', t.table_name);
  end loop;
end;
$$;

-- =====================================================================
-- FONCTIONS UTILITAIRES
-- =====================================================================

-- L'utilisateur courant est-il administrateur ?
create or replace function public.pran_not_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.pran_not_admin_users a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- Date "aujourd'hui" dans le fuseau de l'utilisateur
create or replace function public.pran_not_user_today(p_user uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select (now() at time zone coalesce(
            (select timezone from public.pran_not_profiles where id = p_user),
            'America/Port-au-Prince'))::date;
$$;

-- Nombre de texte (mots) à partir du contenu
create or replace function public.pran_not_notes_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.word_count := coalesce(array_length(regexp_split_to_array(trim(coalesce(new.content_text,'')), '\s+'), 1), 0);
  if trim(coalesce(new.content_text,'')) = '' then
    new.word_count := 0;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_pran_not_notes_before_write on public.pran_not_notes;
create trigger trg_pran_not_notes_before_write before insert or update of content_text on public.pran_not_notes
  for each row execute function public.pran_not_notes_before_write();

-- Compteur de questions d'un test
create or replace function public.pran_not_sync_question_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_test uuid := coalesce(new.test_id, old.test_id);
begin
  update public.pran_not_tests
     set question_count = (select count(*) from public.pran_not_test_questions where test_id = v_test)
   where id = v_test;
  return null;
end;
$$;
drop trigger if exists trg_pran_not_sync_question_count on public.pran_not_test_questions;
create trigger trg_pran_not_sync_question_count after insert or delete on public.pran_not_test_questions
  for each row execute function public.pran_not_sync_question_count();

-- =====================================================================
-- CRÉATION DU PROFIL À L'INSCRIPTION
-- =====================================================================
create or replace function public.pran_not_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pran_not_profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;

  insert into public.pran_not_streaks (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists pran_not_on_auth_user_created on auth.users;
create trigger pran_not_on_auth_user_created
  after insert on auth.users
  for each row execute function public.pran_not_handle_new_user();

-- Crée paresseusement le profil Pran Nòt si le compte existait déjà dans auth.users (projet partagé)
create or replace function public.pran_not_ensure_profile()
returns public.pran_not_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_prof  public.pran_not_profiles;
  v_email text;
  v_name  text;
  v_ava   text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_prof from public.pran_not_profiles where id = v_uid;
  if found then
    return v_prof;
  end if;

  select u.email,
         coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
         u.raw_user_meta_data ->> 'avatar_url'
    into v_email, v_name, v_ava
    from auth.users u
   where u.id = v_uid;

  insert into public.pran_not_profiles (id, email, full_name, avatar_url)
  values (v_uid, v_email, v_name, v_ava)
  on conflict (id) do nothing;

  insert into public.pran_not_streaks (user_id)
  values (v_uid)
  on conflict (user_id) do nothing;

  select * into v_prof from public.pran_not_profiles where id = v_uid;
  return v_prof;
end;
$$;

-- =====================================================================
-- SÉRIE QUOTIDIENNE (STREAK)
-- Appelée par le client (RPC) à chaque activité d'étude réelle.
-- =====================================================================
create or replace function public.pran_not_record_activity()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_today  date;
  v_row    public.pran_not_streaks;
  v_bonus  boolean := false;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;

  v_today := public.pran_not_user_today(v_user);

  insert into public.pran_not_streaks (user_id) values (v_user) on conflict (user_id) do nothing;
  select * into v_row from public.pran_not_streaks where user_id = v_user for update;

  if v_row.last_active_date = v_today then
    null; -- déjà compté aujourd'hui
  elsif v_row.last_active_date = v_today - 1 then
    update public.pran_not_streaks
       set current = current + 1,
           longest = greatest(longest, current + 1),
           last_active_date = v_today
     where user_id = v_user;
    v_bonus := true;
  else
    update public.pran_not_streaks
       set current = 1,
           longest = greatest(longest, 1),
           last_active_date = v_today
     where user_id = v_user;
    v_bonus := true;
  end if;

  update public.pran_not_profiles set last_seen_at = now() where id = v_user;

  select * into v_row from public.pran_not_streaks where user_id = v_user;

  if v_bonus then
    perform public.pran_not_award_xp_internal(v_user, 10, 'streak_day', null);
  end if;

  return jsonb_build_object(
    'current', v_row.current,
    'longest', v_row.longest,
    'last_active_date', v_row.last_active_date,
    'new_day', v_bonus
  );
end;
$$;

-- =====================================================================
-- XP, NIVEAUX ET BADGES
-- =====================================================================
create or replace function public.pran_not_xp_to_level(p_xp int)
returns int
language sql
immutable
set search_path = public
as $$
  select greatest(1, floor(sqrt(greatest(p_xp, 0)::numeric / 50))::int + 1);
$$;

create or replace function public.pran_not_check_badges(p_user uuid)
returns setof text
language plpgsql
security definer
set search_path = public
as $$
declare
  b        record;
  v_value  int;
begin
  for b in select * from public.pran_not_badges loop
    if exists (select 1 from public.pran_not_user_badges where user_id = p_user and badge_id = b.id) then
      continue;
    end if;

    v_value := case b.criteria ->> 'type'
      when 'streak'       then (select greatest(current, longest) from public.pran_not_streaks where user_id = p_user)
      when 'xp'           then (select xp from public.pran_not_profiles where id = p_user)
      when 'notes'        then (select count(*) from public.pran_not_notes where user_id = p_user)::int
      when 'reviews'      then (select count(*) from public.pran_not_card_reviews where user_id = p_user)::int
      when 'tests'        then (select count(*) from public.pran_not_test_attempts where user_id = p_user and finished_at is not null)::int
      when 'perfect_test' then (select count(*) from public.pran_not_test_attempts where user_id = p_user and finished_at is not null and percent >= 100)::int
      when 'courses'      then (select count(*) from public.pran_not_courses where user_id = p_user)::int
      when 'mastered'     then (select count(*) from public.pran_not_syllabus_units where user_id = p_user and status = 'mastered')::int
      else 0
    end;

    if coalesce(v_value, 0) >= coalesce((b.criteria ->> 'value')::int, 1) then
      insert into public.pran_not_user_badges (user_id, badge_id) values (p_user, b.id) on conflict do nothing;
      insert into public.pran_not_notifications (user_id, kind, title, body, link)
      values (p_user, 'badge', b.name_ht, b.description_ht, 'profile.html#badges');
      return next b.id;
    end if;
  end loop;
end;
$$;

create or replace function public.pran_not_award_xp_internal(p_user uuid, p_amount int, p_reason text, p_ref uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_xp int;
begin
  insert into public.pran_not_xp_events (user_id, amount, reason, ref_id) values (p_user, p_amount, p_reason, p_ref);
  update public.pran_not_profiles
     set xp = greatest(0, xp + p_amount),
         xp_level = public.pran_not_xp_to_level(greatest(0, xp + p_amount))
   where id = p_user
  returning xp into v_xp;
  perform public.pran_not_check_badges(p_user);
  return coalesce(v_xp, 0);
end;
$$;

-- Version appelable par le client : montants plafonnés et plafond journalier anti-abus
create or replace function public.pran_not_award_xp(p_amount int, p_reason text, p_ref uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user       uuid := auth.uid();
  v_today_sum  int;
  v_amount     int;
  v_xp         int;
  v_new_badges text[];
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;
  v_amount := least(greatest(coalesce(p_amount, 0), 0), 50);

  select coalesce(sum(amount), 0) into v_today_sum
    from public.pran_not_xp_events
   where user_id = v_user and created_at >= date_trunc('day', now());

  if v_today_sum + v_amount > 1500 then
    v_amount := greatest(0, 1500 - v_today_sum);
  end if;

  if v_amount > 0 then
    insert into public.pran_not_xp_events (user_id, amount, reason, ref_id) values (v_user, v_amount, left(p_reason, 60), p_ref);
    update public.pran_not_profiles
       set xp = xp + v_amount,
           xp_level = public.pran_not_xp_to_level(xp + v_amount)
     where id = v_user;
  end if;

  select array_agg(x) into v_new_badges from public.pran_not_check_badges(v_user) as x;
  select xp into v_xp from public.pran_not_profiles where id = v_user;

  return jsonb_build_object(
    'xp', v_xp,
    'level', public.pran_not_xp_to_level(v_xp),
    'awarded', v_amount,
    'new_badges', coalesce(to_jsonb(v_new_badges), '[]'::jsonb)
  );
end;
$$;

-- =====================================================================
-- CALCUL DE MAÎTRISE
-- Maîtrise d'une unité = moyenne pondérée (cartes 50 %, tests 50 %)
--   cartes : moyenne de min(intervalle, 21) / 21 sur les cartes révisées
--   tests  : moyenne des 3 dernières tentatives terminées de l'unité
-- =====================================================================
create or replace function public.pran_not_recompute_unit_mastery(p_unit uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cards   numeric;
  v_tests   numeric;
  v_mastery numeric;
  v_course  uuid;
  v_status  text;
begin
  if p_unit is null then
    return null;
  end if;

  select course_id, status into v_course, v_status from public.pran_not_syllabus_units where id = p_unit;
  if v_course is null then
    return null;
  end if;

  select avg(least(interval_days, 21)::numeric / 21 * 100)
    into v_cards
    from public.pran_not_flashcards
   where unit_id = p_unit and last_reviewed_at is not null and suspended = false;

  select avg(percent)
    into v_tests
    from (
      select percent from public.pran_not_test_attempts
       where unit_id = p_unit and finished_at is not null
       order by finished_at desc
       limit 3
    ) s;

  v_mastery := case
    when v_cards is not null and v_tests is not null then round(v_cards * 0.5 + v_tests * 0.5, 2)
    when v_cards is not null then round(v_cards, 2)
    when v_tests is not null then round(v_tests, 2)
    else 0
  end;

  update public.pran_not_syllabus_units
     set mastery = v_mastery,
         status = case
                    when v_mastery >= 80 then 'mastered'
                    when v_mastery > 0 or v_status = 'in_progress' then 'in_progress'
                    else status
                  end
   where id = p_unit;

  perform public.pran_not_recompute_course_mastery(v_course);
  return v_mastery;
end;
$$;

create or replace function public.pran_not_recompute_course_mastery(p_course uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_m numeric;
begin
  select coalesce(round(avg(mastery), 2), 0) into v_m
    from public.pran_not_syllabus_units where course_id = p_course;

  -- Cours sans unités : se baser sur les cartes du cours
  if not exists (select 1 from public.pran_not_syllabus_units where course_id = p_course) then
    select coalesce(round(avg(least(interval_days, 21)::numeric / 21 * 100), 2), 0) into v_m
      from public.pran_not_flashcards where course_id = p_course and last_reviewed_at is not null;
  end if;

  update public.pran_not_courses set mastery = v_m where id = p_course;
  return v_m;
end;
$$;

-- Déclencheurs : révision de carte et tentative de test
create or replace function public.pran_not_after_card_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit   uuid;
  v_course uuid;
begin
  select unit_id, course_id into v_unit, v_course from public.pran_not_flashcards where id = new.card_id;
  if v_unit is not null then
    perform public.pran_not_recompute_unit_mastery(v_unit);
  elsif v_course is not null then
    perform public.pran_not_recompute_course_mastery(v_course);
  end if;
  return null;
end;
$$;
drop trigger if exists trg_pran_not_after_card_review on public.pran_not_card_reviews;
create trigger trg_pran_not_after_card_review after insert on public.pran_not_card_reviews
  for each row execute function public.pran_not_after_card_review();

create or replace function public.pran_not_after_test_attempt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  kw text;
begin
  if new.finished_at is null then
    return null;
  end if;

  if new.unit_id is not null then
    perform public.pran_not_recompute_unit_mastery(new.unit_id);
  end if;

  -- Mise à jour de la faiblesse des mots-clés
  if new.weak_keywords is not null then
    foreach kw in array new.weak_keywords loop
      insert into public.pran_not_keywords (user_id, course_id, unit_id, term, weakness, miss_count)
      values (new.user_id, new.course_id, new.unit_id, kw, 60, 1)
      on conflict (user_id, coalesce(course_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(term))
      do update set miss_count = public.pran_not_keywords.miss_count + 1,
                    weakness = least(100, public.pran_not_keywords.weakness + 20);
    end loop;
  end if;

  return null;
end;
$$;
drop trigger if exists trg_pran_not_after_test_attempt on public.pran_not_test_attempts;
create trigger trg_pran_not_after_test_attempt after insert or update of finished_at on public.pran_not_test_attempts
  for each row execute function public.pran_not_after_test_attempt();

-- =====================================================================
-- PLAN DU JOUR
-- Génère (ou retourne) le plan du jour de l'utilisateur.
-- Les tâches sont typées ; le texte est rendu côté client via i18n.
-- Format d'une tâche :
--   {id, type, minutes, link, done, params:{...}}
--   type ∈ review | test | assignment | weak | study_unit | capture | exam
-- =====================================================================
create or replace function public.pran_not_build_daily_plan(p_user uuid, p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tasks      jsonb := '[]'::jsonb;
  v_due        int;
  v_count      int := 0;
  r            record;
begin
  -- 1. Cartes dues
  select count(*) into v_due
    from public.pran_not_flashcards
   where user_id = p_user and suspended = false and due_at <= (p_date + 1)::timestamptz;
  if v_due > 0 then
    v_tasks := v_tasks || jsonb_build_object(
      'id', 'review', 'type', 'review',
      'minutes', greatest(5, least(45, ceil(least(v_due, 120) * 0.4)::int)),
      'link', 'review.html', 'done', false,
      'params', jsonb_build_object('count', least(v_due, 120)));
    v_count := v_count + 1;
  end if;

  -- 2. Examen proche (dans 14 jours)
  for r in
    select id, name, exam_date from public.pran_not_courses
     where user_id = p_user and archived = false and exam_date between p_date and p_date + 14
     order by exam_date limit 1
  loop
    v_tasks := v_tasks || jsonb_build_object(
      'id', 'exam_' || r.id, 'type', 'exam', 'minutes', 30,
      'link', 'course.html?id=' || r.id || '&mode=exam', 'done', false,
      'params', jsonb_build_object('course', r.name, 'course_id', r.id, 'days', r.exam_date - p_date));
    v_count := v_count + 1;
  end loop;

  -- 3. Devoirs proches (7 jours)
  for r in
    select a.id, a.title, a.due_at, c.name as course_name
      from public.pran_not_assignments a
      left join public.pran_not_courses c on c.id = a.course_id
     where a.user_id = p_user and a.status in ('todo','in_progress')
       and a.due_at is not null and a.due_at::date between p_date and p_date + 7
     order by a.due_at limit 2
  loop
    v_tasks := v_tasks || jsonb_build_object(
      'id', 'assignment_' || r.id, 'type', 'assignment', 'minutes', 45,
      'link', 'assignment.html?id=' || r.id, 'done', false,
      'params', jsonb_build_object('title', r.title, 'course', coalesce(r.course_name, ''), 'days', r.due_at::date - p_date));
    v_count := v_count + 1;
  end loop;

  -- 4. Test du jour sur une unité étudiée récemment et non testée aujourd'hui
  for r in
    select u.id, u.title, u.course_id, c.name as course_name
      from public.pran_not_syllabus_units u
      join public.pran_not_courses c on c.id = u.course_id
     where u.user_id = p_user and u.status = 'in_progress' and c.archived = false
       and not exists (
         select 1 from public.pran_not_test_attempts t
          where t.unit_id = u.id and t.created_at::date = p_date)
     order by u.studied_at desc nulls last, u.mastery asc
     limit 1
  loop
    v_tasks := v_tasks || jsonb_build_object(
      'id', 'test_' || r.id, 'type', 'test', 'minutes', 10,
      'link', 'tests.html?unit=' || r.id || '&autostart=1', 'done', false,
      'params', jsonb_build_object('unit', r.title, 'unit_id', r.id, 'course', r.course_name, 'course_id', r.course_id));
    v_count := v_count + 1;
  end loop;

  -- 5. Point faible (mot-clé le plus faible)
  if v_count < 5 then
    for r in
      select k.term, k.course_id, c.name as course_name
        from public.pran_not_keywords k
        left join public.pran_not_courses c on c.id = k.course_id
       where k.user_id = p_user and k.weakness >= 40
       order by k.weakness desc, k.updated_at desc
       limit 1
    loop
      v_tasks := v_tasks || jsonb_build_object(
        'id', 'weak_' || md5(r.term), 'type', 'weak', 'minutes', 10,
        'link', 'tests.html?remedial=1' || coalesce('&course=' || r.course_id, ''), 'done', false,
        'params', jsonb_build_object('keyword', r.term, 'course', coalesce(r.course_name, ''), 'course_id', r.course_id));
      v_count := v_count + 1;
    end loop;
  end if;

  -- 6. Prochaine unité à étudier
  if v_count < 4 then
    for r in
      select u.id, u.title, c.name as course_name, c.id as course_id
        from public.pran_not_syllabus_units u
        join public.pran_not_courses c on c.id = u.course_id
       where u.user_id = p_user and u.status = 'todo' and c.archived = false
       order by coalesce(u.planned_date, p_date + 365), u.position
       limit 1
    loop
      v_tasks := v_tasks || jsonb_build_object(
        'id', 'unit_' || r.id, 'type', 'study_unit', 'minutes', 25,
        'link', 'course.html?id=' || r.course_id || '#unit-' || r.id, 'done', false,
        'params', jsonb_build_object('unit', r.title, 'unit_id', r.id, 'course', r.course_name));
      v_count := v_count + 1;
    end loop;
  end if;

  -- 7. Toujours au moins 3 tâches : capture de note
  if v_count < 3 then
    v_tasks := v_tasks || jsonb_build_object(
      'id', 'capture', 'type', 'capture', 'minutes', 10,
      'link', 'note-capture.html', 'done', false, 'params', '{}'::jsonb);
    v_count := v_count + 1;
  end if;
  if v_count < 3 then
    v_tasks := v_tasks || jsonb_build_object(
      'id', 'course_setup', 'type', 'course_setup', 'minutes', 5,
      'link', 'courses.html?new=1', 'done', false, 'params', '{}'::jsonb);
  end if;

  return v_tasks;
end;
$$;

-- RPC client : retourne le plan du jour (créé une seule fois par jour)
create or replace function public.pran_not_get_daily_plan()
returns public.pran_not_daily_plans
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_date   date;
  v_plan   public.pran_not_daily_plans;
  v_fac    text;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;
  v_date := public.pran_not_user_today(v_user);

  select * into v_plan from public.pran_not_daily_plans where user_id = v_user and plan_date = v_date;
  if found then
    return v_plan;
  end if;

  select faculty_id into v_fac from public.pran_not_profiles where id = v_user;

  insert into public.pran_not_daily_plans (user_id, plan_date, tasks, challenge)
  values (
    v_user, v_date,
    public.pran_not_build_daily_plan(v_user, v_date),
    jsonb_build_object('faculty', coalesce(v_fac, 'autre'), 'seed', extract(doy from v_date)::int, 'done', false)
  )
  on conflict (user_id, plan_date) do update set tasks = excluded.tasks
  returning * into v_plan;

  return v_plan;
end;
$$;

-- RPC client : régénérer le plan en conservant les tâches terminées
create or replace function public.pran_not_refresh_daily_plan()
returns public.pran_not_daily_plans
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_date  date;
  v_old   jsonb;
  v_new   jsonb;
  v_plan  public.pran_not_daily_plans;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;
  v_date := public.pran_not_user_today(v_user);
  perform public.pran_not_get_daily_plan();
  select tasks into v_old from public.pran_not_daily_plans where user_id = v_user and plan_date = v_date;
  v_new := public.pran_not_build_daily_plan(v_user, v_date);

  -- conserver l'état "done" des tâches existantes ayant le même id
  select coalesce(jsonb_agg(
           case when exists (select 1 from jsonb_array_elements(v_old) o
                              where o ->> 'id' = n ->> 'id' and (o ->> 'done')::boolean)
                then jsonb_set(n, '{done}', 'true'::jsonb) else n end), '[]'::jsonb)
    into v_new
    from jsonb_array_elements(v_new) n;

  update public.pran_not_daily_plans set tasks = v_new where user_id = v_user and plan_date = v_date
  returning * into v_plan;
  return v_plan;
end;
$$;

-- RPC client : marquer une tâche comme faite
create or replace function public.pran_not_complete_plan_task(p_task_id text)
returns public.pran_not_daily_plans
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_date date;
  v_plan public.pran_not_daily_plans;
  v_was  boolean;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;
  v_date := public.pran_not_user_today(v_user);

  select exists (
    select 1 from public.pran_not_daily_plans p, jsonb_array_elements(p.tasks) t
     where p.user_id = v_user and p.plan_date = v_date
       and t ->> 'id' = p_task_id and (t ->> 'done')::boolean
  ) into v_was;

  update public.pran_not_daily_plans p
     set tasks = (
       select coalesce(jsonb_agg(
                case when t ->> 'id' = p_task_id then jsonb_set(t, '{done}', 'true'::jsonb) else t end), '[]'::jsonb)
         from jsonb_array_elements(p.tasks) t)
   where p.user_id = v_user and p.plan_date = v_date
  returning * into v_plan;

  if not v_was and v_plan.id is not null then
    perform public.pran_not_award_xp_internal(v_user, 15, 'plan_task', null);
  end if;
  return v_plan;
end;
$$;

-- =====================================================================
-- STATISTIQUES DU TABLEAU DE BORD
-- =====================================================================
create or replace function public.pran_not_get_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_today date;
begin
  if v_user is null then
    raise exception 'not_authenticated';
  end if;
  v_today := public.pran_not_user_today(v_user);

  return jsonb_build_object(
    'minutes_today', coalesce((
        select sum(duration_minutes) from public.pran_not_study_sessions
         where user_id = v_user
           and (started_at at time zone coalesce((select timezone from public.pran_not_profiles where id = v_user), 'America/Port-au-Prince'))::date = v_today), 0),
    'reviews_today', (select count(*) from public.pran_not_card_reviews
         where user_id = v_user and reviewed_at >= v_today::timestamptz),
    'due_cards', (select count(*) from public.pran_not_flashcards
         where user_id = v_user and suspended = false and due_at <= now()),
    'notes_total', (select count(*) from public.pran_not_notes where user_id = v_user),
    'streak', (select to_jsonb(s) - 'user_id' from public.pran_not_streaks s where s.user_id = v_user),
    'xp', (select xp from public.pran_not_profiles where id = v_user),
    'level', (select xp_level from public.pran_not_profiles where id = v_user),
    'upcoming_assignments', coalesce((
        select jsonb_agg(x order by x.due_at) from (
          select a.id, a.title, a.due_at, a.status, c.name as course_name
            from public.pran_not_assignments a left join public.pran_not_courses c on c.id = a.course_id
           where a.user_id = v_user and a.status in ('todo','in_progress')
             and a.due_at is not null and a.due_at >= now() - interval '1 day'
           order by a.due_at limit 5) x), '[]'::jsonb),
    'at_risk_courses', coalesce((
        select jsonb_agg(x) from (
          select id, name, mastery, exam_date, color from public.pran_not_courses
           where user_id = v_user and archived = false and mastery < 50
             and (exists (select 1 from public.pran_not_syllabus_units u where u.course_id = pran_not_courses.id)
                  or exists (select 1 from public.pran_not_flashcards f where f.course_id = pran_not_courses.id))
           order by mastery asc limit 3) x), '[]'::jsonb),
    'badges_recent', coalesce((
        select jsonb_agg(x) from (
          select b.id, b.name_fr, b.name_ht, b.icon, ub.earned_at
            from public.pran_not_user_badges ub join public.pran_not_badges b on b.id = ub.badge_id
           where ub.user_id = v_user order by ub.earned_at desc limit 4) x), '[]'::jsonb)
  );
end;
$$;

-- =====================================================================
-- RECHERCHE GLOBALE
-- Retourne notes, cartes et cours correspondant à la requête.
-- SECURITY INVOKER : la RLS s'applique.
-- =====================================================================
create or replace function public.pran_not_search_all(q text, max_results int default 30)
returns table (kind text, id uuid, title text, snippet text, course_id uuid, rank real)
language sql
stable
security invoker
set search_path = public
as $$
  with query as (
    select websearch_to_tsquery('simple', q) as tsq, '%' || replace(replace(q, '%', ''), '_', '') || '%' as pat
  )
  (
    select 'note'::text, n.id, n.title,
           ts_headline('simple', coalesce(n.summary, '') || ' ' || left(n.content_text, 2000), query.tsq,
                       'StartSel=<mark>,StopSel=</mark>,MaxWords=24,MinWords=8,MaxFragments=1'),
           n.course_id, ts_rank(n.search, query.tsq)
      from public.pran_not_notes n, query
     where n.user_id = auth.uid() and (n.search @@ query.tsq or n.title ilike query.pat)
  )
  union all
  (
    select 'card'::text, f.id, left(f.front, 140), left(f.back, 200), f.course_id, 0.5::real
      from public.pran_not_flashcards f, query
     where f.user_id = auth.uid() and (f.front ilike query.pat or f.back ilike query.pat)
     limit 15
  )
  union all
  (
    select 'course'::text, c.id, c.name, coalesce(c.professor, ''), c.id, 1.0::real
      from public.pran_not_courses c, query
     where c.user_id = auth.uid() and (c.name ilike query.pat or coalesce(c.professor,'') ilike query.pat)
  )
  order by 6 desc
  limit greatest(1, least(max_results, 100));
$$;

-- =====================================================================
-- QUOTA IA DE L'UTILISATEUR (lecture côté client)
-- =====================================================================
create or replace function public.pran_not_ai_quota_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'used', (select count(*) from public.pran_not_ai_usage
              where user_id = auth.uid() and cached = false and success = true
                and created_at >= date_trunc('day', now())),
    'quota', coalesce((select ai_daily_quota from public.pran_not_profiles where id = auth.uid()), 60)
  );
$$;

-- =====================================================================
-- STATISTIQUES ADMIN (vérifie pran_not_is_admin)
-- =====================================================================
create or replace function public.pran_not_admin_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.pran_not_is_admin() then
    raise exception 'forbidden';
  end if;
  return jsonb_build_object(
    'users_total', (select count(*) from public.pran_not_profiles),
    'users_active_7d', (select count(*) from public.pran_not_profiles where last_seen_at >= now() - interval '7 days'),
    'users_new_7d', (select count(*) from public.pran_not_profiles where created_at >= now() - interval '7 days'),
    'notes_total', (select count(*) from public.pran_not_notes),
    'cards_total', (select count(*) from public.pran_not_flashcards),
    'reviews_7d', (select count(*) from public.pran_not_card_reviews where reviewed_at >= now() - interval '7 days'),
    'tests_7d', (select count(*) from public.pran_not_test_attempts where created_at >= now() - interval '7 days'),
    'ai_calls_today', (select count(*) from public.pran_not_ai_usage where created_at >= date_trunc('day', now())),
    'ai_errors_today', (select count(*) from public.pran_not_ai_usage where created_at >= date_trunc('day', now()) and success = false),
    'reports_open', (select count(*) from public.pran_not_content_reports where status = 'open'),
    'by_faculty', coalesce((select jsonb_agg(x) from (
        select coalesce(faculty_id, 'none') as faculty, count(*) as total
          from public.pran_not_profiles group by 1 order by 2 desc) x), '[]'::jsonb),
    'signups_30d', coalesce((select jsonb_agg(x order by x.day) from (
        select created_at::date as day, count(*) as total
          from public.pran_not_profiles where created_at >= now() - interval '30 days'
         group by 1) x), '[]'::jsonb)
  );
end;
$$;

-- Rejoindre un groupe par code d'invitation
create or replace function public.pran_not_join_group(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  select id into v_group from public.pran_not_study_groups where invite_code = upper(trim(p_code));
  if v_group is null then
    raise exception 'invalid_code';
  end if;
  insert into public.pran_not_group_members (group_id, user_id, role) values (v_group, auth.uid(), 'viewer')
  on conflict do nothing;
  return v_group;
end;
$$;

-- Le créateur d'un groupe en devient automatiquement propriétaire
create or replace function public.pran_not_after_group_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pran_not_group_members (group_id, user_id, role) values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return null;
end;
$$;
drop trigger if exists trg_pran_not_after_group_created on public.pran_not_study_groups;
create trigger trg_pran_not_after_group_created after insert on public.pran_not_study_groups
  for each row execute function public.pran_not_after_group_created();

-- Désabonnement en un clic (appelé par l'Edge Function avec le jeton)
create or replace function public.pran_not_unsubscribe_by_token(p_token uuid, p_kind text default 'all')
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.pran_not_profiles
     set notify_email = case when p_kind in ('all','daily') then false else notify_email end,
         notify_weekly = case when p_kind in ('all','weekly') then false else notify_weekly end,
         notify_deadlines = case when p_kind in ('all','deadlines') then false else notify_deadlines end,
         notify_whatsapp = case when p_kind in ('all','whatsapp') then false else notify_whatsapp end
   where unsubscribe_token = p_token;
  return found;
end;
$$;

-- Droits d'exécution des RPC et fonctions internes (aucun accès anon)
revoke execute on function public.pran_not_set_updated_at() from public, anon, authenticated;
revoke execute on function public.pran_not_notes_before_write() from public, anon, authenticated;
revoke execute on function public.pran_not_sync_question_count() from public, anon, authenticated;
revoke execute on function public.pran_not_handle_new_user() from public, anon, authenticated;
revoke execute on function public.pran_not_after_card_review() from public, anon, authenticated;
revoke execute on function public.pran_not_after_test_attempt() from public, anon, authenticated;
revoke execute on function public.pran_not_after_group_created() from public, anon, authenticated;
revoke execute on function public.pran_not_user_today(uuid) from public, anon, authenticated;
revoke execute on function public.pran_not_xp_to_level(int) from public, anon, authenticated;
revoke execute on function public.pran_not_recompute_unit_mastery(uuid) from public, anon, authenticated;
revoke execute on function public.pran_not_recompute_course_mastery(uuid) from public, anon, authenticated;
revoke execute on function public.pran_not_award_xp_internal(uuid, int, text, uuid) from public, anon, authenticated;
revoke execute on function public.pran_not_build_daily_plan(uuid, date) from public, anon, authenticated;
revoke execute on function public.pran_not_check_badges(uuid) from public, anon, authenticated;
revoke execute on function public.pran_not_unsubscribe_by_token(uuid, text) from public, anon, authenticated;
grant execute on function public.pran_not_unsubscribe_by_token(uuid, text) to service_role;

revoke execute on function public.pran_not_ensure_profile() from public, anon;
revoke execute on function public.pran_not_record_activity() from public, anon;
revoke execute on function public.pran_not_award_xp(int, text, uuid) from public, anon;
revoke execute on function public.pran_not_get_daily_plan() from public, anon;
revoke execute on function public.pran_not_refresh_daily_plan() from public, anon;
revoke execute on function public.pran_not_complete_plan_task(text) from public, anon;
revoke execute on function public.pran_not_get_dashboard_stats() from public, anon;
revoke execute on function public.pran_not_search_all(text, int) from public, anon;
revoke execute on function public.pran_not_ai_quota_status() from public, anon;
revoke execute on function public.pran_not_admin_stats() from public, anon;
revoke execute on function public.pran_not_join_group(text) from public, anon;
revoke execute on function public.pran_not_is_admin() from public, anon;

grant execute on function public.pran_not_ensure_profile() to authenticated;
grant execute on function public.pran_not_record_activity() to authenticated;
grant execute on function public.pran_not_award_xp(int, text, uuid) to authenticated;
grant execute on function public.pran_not_get_daily_plan() to authenticated;
grant execute on function public.pran_not_refresh_daily_plan() to authenticated;
grant execute on function public.pran_not_complete_plan_task(text) to authenticated;
grant execute on function public.pran_not_get_dashboard_stats() to authenticated;
grant execute on function public.pran_not_search_all(text, int) to authenticated;
grant execute on function public.pran_not_ai_quota_status() to authenticated;
grant execute on function public.pran_not_admin_stats() to authenticated;
grant execute on function public.pran_not_join_group(text) to authenticated;
grant execute on function public.pran_not_is_admin() to authenticated;
