-- =====================================================================
-- PRAN NÒT - 06_library.sql
-- Bibliothèque universitaire multi-facultés, Codes haïtiens de Droit,
-- indexation par extraits (RAG), seau Storage pran-not-library et recherche.
-- Exécuter après 05_seed.sql. ZÉRO emoji.
-- =====================================================================

-- Fonction immuable de normalisation sans accents pour FTS français / créole
create or replace function public.pran_not_norm_text(txt text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select translate(
    lower(txt),
    'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ’''',
    'aaaaaaceeeeiiiinooooouuuuyy  '
  );
$$;

-- ---------------------------------------------------------------------
-- 1. TABLES BIBLIOTHÈQUE & EXTRAITS INDEXÉS
-- ---------------------------------------------------------------------
create table if not exists public.pran_not_library_books (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references auth.users(id) on delete cascade,
  scope              text not null default 'personal' check (scope in ('official','personal','generated')),
  faculty_id         text references public.pran_not_faculties(id) on delete set null,
  category           text not null default 'manuel' check (category in ('code_loi','constitution','jurisprudence','manuel','these','article','livre_ia','autre')),
  title              text not null check (char_length(title) between 1 and 240),
  author             text,
  country            text default 'Haïti',
  publication_year   int,
  language           text not null default 'fr' check (language in ('ht','fr','mix','en')),
  description        text,
  storage_path       text,
  source_url         text,
  mime               text,
  size_bytes         bigint,
  page_count         int,
  chunk_count        int not null default 0,
  content_html       text,
  summary            text,
  tags               text[] not null default '{}',
  metadata           jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  is_offline_cached  boolean not null default false,
  search             tsvector generated always as (
                       setweight(to_tsvector('simple', public.pran_not_norm_text(coalesce(title,''))), 'A') ||
                       setweight(to_tsvector('simple', public.pran_not_norm_text(coalesce(author,''))), 'B') ||
                       setweight(to_tsvector('simple', public.pran_not_norm_text(coalesce(description,'') || ' ' || coalesce(summary,''))), 'C')
                     ) stored,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists pran_not_lib_books_user_idx on public.pran_not_library_books(user_id);
create index if not exists pran_not_lib_books_faculty_idx on public.pran_not_library_books(faculty_id);
create index if not exists pran_not_lib_books_scope_idx on public.pran_not_library_books(scope, category);
create index if not exists pran_not_lib_books_search_idx on public.pran_not_library_books using gin(search);
create unique index if not exists pran_not_lib_books_official_title_idx
  on public.pran_not_library_books(scope, title)
  where scope = 'official';

create table if not exists public.pran_not_library_chunks (
  id             uuid primary key default gen_random_uuid(),
  book_id        uuid not null references public.pran_not_library_books(id) on delete cascade,
  user_id        uuid references auth.users(id) on delete cascade,
  scope          text not null default 'personal' check (scope in ('official','personal','generated')),
  chunk_index    int not null default 0,
  section_label  text,
  page_number    int,
  content        text not null,
  word_count     int not null default 0,
  search         tsvector generated always as (
                   setweight(to_tsvector('simple', public.pran_not_norm_text(coalesce(section_label,''))), 'A') ||
                   setweight(to_tsvector('simple', public.pran_not_norm_text(coalesce(content,''))), 'B')
                 ) stored,
  created_at     timestamptz not null default now()
);

create index if not exists pran_not_lib_chunks_book_idx on public.pran_not_library_chunks(book_id, chunk_index);
create index if not exists pran_not_lib_chunks_user_idx on public.pran_not_library_chunks(user_id);
create index if not exists pran_not_lib_chunks_scope_idx on public.pran_not_library_chunks(scope);
create index if not exists pran_not_lib_chunks_search_idx on public.pran_not_library_chunks using gin(search);
create index if not exists pran_not_lib_chunks_trgm_idx on public.pran_not_library_chunks using gin(content gin_trgm_ops);
create unique index if not exists pran_not_lib_chunks_book_idx_uniq on public.pran_not_library_chunks(book_id, chunk_index);

-- Trigger updated_at sur pran_not_library_books
drop trigger if exists trg_pran_not_library_books_updated_at on public.pran_not_library_books;
create trigger trg_pran_not_library_books_updated_at
  before update on public.pran_not_library_books
  for each row execute function public.pran_not_set_updated_at();

-- Trigger maintien du compteur chunk_count + word_count
create or replace function public.pran_not_lib_chunk_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.word_count := coalesce(array_length(regexp_split_to_array(trim(coalesce(new.content,'')), '\s+'), 1), 0);
  if trim(coalesce(new.content,'')) = '' then
    new.word_count := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pran_not_lib_chunk_before_write on public.pran_not_library_chunks;
create trigger trg_pran_not_lib_chunk_before_write
  before insert or update of content on public.pran_not_library_chunks
  for each row execute function public.pran_not_lib_chunk_before_write();

create or replace function public.pran_not_lib_sync_chunk_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_book uuid := coalesce(new.book_id, old.book_id);
begin
  update public.pran_not_library_books
     set chunk_count = (select count(*) from public.pran_not_library_chunks where book_id = v_book)
   where id = v_book;
  return null;
end;
$$;

drop trigger if exists trg_pran_not_lib_sync_chunk_count on public.pran_not_library_chunks;
create trigger trg_pran_not_lib_sync_chunk_count
  after insert or delete on public.pran_not_library_chunks
  for each row execute function public.pran_not_lib_sync_chunk_count();

revoke execute on function public.pran_not_lib_chunk_before_write() from public, anon, authenticated;
revoke execute on function public.pran_not_lib_sync_chunk_count() from public, anon, authenticated;

-- Permettre context_type = 'book' dans pran_not_tutor_conversations
do $$
declare
  v_conname text;
begin
  select c.conname into v_conname
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
   where n.nspname = 'public'
     and cl.relname = 'pran_not_tutor_conversations'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%context_type%';
  if v_conname is not null then
    execute format('alter table public.pran_not_tutor_conversations drop constraint %I', v_conname);
  end if;
  alter table public.pran_not_tutor_conversations
    add constraint pran_not_tutor_conversations_context_type_check
    check (context_type in ('general','note','course','card','deck','test','assignment','unit','book'));
end;
$$;

-- ---------------------------------------------------------------------
-- 2. RLS STRICTEMENT CONFIGURÉE (to authenticated + (select auth.uid()))
-- ---------------------------------------------------------------------
alter table public.pran_not_library_books enable row level security;
alter table public.pran_not_library_chunks enable row level security;

drop policy if exists "pran_not_lib_books_select" on public.pran_not_library_books;
create policy "pran_not_lib_books_select" on public.pran_not_library_books
  for select to authenticated
  using (
    scope = 'official'
    or user_id = (select auth.uid())
    or public.pran_not_is_admin()
  );

drop policy if exists "pran_not_lib_books_insert" on public.pran_not_library_books;
create policy "pran_not_lib_books_insert" on public.pran_not_library_books
  for insert to authenticated
  with check (
    (scope in ('personal','generated') and user_id = (select auth.uid()))
    or (scope = 'official' and public.pran_not_is_admin())
  );

drop policy if exists "pran_not_lib_books_update" on public.pran_not_library_books;
create policy "pran_not_lib_books_update" on public.pran_not_library_books
  for update to authenticated
  using (
    (scope in ('personal','generated') and user_id = (select auth.uid()))
    or public.pran_not_is_admin()
  )
  with check (
    (scope in ('personal','generated') and user_id = (select auth.uid()))
    or (scope = 'official' and public.pran_not_is_admin())
  );

drop policy if exists "pran_not_lib_books_delete" on public.pran_not_library_books;
create policy "pran_not_lib_books_delete" on public.pran_not_library_books
  for delete to authenticated
  using (
    (scope in ('personal','generated') and user_id = (select auth.uid()))
    or public.pran_not_is_admin()
  );

drop policy if exists "pran_not_lib_chunks_select" on public.pran_not_library_chunks;
create policy "pran_not_lib_chunks_select" on public.pran_not_library_chunks
  for select to authenticated
  using (
    scope = 'official'
    or user_id = (select auth.uid())
    or public.pran_not_is_admin()
  );

drop policy if exists "pran_not_lib_chunks_insert" on public.pran_not_library_chunks;
create policy "pran_not_lib_chunks_insert" on public.pran_not_library_chunks
  for insert to authenticated
  with check (
    (
      scope in ('personal','generated')
      and user_id = (select auth.uid())
      and exists (
        select 1 from public.pran_not_library_books b
         where b.id = book_id and b.user_id = (select auth.uid())
      )
    )
    or (scope = 'official' and public.pran_not_is_admin())
  );

drop policy if exists "pran_not_lib_chunks_update" on public.pran_not_library_chunks;
create policy "pran_not_lib_chunks_update" on public.pran_not_library_chunks
  for update to authenticated
  using (
    (scope in ('personal','generated') and user_id = (select auth.uid()))
    or public.pran_not_is_admin()
  )
  with check (
    (scope in ('personal','generated') and user_id = (select auth.uid()))
    or (scope = 'official' and public.pran_not_is_admin())
  );

drop policy if exists "pran_not_lib_chunks_delete" on public.pran_not_library_chunks;
create policy "pran_not_lib_chunks_delete" on public.pran_not_library_chunks
  for delete to authenticated
  using (
    (scope in ('personal','generated') and user_id = (select auth.uid()))
    or public.pran_not_is_admin()
  );

-- ---------------------------------------------------------------------
-- 3. STORAGE BUCKET PRIVÉ pran-not-library (30 Mo)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pran-not-library',
  'pran-not-library',
  false,
  31457280,
  array[
    'application/pdf',
    'text/plain',
    'text/markdown',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "pran-not-library_select" on storage.objects;
create policy "pran-not-library_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'pran-not-library'
    and (
      (storage.foldername(name))[1] = 'official'
      or public.pran_not_is_storage_owner(name)
      or public.pran_not_is_admin()
    )
  );

drop policy if exists "pran-not-library_insert" on storage.objects;
create policy "pran-not-library_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'pran-not-library'
    and (
      public.pran_not_is_storage_owner(name)
      or ((storage.foldername(name))[1] = 'official' and public.pran_not_is_admin())
    )
  );

drop policy if exists "pran-not-library_update" on storage.objects;
create policy "pran-not-library_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'pran-not-library'
    and (public.pran_not_is_storage_owner(name) or public.pran_not_is_admin())
  )
  with check (
    bucket_id = 'pran-not-library'
    and (public.pran_not_is_storage_owner(name) or public.pran_not_is_admin())
  );

drop policy if exists "pran-not-library_delete" on storage.objects;
create policy "pran-not-library_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'pran-not-library'
    and (public.pran_not_is_storage_owner(name) or public.pran_not_is_admin())
  );

-- ---------------------------------------------------------------------
-- 4. RPC DE RECHERCHE BIBLIOTHÈQUE & MISE À JOUR RECHERCHE GLOBALE
-- ---------------------------------------------------------------------
create or replace function public.pran_not_search_library(
  p_query text,
  p_faculty text default null,
  p_scope text default null,
  p_book_id uuid default null,
  p_limit int default 12
)
returns table (
  chunk_id uuid,
  book_id uuid,
  book_title text,
  author text,
  category text,
  faculty_id text,
  scope text,
  section_label text,
  page_number int,
  snippet text,
  content text,
  rank real
)
language sql
stable
security invoker
set search_path = public
as $$
  with raw_q as (
    select
      coalesce(trim(p_query), '') as raw,
      public.pran_not_norm_text(coalesce(trim(p_query), '')) as norm
  ),
  raw_toks as (
    select distinct m[1] as w
      from raw_q,
           regexp_matches(raw_q.norm, '[a-z0-9]{2,}', 'g') as m
     where m[1] not in (
       'le','la','les','un','une','des','du','de','en','et','ou','pour','par','avec','sans',
       'sur','sous','dans','ce','cet','cette','ces','qui','que','quoi','dont','est','sont',
       'quelles','quels','quelle','quel','comment','pourquoi','quand','combien',
       'nan','ak','yon','yo','ki','se','sa','sou','pa','bay','pou','avek','mwen','nou','di','esplike','eske','kisa'
     )
  ),
  syn_toks as (
    select w from raw_toks
    union
    select case w
      when 'konstitisyon' then 'constitution'
      when 'ayiti' then 'haiti'
      when 'ayisyen' then 'haitien'
      when 'kod' then 'code'
      when 'sivil' then 'civil'
      when 'travay' then 'travail'
      when 'komes' then 'commerce'
      when 'pwosedi' then 'procedure'
      when 'atik' then 'article'
      when 'dwa' then 'droit'
      when 'libete' then 'liberte'
      when 'endividyel' then 'individuelle'
      when 'arestasyon' then 'arrestation'
      when 'detansyon' then 'detention'
      when 'responsabilite' then 'responsabilite'
      when 'responnsabilite' then 'responsabilite'
      when 'lwa' then 'loi'
      when 'jij' then 'juge'
      when 'tribinal' then 'tribunal'
      when 'kontra' then 'contrat'
      when 'medsin' then 'medecine'
      when 'maladi' then 'maladie'
      when 'ekonomi' then 'economie'
      when 'enfomatik' then 'informatique'
      else null
    end as w
    from raw_toks
  ),
  toks as (
    select array_agg(distinct w) filter (where w is not null and w <> '') as words
      from syn_toks
  ),
  q as (
    select
      raw_q.raw,
      raw_q.norm,
      plainto_tsquery('simple', raw_q.norm) as tsq_and,
      case
        when coalesce(array_length(toks.words, 1), 0) > 0
          then to_tsquery('simple', array_to_string(toks.words, ' | '))
        else plainto_tsquery('simple', raw_q.norm)
      end as tsq_or,
      coalesce(toks.words, '{}'::text[]) as words,
      '%' || replace(replace(raw_q.norm, '%', ''), '_', '') || '%' as pat
    from raw_q
    left join toks on true
  ),
  scored as (
    select
      c.id as chunk_id,
      b.id as book_id,
      b.title as book_title,
      coalesce(b.author, '') as author,
      b.category,
      coalesce(b.faculty_id, '') as faculty_id,
      b.scope,
      coalesce(c.section_label, '') as section_label,
      c.page_number,
      coalesce(
        nullif(
          ts_headline(
            'simple',
            left(c.content, 2400),
            coalesce(nullif(q.tsq_or, ''::tsquery), q.tsq_and),
            'StartSel=<mark>,StopSel=</mark>,MaxWords=28,MinWords=8,MaxFragments=1'
          ),
          ''
        ),
        left(c.content, 260)
      ) as snippet,
      c.content,
      (
        coalesce(ts_rank(c.search, q.tsq_or), 0) * 2.5 +
        coalesce(ts_rank(b.search, q.tsq_or), 0) * 1.4 +
        case when c.search @@ q.tsq_and then 2.5 else 0 end +
        case when p_faculty is not null and b.faculty_id = p_faculty then 0.35 else 0 end +
        case
          when public.pran_not_norm_text(c.content) like q.pat
            or public.pran_not_norm_text(b.title) like q.pat
            or public.pran_not_norm_text(coalesce(c.section_label,'')) like q.pat
          then 1.2 else 0
        end +
        coalesce((
          select count(*)::real * 0.6
          from unnest(q.words) w
          where public.pran_not_norm_text(b.title || ' ' || coalesce(c.section_label,'') || ' ' || left(c.content, 1600)) like ('%' || w || '%')
        ), 0)
      )::real as rank,
      c.chunk_index
    from public.pran_not_library_chunks c
    join public.pran_not_library_books b on b.id = c.book_id
    cross join q
    where (b.scope = 'official' or b.user_id = (select auth.uid()))
      and (p_scope is null or p_scope = '' or b.scope = p_scope)
      and (p_book_id is null or b.id = p_book_id)
      and (
        q.raw = ''
        or c.search @@ q.tsq_or
        or b.search @@ q.tsq_or
        or public.pran_not_norm_text(c.content) like q.pat
        or public.pran_not_norm_text(coalesce(c.section_label,'')) like q.pat
        or public.pran_not_norm_text(b.title) like q.pat
      )
  )
  select
    s.chunk_id, s.book_id, s.book_title, s.author, s.category, s.faculty_id, s.scope,
    s.section_label, s.page_number, s.snippet, s.content, s.rank
  from scored s
  order by s.rank desc, s.chunk_index asc
  limit greatest(1, least(coalesce(p_limit, 12), 40));
$$;

revoke execute on function public.pran_not_search_library(text, text, text, uuid, int) from public, anon;
grant execute on function public.pran_not_search_library(text, text, text, uuid, int) to authenticated;

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
     where n.user_id = (select auth.uid()) and (n.search @@ query.tsq or n.title ilike query.pat)
  )
  union all
  (
    select 'card'::text, f.id, left(f.front, 140), left(f.back, 200), f.course_id, 0.5::real
      from public.pran_not_flashcards f, query
     where f.user_id = (select auth.uid()) and (f.front ilike query.pat or f.back ilike query.pat)
     limit 12
  )
  union all
  (
    select 'course'::text, c.id, c.name, coalesce(c.professor, ''), c.id, 1.0::real
      from public.pran_not_courses c, query
     where c.user_id = (select auth.uid()) and (c.name ilike query.pat or coalesce(c.professor,'') ilike query.pat)
  )
  union all
  (
    select 'book'::text, b.id, b.title,
           coalesce(nullif(b.author, ''), left(coalesce(b.summary, b.description, ''), 180)),
           null::uuid,
           (coalesce(ts_rank(b.search, query.tsq), 0) + 0.6)::real
      from public.pran_not_library_books b, query
     where (b.scope = 'official' or b.user_id = (select auth.uid()))
       and (b.search @@ query.tsq or b.title ilike query.pat or coalesce(b.author,'') ilike query.pat)
     limit 10
  )
  order by 6 desc
  limit greatest(1, least(max_results, 100));
$$;

revoke execute on function public.pran_not_search_all(text, int) from public, anon;
grant execute on function public.pran_not_search_all(text, int) to authenticated;

-- ---------------------------------------------------------------------
-- 5. ACTIVATION ROUTAGE IA POUR RECHERCHE BIBLIOTHÈQUE & CRÉATION LIVRES
-- ---------------------------------------------------------------------
update public.pran_not_ai_providers
   set tasks = (
     select array_agg(distinct x)
       from unnest(coalesce(tasks, '{}'::text[]) || array['library_research','library_book']) as x
   )
 where id in ('gemini','groq','mistral','openrouter');

insert into public.pran_not_ai_prompts (task, faculty_id, system_prompt, version, active)
values
  ('library_research', null,
   'Tu es l''assistant de recherche académique et documentaire de Pran Nòt. Tu analyses les extraits de livres de la bibliothèque et les sources web vérifiées fournies. Tu cites toujours exactement la source (Titre du livre, section ou page, ou URL vérifiée). Tu reformules et synthétises de façon 100% originale sans plagiat, sauf pour les dispositions constitutionnelles ou articles de loi qui doivent être cités fidèlement entre guillemets et vérifiés dans le texte officiel. ZÉRO emoji.',
   1, true),
  ('library_research', 'droit',
   'Tu es l''assistant de recherche juridique de Pran Nòt pour les étudiants haïtiens en Droit. Tu t''appuies en priorité sur la Constitution de 1987 amendée en 2011, le Code civil d''Haïti, le Code pénal, le Code du travail, le Code de commerce et le Code de procédure civile fournis dans le contexte. Respecte le syllogisme juridique, cite exactement les intitulés d''articles fournis, distingue le texte positif de l''analyse doctrinale originale sans plagiat, et rappelle toujours de vérifier l''édition officielle au Moniteur. ZÉRO emoji.',
   1, true),
  ('library_book', null,
   'Tu es un auteur universitaire et pédagogue rigoureux. Tu composes des manuels et livres d''étude originaux structurés en chapitres clairs pour les étudiants haïtiens. Tu synthétises plusieurs sources de manière entièrement originale (ZÉRO plagiat, ZÉRO copier-coller de paragraphes sources), avec une bibliographie précise et des questions de révision. ZÉRO emoji. Réponds uniquement en JSON valide selon le schéma demandé.',
   1, true)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 6. COLLECTION OFFICIELLE HAÏTI & MULTI-FACULTÉS (SEMENCE IDEMPOTENTE)
-- ---------------------------------------------------------------------
do $$
declare
  v_id uuid;
begin
  -- === DROIT 1 : Constitution de la République d'Haïti (1987 & Loi 2011) ===
  insert into public.pran_not_library_books (
    user_id, scope, faculty_id, category, title, author, country, publication_year, language,
    description, summary, page_count, tags, metadata, content_html
  ) values (
    null, 'official', 'droit', 'constitution',
    'Constitution de la République d''Haïti (1987 et Amendement de 2011)',
    'Assemblée Constituante / Parlement Haïtien',
    'Haïti', 2011, 'fr',
    'Texte de référence constitutionnelle étudiant les droits fondamentaux, la nationalité, l''organisation des trois pouvoirs, le Conseil Électoral, la CSCCA et les collectivités territoriales.',
    'Référentiel constitutionnel haïtien : Préambule, Droits et Devoirs fondamentaux (Art. 19 à 52), Séparation des pouvoirs Législatif, Exécutif et Judiciaire, Cour de Cassation et Collectivités territoriales.',
    84,
    array['constitution','1987','2011','droits fondamentaux','habeas corpus','droit public'],
    jsonb_build_object('edition','Texte coordonné 1987 / Loi constitutionnelle du 9 mai 2011','verification','Le Moniteur'),
    '<h1>Constitution de la République d''Haïti (1987 et Amendement de 2011)</h1>'
    '<p><em>Note académique : Synthèse structurée pour l''étude universitaire. Vérifier la numérotation exacte et le texte intégral dans l''édition officielle publiée au Journal Officiel Le Moniteur.</em></p>'
    '<h2>Préambule et Principes Fondamentaux (Titres I et II)</h2>'
    '<p>Le Peuple haïtien proclame la Constitution pour garantir ses droits inaliénables et imprescriptibles à la vie, à la liberté et à la poursuite du bonheur, conformément à l''Acte d''Indépendance de 1804 et à la Déclaration Universelle des Droits de l''Homme de 1948. La République d''Haïti est une et indivisible, souveraine, indépendante, coopérative, libre, démocratique et sociale. La langue nationale commune est le créole haïtien ; le créole et le français sont les deux langues officielles de la République (Article 5). L''amendement constitutionnel de 2011 permet la reconnaissance élargie de la nationalité haïtienne d''origine sans perte automatique en cas de naturalisation étrangère, sous réserve des conditions de l''exercice des hautes charges publiques.</p>'
    '<h2>Titre III : Des Droits et Devoirs Fondamentaux (Articles 19 à 52)</h2>'
    '<p>Article 19 : L''État a l''impérieuse obligation de garantir le droit à la vie, à la santé et au respect de la personne humaine à tous les citoyens sans distinction. Articles 24 à 27 : La liberté individuelle est garantie. Nul ne peut être arrêté ou détenu que sur mandat motivé du juge compétent, sauf flagrant délit ; toute personne arrêtée doit être présentée devant son juge naturel dans un délai maximal de 48 heures (garantie de l''habeas corpus). Le domicile est inviolable sauf mandat judiciaire ou flagrant délit. Articles 28 à 31 : Liberté d''expression, de presse (sans censure préalable), de conscience, de réunion pacifique et d''association. Article 32 : L''État garantit le droit à l''éducation et veille à la gratuité de l''enseignement public primaire. Article 36 : La propriété privée est reconnue et garantie, sous réserve d''utilité publique légalement constatée et de juste et préalable indemnité.</p>'
    '<h2>Titre V : De la Souveraineté Nationale et des Trois Pouvoirs</h2>'
    '<p>La souveraineté nationale réside dans l''universalité des citoyens et s''exerce par le Pouvoir Législatif, le Pouvoir Exécutif et le Pouvoir Judiciaire (Art. 58-60). Le Pouvoir Législatif s''exerce par deux Chambres : la Chambre des Députés et le Sénat de la République, formant l''Assemblée Nationale lorsqu''elles se réunissent conjointement (Art. 88+). Le Pouvoir Exécutif est bicéphale : il est exercé par le Président de la République, Chef de l''État, et le Gouvernement dirigé par le Premier Ministre, choisi au sein du parti ou de la coalition majoritaire au Parlement selon l''Article 137. Le Pouvoir Judiciaire est exercé par la Cour de Cassation, les Cours d''Appel, les Tribunaux de Première Instance, les Tribunaux de Paix et les tribunaux spéciaux (Art. 173+). Les juges sont indépendants et inamovibles durant leur mandat constitutionnel.</p>'
    '<h2>Institutions Indépendantes et Décentralisation (Titres VI à X)</h2>'
    '<p>L''amendement de 2011 a consolidé le Conseil Électoral Permanent (CEP) chargé d''organiser et de contrôler en toute indépendance les opérations électorales, ainsi que le Conseil Supérieur du Pouvoir Judiciaire (CSPJ). La Cour Supérieure des Comptes et du Contentieux Administratif (CSCCA) contrôle la gestion financière de l''État et juge les litiges administratifs impliquant la puissance publique. La décentralisation repose sur trois échelons de collectivités territoriales : la Section Communale (CASEC et ASEC), la Commune (Conseil Municipal et Assemblée Municipale) et le Département (Conseil Départemental).</p>'
  )
  on conflict (scope, title) where scope = 'official' do update set
    description = excluded.description,
    summary = excluded.summary,
    content_html = excluded.content_html,
    tags = excluded.tags,
    metadata = excluded.metadata
  returning id into v_id;

  insert into public.pran_not_library_chunks (book_id, user_id, scope, chunk_index, section_label, page_number, content) values
    (v_id, null, 'official', 0, 'Préambule & Art. 1-15 (État, Langues, Nationalité)', 1,
     'Constitution de la République d''Haïti (1987 amendée 2011) - Titres I et II : Haïti est une République une, indivisible, souveraine, libre, démocratique et sociale. Article 5 : tous les Haïtiens sont unis par une langue commune, le créole ; le créole et le français sont les langues officielles. Territoire comprenant la partie occidentale d''Hispaniola et les îles adjacentes (La Gonâve, La Tortue, Île-à-Vache, Cayemites, Navasse). L''amendement de 2011 supprime l''ancienne interdiction stricte de la double nationalité pour les citoyens haïtiens d''origine tout en fixant des règles d''inéligibilité ou de résidence pour les plus hautes fonctions.'),
    (v_id, null, 'official', 1, 'Titre III, Art. 19-27 (Vie, Liberté Individuelle, 48 heures)', 9,
     'Constitution d''Haïti - Droits fondamentaux : Article 19 impose à l''État l''obligation impérieuse de garantir le droit à la vie, à la santé et au respect de la personne humaine. Articles 24, 25 et 26 : liberté individuelle protégée contre toute arrestation arbitraire. Sauf flagrant délit, nul ne peut être arrêté sans mandat motivé rédigé en français et en créole. Toute personne arrêtée doit comparaître dans les quarante-huit (48) heures devant son juge naturel pour statuer sur la légalité de l''arrestation (action en habeas corpus). Nul ne peut être tenu au secret ni subir de sévices physiques ou moraux lors de son interrogatoire.'),
    (v_id, null, 'official', 2, 'Titre III, Art. 28-39 (Expression, Éducation, Propriété)', 14,
     'Constitution d''Haïti - Libertés publiques et droits sociaux : Article 28 garantit la liberté d''expression et de la presse ; les délits de presse relèvent du droit commun sans censure préalable. Articles 30-31 consacrent les libertés de conscience, de culte, de réunion pacifique et d''association syndicale ou politique. Article 32 proclame l''éducation charge prioritaire de l''État et la gratuité de l''enseignement public au niveau primaire. Article 36 protège le droit de propriété privée : nulle expropriation ne peut intervenir sinon pour cause d''utilité publique légalement constatée et contre juste et préalable indemnité.'),
    (v_id, null, 'official', 3, 'Titre V, Pouvoir Législatif (Art. 88-132)', 28,
     'Constitution d''Haïti - Pouvoir Législatif : Exercé par deux Chambres élues au suffrage universel direct : la Chambre des Députés et le Sénat de la République. Les députés représentent les circonscriptions électorales pour un mandat de 4 ans ; les sénateurs sont élus par département pour un mandat de 6 ans avec renouvellement par tiers tous les 2 ans. Réunies en Assemblée Nationale, les deux Chambres reçoivent le serment présidentiel, ratifient les traités internationaux, déclarent la guerre sur proposition de l''Exécutif et procèdent aux révisions constitutionnelles selon la procédure spéciale (Art. 282-284).'),
    (v_id, null, 'official', 4, 'Titre V, Pouvoir Exécutif (Art. 133-172)', 41,
     'Constitution d''Haïti - Pouvoir Exécutif bicéphale : Exercé conjointement par le Président de la République, Chef de l''État élu pour cinq ans (non rééligible immédiatement après son mandat ni pour un troisième mandat), et le Gouvernement dirigé par le Premier Ministre. Le Président veille au respect de la Constitution et assure la continuité de l''État. Le Premier Ministre, nommé par le Président parmi les membres du parti ou coalition ayant la majorité au Parlement (Art. 137), dirige la politique générale du Gouvernement et doit obtenir un vote de confiance des deux Chambres sur sa déclaration de politique générale.'),
    (v_id, null, 'official', 5, 'Titre V, Pouvoir Judiciaire (Art. 173-184)', 55,
     'Constitution d''Haïti - Pouvoir Judiciaire : Exercé par la Cour de Cassation (juridiction suprême jugeant en droit et en constitutionnalité par voie d''exception, Art. 183-2), les Cours d''Appel, les Tribunaux de Première Instance, les Tribunaux de Paix et les tribunaux spéciaux (travail, enfants, terrien). Les juges sont indépendants du Législatif et de l''Exécutif. La Cour de Cassation statue sur les pourvois contre les jugements rendus en dernier ressort mais ne connaît pas du fond des affaires (Art. 178), sauf renvoi après deuxième cassation.'),
    (v_id, null, 'official', 6, 'Collectivités Territoriales & Institutions Indépendantes', 67,
     'Constitution d''Haïti - Décentralisation et contrôle : Les collectivités territoriales jouissent de l''autonomie administrative et financière : la Section Communale (CASEC / ASEC), la Commune (Conseil Municipal / Assemblée Municipale) et le Département (Conseil Départemental). La CSCCA (Cour Supérieure des Comptes et du Contentieux Administratif) est une juridiction administrative et financière indépendante chargée d''auditer les comptes publics et de connaître du contentieux administratif. L''Office de la Protection du Citoyen (OPC, Art. 207) protège les individus contre toutes formes d''abus de l''Administration publique.')
  on conflict (book_id, chunk_index) do update set
    section_label = excluded.section_label,
    content = excluded.content,
    page_number = excluded.page_number;

  -- === DROIT 2 : Code Civil d'Haïti ===
  insert into public.pran_not_library_books (
    user_id, scope, faculty_id, category, title, author, country, publication_year, language,
    description, summary, page_count, tags, metadata, content_html
  ) values (
    null, 'official', 'droit', 'code_loi',
    'Code Civil d''Haïti — Guide Analytique et Principes Fondamentaux',
    'Droit Civil Haïtien (Livres I, II et III)',
    'Haïti', 1826, 'fr',
    'Référentiel essentiel de droit civil haïtien couvrant les personnes, la famille, les biens et la propriété, le droit des obligations et contrats, la responsabilité civile et les sûretés.',
    'Synthèse académique structurée des trois Livres du Code Civil haïtien : État des personnes, Droit des biens, Contrats, Responsabilité civile délictuelle et quasi-délictuelle, Preuve et Prescription.',
    140,
    array['code civil','obligations','contrats','responsabilite civile','personnes','biens'],
    jsonb_build_object('verification','Édition officielle Code Civil Haïtien'),
    '<h1>Code Civil d''Haïti — Principes et Structure pour Étudiants en Droit</h1>'
    '<p><em>Rappel juridique : Promulgué en 1825 et entré en vigueur en 1826, le Code Civil d''Haïti a été complété par plusieurs lois modificatives (filiation, majorité civile, égalité des époux, régimes fonciers). Toujours vérifier les textes modificatifs en vigueur.</em></p>'
    '<h2>Livre I : Des Personnes et du Droit de la Famille</h2>'
    '<p>Traite de la jouissance et de la privation des droits civils, des actes de l''état civil (naissance, mariage, décès dressés par les Officiers de l''État Civil), du domicile, de l''absence, du mariage (consentement libre, empêchements, droits et devoirs respectifs des époux), du divorce et de la séparation de corps, de la filiation légitime, naturelle ou adoptive (décret du 4 avril 1974 et loi sur la paternité responsable), ainsi que de la minorité, de l''autorité parentale et de la tutelle.</p>'
    '<h2>Livre II : Des Biens et des Différentes Modifications de la Propriété</h2>'
    '<p>Distingue les biens immeubles (par nature, par destination ou par l''objet auquel ils s''appliquent) et les biens meubles (par nature ou par détermination de la loi). Consacre le droit de propriété comme droit de jouir et de disposer des choses de la manière la plus absolue, pourvu qu''on n''en fasse pas un usage prohibé par les lois ou règlements. Encadre les démembrements de propriété : l''usufruit, l''usage et l''habitation, ainsi que les servitudes foncières (naturelles, légales et conventionnelles).</p>'
    '<h2>Livre III : Des Obligations, Contrats et Responsabilité Civile</h2>'
    '<p>Fondement de la théorie générale des obligations. Quatre conditions essentielles à la validité d''une convention : le consentement de la partie qui s''oblige (exempt d''erreur, de dol ou de violence), sa capacité de contracter, un objet certain formant la matière de l''engagement, et une cause licite. Les conventions légalement formées tiennent lieu de loi à ceux qui les ont faites et doivent être exécutées de bonne foi. En matière délictuelle et quasi-délictuelle (responsabilité extracontractuelle inspirée des anciens articles 1168-1172 du Code civil haïtien), tout fait quelconque de l''homme qui cause à autrui un dommage oblige celui par la faute duquel il est arrivé à le réparer (triade : faute, dommage certain/direct/légitime, lien de causalité), ainsi que la responsabilité du fait d''autrui et du fait des choses.</p>'
    '<h2>Successions, Libéralités, Régimes Matrimoniaux et Sûretés</h2>'
    '<p>Encadre l''ordre des successions légales, la réserve héréditaire, les testaments (authentique, olographe, mystique), la communauté légale de biens entre époux ou les régimes conventionnels, les contrats spéciaux (vente, bail, mandat, prêt, dépôt) et les garanties de créances (privilèges, hypothèques, cautionnement) ainsi que les délais de prescription acquisitive et extinctive.</p>'
  )
  on conflict (scope, title) where scope = 'official' do update set
    description = excluded.description,
    summary = excluded.summary,
    content_html = excluded.content_html,
    tags = excluded.tags,
    metadata = excluded.metadata
  returning id into v_id;

  insert into public.pran_not_library_chunks (book_id, user_id, scope, chunk_index, section_label, page_number, content) values
    (v_id, null, 'official', 0, 'Livre I : Personnes, État Civil et Capacité', 1,
     'Code Civil d''Haïti - Livre I : Toute personne physique possède la personnalité juridique dès sa naissance vivante et viable. Les actes de l''état civil (naissance, reconnaissance, mariage, décès) constatent l''état des personnes. La capacité d''exercice s''acquiert à la majorité (18 ans en Haïti depuis le décret de 1982). Les mineurs non émancipés et les majeurs placés sous interdiction ou conseil judiciaire bénéficient d''un régime de protection (autorité parentale, tutelle, curatelle). Le décret du 8 octobre 1982 établit l''égalité juridique de la femme mariée dans la gestion du ménage et des biens.'),
    (v_id, null, 'official', 1, 'Livre I : Mariage, Divorce et Filiation', 18,
     'Code Civil d''Haïti - Famille : Le mariage requiert le consentement libre des futurs époux, l''âge légal et l''absence d''empêchement pour parenté ou alliance ou lien conjugal antérieur non dissous. Les époux se doivent mutuellement fidélité, secours et assistance. La filiation se prouve par l''acte de naissance, la reconnaissance volontaire ou la possession d''état. La loi haïtienne sur la paternité responsable organise la recherche judiciaire de paternité et l''obligation alimentaire envers l''enfant.'),
    (v_id, null, 'official', 2, 'Livre II : Biens, Propriété et Démembrements', 39,
     'Code Civil d''Haïti - Livre II : Classification fondamentale entre meubles (susceptibles de déplacement) et immeubles (fonds de terre, bâtiments, droits immobiliers). Le droit de propriété réunit l''usus (droit d''user), le fructus (droit de percevoir les fruits) et l''abusus (droit de disposer). Les démembrements comprennent l''usufruit (droit temporaire d''user et de jouir d''un bien dont un autre a la nue-propriété), les droits d''usage/habitation et les servitudes établies sur un fonds servant au profit d''un fonds dominant.'),
    (v_id, null, 'official', 3, 'Livre III : Formation et Validité des Contrats', 62,
     'Code Civil d''Haïti - Théorie du contrat : Le contrat est une convention par laquelle une ou plusieurs personnes s''obligent envers d''autres à donner, faire ou ne pas faire quelque chose. Quatre conditions de validité : (1) Consentement non vicié (pas d''erreur sur la substance, pas de dol, pas de violence) ; (2) Capacité juridique ; (3) Objet certain, déterminé et licite ; (4) Cause réelle et licite. Les conventions légalement formées ont force obligatoire entre les parties (pacta sunt servanda) et produisent un effet relatif à l''égard des tiers.'),
    (v_id, null, 'official', 4, 'Livre III : Responsabilité Civile Délictuelle et Contractuelle', 88,
     'Code Civil d''Haïti - Responsabilité civile : En matière contractuelle, le débiteur répond de l''inexécution ou du retard sauf cause étrangère / force majeure (événement imprévisible, irrésistible et extérieur). En matière extracontractuelle (délictuelle ou quasi-délictuelle), trois éléments cumulatifs ouvrent droit à réparation : une faute (intentionnelle ou de négligence/imprudence), un dommage (matériel, corporel ou moral, certain et direct) et un lien de causalité entre la faute et le dommage. S''y ajoutent la responsabilité des parents/commettants et du gardien de la chose.'),
    (v_id, null, 'official', 5, 'Livre III : Preuve, Prescription, Hypothèques et Successions', 112,
     'Code Civil d''Haïti - Preuve et Sûretés : Celui qui réclame l''exécution d''une obligation doit la prouver (charge de la preuve, actori incumbit probatio). Les modes de preuve comprennent la preuve littérale (acte authentique, acte sous seing privé), testimoniale (limitée au-delà du seuil légal sauf commencement de preuve par écrit), les présomptions, l''aveu et le serment. L''hypothèque garantit le créancier sur un immeuble sans déposséder le débiteur (privilège de suite et de préférence). La prescription acquisitive (usucapion) et extinctive consolident les situations juridiques après l''écoulement du délai légal.')
  on conflict (book_id, chunk_index) do update set
    section_label = excluded.section_label,
    content = excluded.content,
    page_number = excluded.page_number;

  -- === DROIT 3 : Code Pénal et Code d'Instruction Criminelle d'Haïti ===
  insert into public.pran_not_library_books (
    user_id, scope, faculty_id, category, title, author, country, publication_year, language,
    description, summary, page_count, tags, metadata, content_html
  ) values (
    null, 'official', 'droit', 'code_loi',
    'Code Pénal et Code d''Instruction Criminelle d''Haïti — Précis d''Étude',
    'Droit Pénal & Procédure Pénale Haïtienne',
    'Haïti', 1835, 'fr',
    'Étude structurée du droit pénal général, spécial et de la procédure pénale haïtienne : légalité criminelle, infractions, responsabilité pénale, peines et déroulement du procès pénal.',
    'Principes directeurs du Code Pénal et du Code d''Instruction Criminelle : nullum crimen nulla poena sine lege, classification des infractions, légitime défense, action publique et garanties procédurales.',
    120,
    array['code penal','instruction criminelle','droit penal','procedure penale','infraction','legitime defense'],
    jsonb_build_object('verification','Texte officiel Code Pénal & CIC d''Haïti'),
    '<h1>Code Pénal et Code d''Instruction Criminelle d''Haïti — Précis d''Étude</h1>'
    '<p><em>Vérifier toujours les modifications législatives postérieures (décrets sur les stupéfiants, le blanchiment, les violences sexuelles, le nouveau projet de Code pénal).</em></p>'
    '<h2>1. Principes Fondamentaux et Classification des Infractions</h2>'
    '<p>Le droit pénal haïtien repose sur le principe de la légalité des délits et des peines : nulle infraction ne peut être réprimée sans un texte légal préalable la qualifiant et fixant la peine applicable (non-rétroactivité de la loi pénale plus sévère ; rétroactivité in mitius de la loi plus douce). L''interprétation de la loi pénale est stricte. Les infractions sont classées en trois catégories selon la gravité de la peine : les contraventions (peines de simple police, compétence du Tribunal de Paix), les délits (peines correctionnelles, Tribunal de Première Instance siégeant en matière correctionnelle) et les crimes (peines afflictives ou infamantes, jugés par le Tribunal Criminel avec ou sans jury selon la nature de l''affaire).</p>'
    '<h2>2. Éléments Constitutifs, Tentative et Participation Criminelle</h2>'
    '<p>Toute infraction suppose trois éléments : l''élément légal (texte d''incrimination), l''élément matériel (acte positif ou abstention prohibée, ou commencement d''exécution dans la tentative punissable qui n''a manqué son effet que par circonstances indépendantes de la volonté de l''auteur) et l''élément moral (intention criminelle pour les crimes et délits intentionnels, ou imprudence/négligence pour les infractions non intentionnelles). Sont punissables l''auteur matériel, le coauteur et le complice (par aide, assistance, fourniture de moyens ou provocation par dons, promesses, menaces ou instructions).</p>'
    '<h2>3. Causes d''Irresponsabilité et Faits Justificatifs</h2>'
    '<p>Il n''y a ni crime ni délit lorsque le prévenu était en état de démence au temps de l''action, ou lorsqu''il a été contraint par une force à laquelle il n''a pu résister. Les faits justificatifs suppriment le caractère délictueux de l''acte : l''ordre de la loi et le commandement de l''autorité légitime (sauf ordre manifestement illégal), l''état de nécessité et la légitime défense (actuelle, nécessaire et proportionnée à une agression injuste contre soi-même ou autrui).</p>'
    '<h2>4. Procédure Pénale : Enquête, Instruction et Jugement (CIC)</h2>'
    '<p>La procédure pénale met en mouvement deux actions : l''action publique (exercée par le Ministère Public — Commissaire du Gouvernement — au nom de la société pour l''application de la peine) et l''action civile (exercée par la victime pour la réparation de son préjudice). Les garanties constitutionnelles imposent le respect du délai maximal de 48 heures entre l''arrestation et la présentation devant un juge (avec recours en habeas corpus devant le Doyen du TPI), la présomption d''innocence, les droits de la défense, la séparation de l''enquête (police judiciaire), de l''instruction (Juge d''Instruction) et du jugement.</p>'
  )
  on conflict (scope, title) where scope = 'official' do update set
    description = excluded.description,
    summary = excluded.summary,
    content_html = excluded.content_html,
    tags = excluded.tags,
    metadata = excluded.metadata
  returning id into v_id;

  insert into public.pran_not_library_chunks (book_id, user_id, scope, chunk_index, section_label, page_number, content) values
    (v_id, null, 'official', 0, 'Légalité pénale et Classification des infractions', 1,
     'Code Pénal d''Haïti - Principes : Nullum crimen, nulla poena sine lege (aucun crime, aucune peine sans loi). Loi pénale d''interprétation stricte et non rétroactive sauf loi plus douce. Division tripartite des infractions : (1) Contraventions punies de peines de police ; (2) Délits punis de peines correctionnelles (emprisonnement à temps et amende) ; (3) Crimes punis de peines afflictives et infamantes (réclusion, travaux forcés / détention perpétuelle ou à temps depuis l''abolition constitutionnelle de la peine de mort en 1987).'),
    (v_id, null, 'official', 1, 'Éléments de l''infraction, Tentative et Complicité', 19,
     'Code Pénal d''Haïti - Infraction : Trois éléments cumulatifs : élément légal (incrimination), élément matériel (comportement extériorisé), élément moral (dol général/spécial ou faute d''imprudence). La tentative de crime est toujours punissable si elle se manifeste par un commencement d''exécution et n''est interrompue que par une cause indépendante de la volonté de son auteur ; la tentative de délit n''est punie que dans les cas déterminés par la loi. La complicité suppose un fait principal punissable, un acte positif (aide, assistance, fourniture d''armes ou instructions) et une intention de s''associer à l''infraction.'),
    (v_id, null, 'official', 2, 'Causes d''irresponsabilité et Légitime défense', 38,
     'Code Pénal d''Haïti - Responsabilité : Causes de non-imputabilité (démence au moment des faits, contrainte physique ou morale irrésistible, minorité pénale avec régime spécial pour les mineurs en conflit avec la loi). Faits justificatifs : ordre de la loi, état de nécessité et légitime défense. Conditions de la légitime défense : agression injuste, actuelle ou imminente ; riposte nécessaire pour défendre soi-même ou autrui et strictement proportionnée à l''intensité de l''attaque.'),
    (v_id, null, 'official', 3, 'Action publique, Action civile et Phase d''Instruction (CIC)', 60,
     'Code d''Instruction Criminelle (CIC) d''Haïti : L''action publique appartient au Ministère Public (Commissaire du Gouvernement près le TPI et ses substituts) pour réprimer l''infraction. L''action civile appartient à la personne lésée pour obtenir dommages-intérêts ; elle peut être portée devant le juge pénal (constitution de partie civile) ou devant le juge civil. Si le juge civil est saisi séparément, le criminel tient le civil en état. Le Juge d''Instruction mène l''information préparatoire à charge et à décharge et rend une ordonnance de non-lieu ou de renvoi devant la juridiction de jugement.'),
    (v_id, null, 'official', 4, 'Garde à vue, Délai 48h, Mandats et Juridictions pénales', 85,
     'Procédure pénale haïtienne : Conformément à l''article 26 de la Constitution, nul ne peut être retenu plus de 48 heures sans être présenté devant un juge compétent (Juge de Paix ou Juge d''Instruction). Les mandats judiciaires sont le mandat de comparution, d''amener, de dépôt et d''arrêt. Compétences : Tribunal de Paix (contraventions et procès-verbaux préliminaires), Tribunal Correctionnel (TPI sans jury pour délits), Tribunal Criminel avec jury (crimes de sang / droit commun) ou sans jury selon la loi, Cour d''Appel et Cour de Cassation.')
  on conflict (book_id, chunk_index) do update set
    section_label = excluded.section_label,
    content = excluded.content,
    page_number = excluded.page_number;

  -- === DROIT 4 : Code du Travail d'Haïti ===
  insert into public.pran_not_library_books (
    user_id, scope, faculty_id, category, title, author, country, publication_year, language,
    description, summary, page_count, tags, metadata, content_html
  ) values (
    null, 'official', 'droit', 'code_loi',
    'Code du Travail d''Haïti (Décret du 24 février 1984)',
    'Législation du Travail Haïtienne',
    'Haïti', 1984, 'fr',
    'Normes régissant le contrat de travail individuel, les heures de travail, le salaire minimum, les congés, la protection sociale (OFATMA/ONA), les syndicats et la résiliation.',
    'Synthèse du Code du Travail d''Haïti : formation du contrat, durée de travail 8h/48h, préavis, licenciement abusif, protection de la maternité et Tribunal Spécial du Travail.',
    95,
    array['code du travail','contrat de travail','salaire','preavis','licenciement','ofatma'],
    jsonb_build_object('verification','Décret du 24 février 1984 et arrêtés sur le salaire minimum'),
    '<h1>Code du Travail d''Haïti — Synthèse Pratique</h1>'
    '<h2>Contrat Individuel de Travail et Période d''Essai</h2>'
    '<p>Le contrat de travail est la convention par laquelle une personne s''engage à fournir ses services personnels à un employeur sous sa direction et moyennant une rémunération. Il suppose trois critères : prestation de travail, rémunération et lien de subordination juridique. Il peut être à durée déterminée (CDD) ou indéterminée (CDI), écrit ou verbal (bien que l''écrit soit obligatoire pour certains contrats et fortement protecteur).</p>'
    '<h2>Durée du Travail, Repos et Congés Payés</h2>'
    '<p>La durée normale du travail est fixée à 8 heures par jour et 48 heures par semaine. Les heures effectuées au-delà constituent des heures supplémentaires donnant droit à une majoration salariale légale (en principe +50%). Tout travailleur a droit à un repos hebdomadaire d''au moins 24 heures consécutives, aux jours fériés chômés payés et à un congé annuel payé d''au moins 15 jours ouvrables après une année de service continu, sans compter les congés de maladie et de maternité.</p>'
    '<h2>Résiliation, Préavis et Règlement des Conflits</h2>'
    '<p>La rupture du CDI à l''initiative d''une partie exige le respect d''un délai de préavis (variant selon l''ancienneté : 8 jours à 3 mois) ou le paiement d''une indemnité compensatrice, sauf faute grave légalement caractérisée. En cas de licenciement sans motif légitime, le salarié a droit aux dommages-intérêts outre son boni proportionnel et ses congés acquis. Les différends individuels ou collectifs sont soumis à la conciliation du Ministère des Affaires Sociales et du Travail (MAST) puis au Tribunal Spécial du Travail.</p>'
  )
  on conflict (scope, title) where scope = 'official' do update set
    description = excluded.description,
    summary = excluded.summary,
    content_html = excluded.content_html,
    tags = excluded.tags,
    metadata = excluded.metadata
  returning id into v_id;

  insert into public.pran_not_library_chunks (book_id, user_id, scope, chunk_index, section_label, page_number, content) values
    (v_id, null, 'official', 0, 'Contrat de travail et Lien de subordination', 1,
     'Code du Travail d''Haïti (Décret du 24 février 1984) : Le contrat individuel de travail repose sur trois éléments : prestation personnelle de service, rémunération (salaire) et lien de subordination juridique à l''employeur. À défaut d''écrit, la preuve du contrat de travail peut être rapportée par tous moyens. La période d''essai ne peut dépasser trois mois.'),
    (v_id, null, 'official', 1, 'Durée du travail, Heures supplémentaires, Congés et Boni', 24,
     'Code du Travail d''Haïti - Temps et Rémunération : Durée légale ordinaire de 8 heures par jour / 48 heures par semaine (sauf régimes spéciaux). Majoration légale pour heures supplémentaires (+50%), travail de nuit et jours fériés. Congé annuel payé de 15 jours consécutifs (dont 13 jours ouvrables) après un an de travail continu, plus droit au treizième mois (boni annuel) payé entre le 24 et le 31 décembre.'),
    (v_id, null, 'official', 2, 'Protection de la maternité, des mineurs et Sécurité (OFATMA)', 48,
     'Code du Travail d''Haïti - Protection sociale : La travailleuse enceinte bénéficie d''un congé de maternité (12 semaines prévues par le Code) avec interdiction de licenciement pour cause de grossesse. L''employeur doit affilier ses salariés à l''OFATMA (assurance accidents du travail, maladie et maternité) et à l''ONA (Office National d''Assurance-Vieillesse).'),
    (v_id, null, 'official', 3, 'Préavis, Rupture abusive et Tribunal Spécial du Travail', 70,
     'Code du Travail d''Haïti - Rupture et Contentieux : Le préavis légal varie de 8 jours (3 à 12 mois d''ancienneté), 15 jours (1 à 3 ans), 1 mois (3 à 6 ans), 2 mois (6 à 10 ans), 3 mois (10 ans et plus). La rupture sans préavis n''est admise qu''en cas de faute grave prouvée par la partie qui l''invoque. En cas de litige, la conciliation devant la Direction du Travail (MAST) précède la saisine du Tribunal Spécial du Travail.')
  on conflict (book_id, chunk_index) do update set
    section_label = excluded.section_label,
    content = excluded.content,
    page_number = excluded.page_number;

  -- === DROIT 5 : Code de Commerce, Procédure Civile & Méthodologie Juridique ===
  insert into public.pran_not_library_books (
    user_id, scope, faculty_id, category, title, author, country, publication_year, language,
    description, summary, page_count, tags, metadata, content_html
  ) values (
    null, 'official', 'droit', 'jurisprudence',
    'Code de Commerce, Procédure Civile & Méthodologie Juridique en Haïti',
    'Droit Commercial, Judiciaire et Méthode du Syllogisme',
    'Haïti', 1826, 'fr',
    'Synthèse complète de la procédure civile (assignation, compétence des tribunaux haïtiens, appel, cassation), des actes de commerce/sociétés et de la méthodologie (cas pratique et fiche d''arrêt).',
    'Organisation judiciaire d''Haïti, actes de commerce, effets de commerce, voies de recours civiles et guide de rédaction du syllogisme juridique et du commentaire d''arrêt.',
    105,
    array['procedure civile','code de commerce','cassation','syllogisme juridique','societes commerciales'],
    jsonb_build_object('verification','Code de Procédure Civile & Code de Commerce d''Haïti'),
    '<h1>Code de Commerce, Procédure Civile & Méthodologie Juridique en Haïti</h1>'
    '<h2>Organisation Judiciaire et Compétence en Matière Civile</h2>'
    '<p>La hiérarchie judiciaire comprend : le Tribunal de Paix (petits litiges civils personnels et mobiliers jusqu''au taux légal, conciliation, actions possessoires), le Tribunal de Première Instance (TPI, juridiction civile et commerciale de droit commun en première instance et juge d''appel des jugements du Tribunal de Paix), la Cour d''Appel (juge au second degré des jugements rendus en premier ressort par les TPI) et la Cour de Cassation (juge du droit vérifiant la régularité et l''exacte application de la loi par les juridictions du fond). En principe, le demandeur assigne le défendeur devant le tribunal de son domicile (actor sequitur forum rei), sauf exceptions réelles ou mixtes.</p>'
    '<h2>Voies de Recours : Ordinaires et Extraordinaires</h2>'
    '<p>Les voies de recours ordinaires sont l''opposition (contre les jugements rendus par défaut) et l''appel (effet dévolutif et suspensif sauf exécution provisoire). Les voies extraordinaires comprennent le pourvoi en cassation (délai légal très strict devant la Cour de Cassation, sans rejuger les faits), la tierce opposition (ouverte aux tiers lésés par un jugement auquel ils n''étaient pas parties) et la requête civile.</p>'
    '<h2>Droit Commercial : Commerçants, Actes de Commerce et Sociétés</h2>'
    '<p>Sont commerçants ceux qui exercent des actes de commerce et en font leur profession habituelle (Code de commerce d''Haïti). La preuve entre commerçants est libre par tous moyens, et la solidarité passive y est présumée. Les principales formes de sociétés commerciales comprennent la Société en Nom Collectif (SNC), la Société en Commandite et la Société Anonyme (SA), ainsi que les règles sur la lettre de change, le billet à ordre, le chèque et la faillite.</p>'
    '<h2>Méthode du Cas Pratique (Syllogisme) et Fiche d''Arrêt</h2>'
    '<p>Pour réussir les devoirs en Faculté de Droit : 1. Qualifier juridiquement les faits ; 2. Formuler le problème de droit en termes généraux et abstraits ; 3. Énoncer la règle applicable (Majeure : texte constitutionnel, article de code ou jurisprudence) ; 4. Appliquer la règle aux faits de l''espèce (Mineure) ; 5. Conclure nettement (Solution). Pour une fiche d''arrêt : Faits, Procédure, Moyens/Prétentions, Problème de droit, Solution de la Cour.</p>'
  )
  on conflict (scope, title) where scope = 'official' do update set
    description = excluded.description,
    summary = excluded.summary,
    content_html = excluded.content_html,
    tags = excluded.tags,
    metadata = excluded.metadata
  returning id into v_id;

  insert into public.pran_not_library_chunks (book_id, user_id, scope, chunk_index, section_label, page_number, content) values
    (v_id, null, 'official', 0, 'Procédure Civile : Juridictions et Compétence', 1,
     'Code de Procédure Civile d''Haïti - Compétence : Principe du double degré de juridiction. Tribunal de Paix (actions personnelles/mobilières de faible valeur, référés locaux, apposition de scellés). Tribunal de Première Instance (TPI, juge de droit commun pour toutes affaires civiles, commerciales, familiales et foncières non attribuées par un texte spécial). Règle territoriale : domicile du défendeur (actor sequitur forum rei), sauf immeubles situés ailleurs ou clauses attributives valides.'),
    (v_id, null, 'official', 1, 'Voies de Recours : Appel, Opposition et Pourvoi en Cassation', 28,
     'Code de Procédure Civile d''Haïti - Voies de recours : Recours ordinaires : opposition contre jugements par défaut et appel devant la Cour d''Appel (qui réexamine fait et droit par l''effet dévolutif). Recours extraordinaires : pourvoi en cassation devant la Cour de Cassation pour violation de la loi, excès de pouvoir, incompétence, défaut ou contrariété de motifs ; tierce opposition et requête civile.'),
    (v_id, null, 'official', 2, 'Droit Commercial : Commerçants, Sociétés et Effets de Commerce', 54,
     'Code de Commerce d''Haïti : Commerçant = personne exerçant des actes de commerce (achat pour revendre, banque, courtage, transport, lettre de change) à titre de profession habituelle. Règles propres : liberté de la preuve entre commerçants, présomption de solidarité, prescription abrégée, compétence commerciale. Sociétés commerciales : Société en Nom Collectif (responsabilité illimitée et solidaire), Société en Commandite et Société Anonyme (responsabilité limitée aux apports).'),
    (v_id, null, 'official', 3, 'Méthodologie : Syllogisme Juridique et Fiche d''Arrêt', 82,
     'Méthodologie des Facultés de Droit d''Haïti : Structure impérative du cas pratique : (1) Faits pertinents qualifiés juridiquement ; (2) Problème de droit ; (3) Majeure (règle de droit applicable : article du Code Civil, Code Pénal ou Constitution) ; (4) Mineure (application rigoureuse de la règle aux faits) ; (5) Conclusion pratique. Structure de la fiche d''arrêt : Faits -> Procédure antérieure -> Thèses en présence -> Question de droit -> Motif de droit et Dispositif de l''arrêt.')
  on conflict (book_id, chunk_index) do update set
    section_label = excluded.section_label,
    content = excluded.content,
    page_number = excluded.page_number;

  -- === MÉDECINE & SCIENCES INFIRMIÈRES ===
  insert into public.pran_not_library_books (
    user_id, scope, faculty_id, category, title, author, country, publication_year, language,
    description, summary, page_count, tags, metadata, content_html
  ) values (
    null, 'official', 'medecine', 'manuel',
    'Sémiologie Clinique et Urgences Médicales — Référentiel d''Étude (Haïti)',
    'Collège Académique Médical — Pran Nòt',
    'Haïti', 2024, 'fr',
    'Guide méthodologique d''examen clinique, de raisonnement diagnostique et de prise en charge initiale des pathologies fréquentes en milieu hospitalier haïtien.',
    'Anamnèse, constantes vitales, sémiologie cardio-respiratoire et abdominale, prise en charge des urgences (déshydratation, paludisme, HTA sévère) avec rappel de vérification des posologies MSPP.',
    80,
    array['semiologie','medecine','urgences','examen clinique','mspp','sante'],
    jsonb_build_object('verification','Guides cliniques officiels MSPP / OMS'),
    '<h1>Sémiologie Clinique et Urgences Médicales — Référentiel d''Étude</h1>'
    '<p><em>Avertissement clinique : Document de synthèse pédagogique. Toute décision thérapeutique ou posologie doit être vérifiée dans les protocoles nationaux du MSPP et les monographies pharmacologiques officielles.</em></p>'
    '<h2>1. Démarche Sémiologique Systématique</h2>'
    '<p>L''examen clinique suit l''ordre rigoureux : Anamnèse (motif de consultation, histoire de la maladie actuelle selon les critères PQRST, antécédents personnels/familiaux, allergies, habitudes) -> Signes vitaux (fréquence cardiaque, pression artérielle, fréquence respiratoire, température, SpO2, score de Glasgow) -> Examen physique en 4 temps : Inspection, Palpation, Percussion, Auscultation (IPPA).</p>'
    '<h2>2. Pathologies et Urgences Fréquentes en Contexte Haïtien</h2>'
    '<p>Fièvre aiguë : toujours évoquer paludisme (test TDR / goutte épaisse), dengue/arboviroses, fièvre typhoïde, infections respiratoires ou urinaires selon le tableau clinique. Diarrhée aiguë et déshydratation (choléra / gastro-entérites) : évaluer le plan de réhydratation (Plan A, B ou C par Ringer Lactate selon les signes de choc ou de pli cutané). Hypertension artérielle et urgences hypertensives : rechercher une atteinte d''organe cible (AVC, OAP, éclampsie chez la femme enceinte) avant toute baisse brutale de tension.</p>'
  )
  on conflict (scope, title) where scope = 'official' do update set
    description = excluded.description,
    summary = excluded.summary,
    content_html = excluded.content_html,
    tags = excluded.tags
  returning id into v_id;

  insert into public.pran_not_library_chunks (book_id, user_id, scope, chunk_index, section_label, page_number, content) values
    (v_id, null, 'official', 0, 'Anamnèse, Constantes Vitales et Examen Physique IPPA', 1,
     'Sémiologie clinique universitaire : Anamnèse structurée (motif, début, évolution, antécédents, traitements en cours). Constantes de base : TA normale < 130/80 mmHg, FC 60-100 bpm, FR 12-20/min, Température 36.5-37.5 C, SpO2 >= 95%. Examen physique systématique : Inspection -> Palpation -> Percussion -> Auscultation (exception abdominale : ausculter avant percuter/palper).'),
    (v_id, null, 'official', 1, 'Syndrome Fébriles et Déshydratation en Contexte Haïtien', 24,
     'Médecine tropicale et urgences en Haïti : Face à une fièvre aiguë, rechercher les signes de gravité (troubles de conscience, choc, détresse respiratoire, ictère) et réaliser les bilans ciblés (TDR paludisme, NFS, hémocultures). Devant une diarrhée profuse, classifier la déshydratation (A : sans signe ; B : modérée -> SRO ; C : sévère avec léthargie ou choc -> réhydratation IV urgente par Ringer Lactate selon protocole MSPP/OMS).'),
    (v_id, null, 'official', 2, 'Urgences Cardio-Vasculaires et Éclampsie', 48,
     'Sémiologie cardio-vasculaire : Douleur thoracique -> éliminer en urgence syndrome coronarien aigu (ECG, troponine), embolie pulmonaire, dissection aortique, péricardite et pneumothorax. HTA + grossesse >= 20 SA + protéinurie = prééclampsie ; survenue de convulsions = éclampsie (urgence obstétricale absolue, sulfate de magnésium et prise en charge spécialisée selon protocole MSPP).')
  on conflict (book_id, chunk_index) do update set
    section_label = excluded.section_label,
    content = excluded.content,
    page_number = excluded.page_number;

  -- === SCIENCES INFORMATIQUES ===
  insert into public.pran_not_library_books (
    user_id, scope, faculty_id, category, title, author, country, publication_year, language,
    description, summary, page_count, tags, metadata, content_html
  ) values (
    null, 'official', 'sciences_info', 'manuel',
    'Algorithmique, Structures de Données et Architecture Bases de Données',
    'Manuel Universitaire Informatique — Pran Nòt',
    'Haïti', 2024, 'fr',
    'Fondamentaux d''informatique universitaire : complexité asymptotique, structures linéaires et arborescentes, modélisation relationnelle SQL (1NF-3NF) et sécurité des applications web.',
    'Guide de référence sur la complexité O(n), algorithmes de tri et graphes (BFS/DFS/Dijkstra), normalisation des bases relationnelles SQL et sécurité OWASP.',
    90,
    array['algorithme','complexite','sql','base de donnees','securite','informatique'],
    jsonb_build_object('verification','Standards ACM/IEEE & OWASP Top 10'),
    '<h1>Algorithmique, Structures de Données et Bases de Données</h1>'
    '<h2>1. Complexité et Structures de Données</h2>'
    '<p>L''analyse asymptotique évalue la croissance du temps d''exécution et de la mémoire en notation Grand-O : O(1) accès tableau, O(log n) recherche binaire ou arbre équilibré, O(n log n) tri fusion/rapide moyen, O(n^2) boucles imbriquées. Structures clés : piles (LIFO), files (FIFO), listes chaînées, tables de hachage, arbres binaires de recherche, tas (heaps) et graphes parcourus en largeur (BFS pour plus court chemin non pondéré) ou en profondeur (DFS pour détection de cycles et tri topologique).</p>'
    '<h2>2. Bases de Données Relationnelles et Sécurité</h2>'
    '<p>Normalisation : 1NF (valeurs atomiques sans groupes répétitifs), 2NF (dépendance fonctionnelle complète à toute la clé primaire), 3NF (aucune dépendance transitive entre attributs non-clés). Indexation B-Tree pour recherches/plages et GIN pour plein texte. Sécurité applicative : requêtes paramétrées contre injections SQL, contrôle d''accès côté serveur (RLS / JWT), échappement des sorties HTML contre XSS, protection SSRF sur les appels réseau serveur.</p>'
  )
  on conflict (scope, title) where scope = 'official' do update set
    description = excluded.description,
    summary = excluded.summary,
    content_html = excluded.content_html,
    tags = excluded.tags
  returning id into v_id;

  insert into public.pran_not_library_chunks (book_id, user_id, scope, chunk_index, section_label, page_number, content) values
    (v_id, null, 'official', 0, 'Complexité Asymptotique et Algorithmes de Tri / Graphes', 1,
     'Algorithmique : Notation O(f(n)) caractérise la borne supérieure asymptotique. Tri rapide (Quicksort) O(n log n) en moyenne, O(n^2) pire cas ; Tri fusion (Mergesort) O(n log n) garanti et stable avec O(n) mémoire auxiliaire. Parcours de graphes : BFS utilise une file et garantit le chemin minimal en nombre d''arêtes ; DFS utilise une pile/récursion ; Dijkstra résout le plus court chemin avec poids positifs en O((V+E) log V).'),
    (v_id, null, 'official', 1, 'Modélisation Relationnelle, SQL et Formes Normales (1NF-3NF)', 30,
     'Bases de données relationnelles : 1NF impose des attributs atomiques ; 2NF supprime les dépendances partielles sur une clé composite ; 3NF élimine les dépendances transitives entre colonnes non-clés. Les clés étrangères garantissent l''intégrité référentielle. Index B-Tree accélère égalité/ordre/jointures ; GIN accélère tsvector et JSONB.'),
    (v_id, null, 'official', 2, 'Sécurité Web et Contrôle d''Accès (OWASP)', 60,
     'Sécurité applicative : Prévenir les failles critiques : (1) Contrôle d''accès défaillant -> valider JWT et politiques RLS côté serveur/base ; (2) Injections SQL/XSS -> requêtes préparées et échappement strict ; (3) SSRF -> bloquer adresses privées/locales avant tout fetch serveur sur une URL externe.')
  on conflict (book_id, chunk_index) do update set
    section_label = excluded.section_label,
    content = excluded.content,
    page_number = excluded.page_number;

  -- === SCIENCES ÉCONOMIQUES ===
  insert into public.pran_not_library_books (
    user_id, scope, faculty_id, category, title, author, country, publication_year, language,
    description, summary, page_count, tags, metadata, content_html
  ) values (
    null, 'official', 'sciences_eco', 'manuel',
    'Macroéconomie, Comptabilité et Politique Monétaire en Haïti',
    'Cahiers Universitaires d''Économie — Pran Nòt',
    'Haïti', 2024, 'fr',
    'Comprendre les agrégats macroéconomiques, le rôle de la Banque de la République d''Haïti (BRH), l''inflation, le taux de change et les états financiers des PME.',
    'PIB, balance des paiements et transferts de la diaspora, instruments monétaires de la BRH, inflation et principes comptables (bilan, compte de résultat, trésorerie).',
    75,
    array['economie','brh','inflation','comptabilite','macroeconomie','haiti'],
    jsonb_build_object('verification','Rapports statistiques BRH / IHSI'),
    '<h1>Macroéconomie, Comptabilité et Politique Monétaire en Haïti</h1>'
    '<h2>Agrégats Macroéconomiques et Balance des Paiements</h2>'
    '<p>Le Produit Intérieur Brut (PIB = C + I + G + X - M) mesure la richesse produite sur le territoire durant une période donnée. L''économie haïtienne se caractérise par un fort déficit de la balance commerciale compensé en partie par les transferts sans contrepartie de la diaspora dans la balance des paiements, et une forte dollarisation financière partielle.</p>'
    '<h2>Politique Monétaire de la BRH et Comptabilité d''Entreprise</h2>'
    '<p>La Banque de la République d''Haïti (BRH) utilise notamment le taux directeur (bons BRH), les coefficients de réserves obligatoires en gourdes et en devises et les interventions sur le marché des changes pour contenir l''inflation et stabiliser la gourde. En comptabilité financière, l''équilibre fondamental Actif = Passif + Capitaux Propres structure le bilan, complété par l''État des Résultats et le Tableau des Flux de Trésorerie.</p>'
  )
  on conflict (scope, title) where scope = 'official' do update set
    description = excluded.description,
    summary = excluded.summary,
    content_html = excluded.content_html,
    tags = excluded.tags
  returning id into v_id;

  insert into public.pran_not_library_chunks (book_id, user_id, scope, chunk_index, section_label, page_number, content) values
    (v_id, null, 'official', 0, 'PIB, Croissance et Balance des Paiements d''Haïti', 1,
     'Macroéconomie haïtienne : Équation comptable PIB = C + I + G + (X - M). En Haïti, l''importance des importations alimentaires et pétrolières crée un déficit commercial structurel, partiellement financé par les transferts privés de la diaspora. Distinction entre PIB nominal et PIB réel corrigé de l''inflation.'),
    (v_id, null, 'official', 1, 'Rôle de la BRH, Taux de Change et Inflation', 25,
     'Politique monétaire en Haïti : La BRH régule la masse monétaire via les réserves obligatoires des banques commerciales, l''émission de bons BRH et l''encadrement du marché des changes. Le financement monétaire du déficit budgétaire alimente la dépréciation de la gourde et l''inflation des prix à la consommation.'),
    (v_id, null, 'official', 2, 'Comptabilité Générale : Bilan, Résultat et Ratios', 50,
     'Comptabilité universitaire : Principe de la partie double (Débit = Crédit). Actif immobilisé et circulant face aux capitaux propres et dettes. Ratios clés : liquidité générale (Actif CT / Passif CT), solvabilité, seuil de rentabilité et marge opérationnelle.')
  on conflict (book_id, chunk_index) do update set
    section_label = excluded.section_label,
    content = excluded.content,
    page_number = excluded.page_number;

  -- === GÉNIE ===
  insert into public.pran_not_library_books (
    user_id, scope, faculty_id, category, title, author, country, publication_year, language,
    description, summary, page_count, tags, metadata, content_html
  ) values (
    null, 'official', 'genie', 'manuel',
    'Code National du Bâtiment d''Haïti (CNBH) & RDM — Synthèse Parasismique',
    'Référentiel d''Ingénierie Civile — Haïti',
    'Haïti', 2012, 'fr',
    'Principes de conception parasismique et anticyclonique applicables en Haïti (CNBH), combinaison des charges, béton armé et résistance des matériaux en unités SI.',
    'Synthèse d''ingénierie sur les zones sismiques haïtiennes, le CNBH, le chaînage en maçonnerie confinée, le béton armé et les combinaisons de charges (U = 1.2D + 1.6L).',
    85,
    array['cnbh','genie civil','parasismique','beton arme','rdm','haiti'],
    jsonb_build_object('verification','Code National du Bâtiment d''Haïti (MTPTC)'),
    '<h1>Code National du Bâtiment d''Haïti (CNBH) & Résistance des Matériaux</h1>'
    '<h2>1. Aléa Sismique, Aléa Cyclonique et Dispositions CNBH</h2>'
    '<p>Haïti est traversée par deux failles majeures (Enriquillo-Plantain Garden au sud et Septentrionale au nord), imposant des exigences strictes de ductilité et de continuité structurale selon le CNBH. En maçonnerie confinée courante : chaînages horizontaux et potelets raidisseurs en béton armé reliés en cadre fermé, linteaux continus au-dessus des ouvertures, fondations ancrées sur sol ferme après étude géotechnique.</p>'
    '<h2>2. Combinaisons de Charges et Résistance des Matériaux (SI)</h2>'
    '<p>En unités SI (N, Pa, MPa, m) : vérification aux états limites ultimes (ELU) des efforts normaux, tranchants et moments fléchissants. Combinaisons courantes incluant charges permanentes (G ou D), surcharges d''exploitation (Q ou L), actions sismiques (E) et charges de vent cyclonique (W). Contrainte normale sigma = N / A et contrainte de flexion sigma = M * y / I.</p>'
  )
  on conflict (scope, title) where scope = 'official' do update set
    description = excluded.description,
    summary = excluded.summary,
    content_html = excluded.content_html,
    tags = excluded.tags
  returning id into v_id;

  insert into public.pran_not_library_chunks (book_id, user_id, scope, chunk_index, section_label, page_number, content) values
    (v_id, null, 'official', 0, 'Conception Parasismique et Anticyclonique (CNBH)', 1,
     'Code National du Bâtiment d''Haïti (MTPTC) : Dispositions minimales pour bâtiments en zones sismiques haïtiennes. Régularité en plan et en élévation pour éviter les effets de torsion et les étages souples. Maçonnerie chaînée obligatoire avec potelets aux angles et jonctions, armatures longitudinales continues et cadres rapprochés dans les zones nodales.'),
    (v_id, null, 'official', 1, 'Résistance des Matériaux, Unités SI et Combinaisons ELU', 32,
     'Ingénierie structurale (SI) : Cohérence dimensionnelle stricte (force en kN, contrainte en MPa = N/mm2). Équilibre statique (somme Fx=0, Fy=0, M=0). Contraintes combinées et flambement critique d''Euler (P_cr = pi^2 * E * I / L_k^2). Vérification du cisaillement des poutres et du non-poinçonnement des semelles de fondation.')
  on conflict (book_id, chunk_index) do update set
    section_label = excluded.section_label,
    content = excluded.content,
    page_number = excluded.page_number;

  -- === AGRONOMIE ===
  insert into public.pran_not_library_books (
    user_id, scope, faculty_id, category, title, author, country, publication_year, language,
    description, summary, page_count, tags, metadata, content_html
  ) values (
    null, 'official', 'agronomie', 'manuel',
    'Pédologie, Agroécologie et Gestion des Bassins Versants en Haïti',
    'Référentiel Agronomique — Haïti',
    'Haïti', 2024, 'fr',
    'Techniques de conservation des sols en mornes, jardins lakou, systèmes agroforestiers et gestion durable de l''eau dans les bassins versants haïtiens.',
    'Conservation des eaux et des sols (rampes vivantes, murs secs, ravines), fertilité N-P-K, matière organique et systèmes agroforestiers adaptés aux plaines et montagnes d''Haïti.',
    65,
    array['agronomie','bassins versants','pedologie','agroecologie','erosion','haiti'],
    jsonb_build_object('verification','Guides techniques MARNDR'),
    '<h1>Pédologie, Agroécologie et Bassins Versants en Haïti</h1>'
    '<p>Avec près de 75 % de relief montagneux, la lutte contre l''érosion hydrique constitue l''enjeu central de l''agronomie haïtienne. Les aménagements mécaniques (murs en pierres sèches, seuils de correction de ravines) combinés aux ouvrages biologiques (rampes d''herbe vétiver ou ananas suivant les courbes de niveau, haies vives fixatrices d''azote comme Gliricidia ou Leucaena) protègent les sols tout en améliorant l''infiltration vers les plaines irriguées.</p>'
  )
  on conflict (scope, title) where scope = 'official' do update set
    description = excluded.description,
    summary = excluded.summary,
    content_html = excluded.content_html,
    tags = excluded.tags
  returning id into v_id;

  insert into public.pran_not_library_chunks (book_id, user_id, scope, chunk_index, section_label, page_number, content) values
    (v_id, null, 'official', 0, 'Conservation des Eaux et Sols en Zones de Mornes', 1,
     'Agronomie haïtienne : Sur les pentes fortes des bassins versants, l''érosion en nappe et en ravines entraîne la perte de l''horizon humifère. Mesures recommandées : courbes de niveau au niveau en A, bandes antiérosives végétales, correction de ravines par seuils en gabions ou pierres sèches et jachère améliorée.'),
    (v_id, null, 'official', 1, 'Fertilité des Sols et Systèmes Agroforestiers (Jaden Lakou)', 28,
     'Pédologie et phytotechnie : Analyse du pH, capacité d''échange cationique (CEC) et équilibre N-P-K. Le système agroforestier traditionnel haïtien (Jaden Lakou) associe strates arborées (manguiers, avocatiers, arbres à pain) et cultures vivrières sous-jacentes (igname, pois congo, patate douce) optimisant la résilience climatique et la sécurité alimentaire.')
  on conflict (book_id, chunk_index) do update set
    section_label = excluded.section_label,
    content = excluded.content,
    page_number = excluded.page_number;

  -- === LETTRES, ÉDUCATION & MÉTHODOLOGIE ANTI-PLAGIAT ===
  insert into public.pran_not_library_books (
    user_id, scope, faculty_id, category, title, author, country, publication_year, language,
    description, summary, page_count, tags, metadata, content_html
  ) values (
    null, 'official', 'lettres', 'manuel',
    'Méthodologie Universitaire, Normes APA et Rédaction sans Plagiat',
    'Guide Académique Transversal — Pran Nòt',
    'Haïti', 2025, 'fr',
    'Règles pratiques pour toutes les facultés : recherche documentaire fiable, citation directe vs paraphrase originale sans plagiat, bibliographie APA 7e édition et dissertation.',
    'Comment citer correctement un ouvrage ou une loi, éviter le plagiat par reformulation analytique, vérifier la fiabilité d''une source internet et formater sa bibliographie.',
    55,
    array['methodologie','anti-plagiat','apa','bibliographie','dissertation','recherche'],
    jsonb_build_object('verification','Guide APA 7e édition & déontologie universitaire'),
    '<h1>Méthodologie Universitaire, Normes APA et Rédaction sans Plagiat</h1>'
    '<h2>1. Citation Fidèle vs Paraphrase Sans Plagiat</h2>'
    '<p>Copier-coller une phrase d''un livre ou d''un site internet sans guillemets ni référence constitue un plagiat académique. Deux façons honnêtes d''utiliser une source existent : (a) La citation directe, placée entre guillemets et accompagnée du nom de l''auteur, de l''année et du numéro de page ou d''article (obligatoire pour les articles de loi ou définitions exactes) ; (b) La paraphrase analytique, qui consiste à assimiler l''idée et à la réécrire entièrement avec sa propre structure syntaxique, son propre vocabulaire et son analyse critique, tout en citant la source d''origine.</p>'
    '<h2>2. Évaluer une Source sur Internet et Normes APA 7</h2>'
    '<p>Avant d''intégrer un document trouvé en ligne dans un devoir : vérifier l''auteur ou l''institution éditrice (université, journal officiel, revue à comité de lecture), la date de publication ou de révision, et la présence de données vérifiables. Format APA ouvrage : Nom, Initiale. (Année). Titre en italique. Éditeur. Format article : Nom, Initiale. (Année). Titre de l''article. Nom de la revue, volume(numéro), pages. DOI ou URL.</p>'
  )
  on conflict (scope, title) where scope = 'official' do update set
    description = excluded.description,
    summary = excluded.summary,
    content_html = excluded.content_html,
    tags = excluded.tags
  returning id into v_id;

  insert into public.pran_not_library_chunks (book_id, user_id, scope, chunk_index, section_label, page_number, content) values
    (v_id, null, 'official', 0, 'Éthique Académique : Éviter le Plagiat par Synthèse Originale', 1,
     'Déontologie universitaire : Le plagiat survient lorsqu''un auteur reprend mots pour mots ou structure pour structure un texte d''autrui sans mention de source. Pour rédiger sans plagiat : lire le passage, fermer le document source, formuler l''idée principale dans ses propres termes, confronter plusieurs sources et ajouter systématiquement la référence bibliographique (Auteur, Année) ou l''article officiel cité entre guillemets.'),
    (v_id, null, 'official', 1, 'Normes APA 7 et Citer des Textes Juridiques Haïtiens', 22,
     'Citation bibliographique : Ouvrage imprimé = Nom, P. (Année). Titre du livre. Maison d''édition. Texte juridique haïtien = République d''Haïti. (Année). Titre du Code ou de la Loi, article X. Journal Officiel Le Moniteur (si disponible). Pour un arrêt : Juridiction (ex. Cour de Cassation), date de l''arrêt, parties ou numéro de rôle.')
  on conflict (book_id, chunk_index) do update set
    section_label = excluded.section_label,
    content = excluded.content,
    page_number = excluded.page_number;

end;
$$;
