-- =====================================================================
-- PRAN NÒT - 03_storage.sql
-- Buckets privés Supabase Storage et politiques par utilisateur.
-- Convention de chemin : <user_id>/<objet>
-- Exécuter après 02_rls.sql.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('pran-not-note-images', 'pran-not-note-images', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic']),
  ('pran-not-note-audio',  'pran-not-note-audio',  false, 26214400, array['audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/aac','audio/m4a','audio/x-m4a','audio/flac','audio/3gpp','video/webm']),
  ('pran-not-syllabi',     'pran-not-syllabi',     false, 20971520, array['application/pdf','image/jpeg','image/png','image/webp','text/plain']),
  ('pran-not-assignments', 'pran-not-assignments', false, 20971520, array['application/pdf','image/jpeg','image/png','image/webp','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain']),
  ('pran-not-exports',     'pran-not-exports',     false, 20971520, array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/markdown','text/plain']),
  ('pran-not-avatars',     'pran-not-avatars',     false, 2097152,  array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Fonction utilitaire : vérifie que le 1er segment du chemin est l'UID de l'utilisateur
create or replace function public.pran_not_is_storage_owner(object_name text)
returns boolean
language sql
stable
set search_path = public
as $$
  select (storage.foldername(object_name))[1] = auth.uid()::text;
$$;
revoke execute on function public.pran_not_is_storage_owner(text) from public, anon;
grant execute on function public.pran_not_is_storage_owner(text) to authenticated;

-- Suppression des anciennes politiques si ré-exécution
do $$
declare
  b text;
begin
  foreach b in array array['pran-not-note-images','pran-not-note-audio','pran-not-syllabi','pran-not-assignments','pran-not-exports','pran-not-avatars'] loop
    execute format('drop policy if exists "%1$s_select" on storage.objects', b);
    execute format('drop policy if exists "%1$s_insert" on storage.objects', b);
    execute format('drop policy if exists "%1$s_update" on storage.objects', b);
    execute format('drop policy if exists "%1$s_delete" on storage.objects', b);
  end loop;
end;
$$;

-- Politiques par bucket privé
do $$
declare
  b text;
begin
  foreach b in array array['pran-not-note-images','pran-not-note-audio','pran-not-syllabi','pran-not-assignments','pran-not-exports','pran-not-avatars'] loop
    execute format($f$
      create policy "%1$s_select" on storage.objects
        for select to authenticated
        using (bucket_id = %1$L and (public.pran_not_is_storage_owner(name) or public.pran_not_is_admin()));
    $f$, b);

    execute format($f$
      create policy "%1$s_insert" on storage.objects
        for insert to authenticated
        with check (bucket_id = %1$L and public.pran_not_is_storage_owner(name));
    $f$, b);

    execute format($f$
      create policy "%1$s_update" on storage.objects
        for update to authenticated
        using (bucket_id = %1$L and public.pran_not_is_storage_owner(name))
        with check (bucket_id = %1$L and public.pran_not_is_storage_owner(name));
    $f$, b);

    execute format($f$
      create policy "%1$s_delete" on storage.objects
        for delete to authenticated
        using (bucket_id = %1$L and (public.pran_not_is_storage_owner(name) or public.pran_not_is_admin()));
    $f$, b);
  end loop;
end;
$$;
