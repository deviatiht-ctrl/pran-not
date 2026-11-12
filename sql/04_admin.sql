-- =====================================================================
-- ÉDITER L'EMAIL AVANT EXÉCUTION
-- PRAN NÒT - 04_admin.sql
-- Insertion de l'administrateur principal.
-- Remplacez 'admin@prannot.ht' par votre véritable adresse email Supabase.
-- =====================================================================

insert into public.pran_not_admin_users (email)
values (lower('laurorejeanclarens0@gmail.com'))
on conflict (email) do nothing;
