# Guide de déploiement — Pran Nòt

Plateforme d'étude bilingue Kreyòl / Français (Vanilla ES Modules + Supabase).

## 1. Créer le projet Supabase
1. Créez un projet sur Supabase (région proche d'Haïti : `us-east-1`).
2. Dans **Authentication > Providers** :
   - Activez **Email** (inscription et connexion par email + mot de passe).
   - Activez **Google OAuth** si souhaité et renseignez les URLs de redirection (`https://VOTRE-DOMAINE/pages/dashboard.html`).
3. Dans **Authentication > URL Configuration**, définissez **Site URL** vers `https://VOTRE-DOMAINE` et ajoutez `https://VOTRE-DOMAINE/**` dans **Redirect URLs**.

## 2. Exécuter les scripts SQL (ordre strict et isolation multi-projets)
Si votre projet Supabase héberge déjà d'autres applications, toutes les ressources Pran Nòt sont isolées par un préfixe dédié :
- Tables, vues/fonctions RPC et politiques RLS : `public.pran_not_*` (`trg_pran_not_*` pour les triggers).
- Buckets Storage : `pran-not-note-images`, `pran-not-note-audio`, `pran-not-syllabi`, `pran-not-assignments`, `pran-not-exports`, `pran-not-avatars`.
- Le trigger sur `auth.users` s'appelle `pran_not_on_auth_user_created` et n'écrase aucun trigger existant d'un autre projet (`on_auth_user_created`, etc.).
- La boucle des triggers `updated_at` ne s'applique qu'aux tables `pran_not_%`.
- La fonction RPC `public.pran_not_ensure_profile()` initialise à la demande le profil et la série d'un compte `auth.users` préexistant créé via une autre application du même projet.

Dans **SQL Editor**, exécutez dans cet ordre :
1. `sql/01_schema.sql` (tables `pran_not_*`, index, déclencheurs, fonctions RPC)
2. `sql/02_rls.sql` (activation RLS sur toutes les tables `pran_not_*` + politiques `pran_not_*`)
3. `sql/03_storage.sql` (6 buckets privés `pran-not-*` et règles par utilisateur)
4. `sql/04_admin.sql` (**modifiez d'abord `'admin@prannot.ht'` avec votre email administrateur réel**)
5. `sql/05_seed.sql` (12 facultés, 12 badges, fournisseurs IA gratuits et prompts système)

## 3. Configurer le frontend
Ouvrez `assets/js/supabase.js` et remplacez :
- `SUPABASE_URL` par votre *Project URL* (`https://xxxx.supabase.co`)
- `SUPABASE_ANON_KEY` par votre clé *anon public*

## 4. Déployer les Edge Functions et secrets IA
Installez la CLI Supabase et liez votre projet :

```bash
supabase login
supabase link --project-ref VOTRE_PROJECT_REF
```

Si ce projet Supabase est partagé avec d'autres applications, exécutez d'abord `supabase functions list` et `supabase secrets list` pour vérifier qu'aucune autre application n'utilise déjà ces mêmes slugs de fonctions (`ai-gateway`, `ocr-board`, `transcribe`, `process-note`, `process-syllabus`, `generate-flashcards`, `generate-test`, `tutor`, `assignment-assist`, `daily-reminder`, `weekly-report`, `whatsapp-gateway`, `whatsapp-webhook`) ni de secret `APP_URL` / `CRON_SECRET` incompatible.

Configurez les secrets (clés 100 % côté serveur, jamais exposées dans le frontend) :

```bash
supabase secrets set \
  GEMINI_API_KEY="votre_cle_gemini" \
  GROQ_API_KEY="votre_cle_groq" \
  MISTRAL_API_KEY="votre_cle_mistral" \
  OPENROUTER_API_KEY="votre_cle_openrouter" \
  BREVO_API_KEY="votre_cle_brevo" \
  FROM_EMAIL="noreply@votredomaine.ht" \
  PRAN_NOT_FROM_NAME="Pran Not" \
  CVISUAL_WA_API_KEY="votre_cle_cvisual_wa" \
  CVISUAL_WA_BASE_URL="https://cvisual-whatsapp-gateway.onrender.com" \
  APP_URL="https://votre-domaine.pages.dev" \
  CRON_SECRET="chaine_aleatoire_longue_et_secrete"
```

Note : au minimum une clé IA (`GEMINI_API_KEY` ou `GROQ_API_KEY`) est nécessaire pour le fonctionnement de l'IA. L'absence d'une clé désactive simplement ce fournisseur au profit du suivant. La clé CVISUAL WhatsApp peut aussi être remplacée côté serveur depuis l'interface administrateur (`pages/admin/whatsapp.html`).

Déployez les Edge Functions authentifiées puis les fonctions publiques vérifiées par jeton/HMAC (`daily-reminder`, `weekly-report` et `whatsapp-webhook` utilisent `--no-verify-jwt`) :

```bash
for fn in ai-gateway ocr-board transcribe process-note process-syllabus generate-flashcards generate-test tutor assignment-assist whatsapp-gateway; do
  supabase functions deploy "$fn"
done

supabase functions deploy daily-reminder --no-verify-jwt
supabase functions deploy weekly-report --no-verify-jwt
supabase functions deploy whatsapp-webhook --no-verify-jwt
```

## 5. Planifier les rappels avec pg_cron
Dans **Database > Extensions**, activez `pg_cron` et `pg_net`, puis exécutez dans **SQL Editor** (en remplaçant `VOTRE_PROJECT_REF` et `VOTRE_CRON_SECRET`) :

```sql
-- Rappels quotidiens (toutes les heures à 00 min UTC pour couvrir les échéances et rappels)
select cron.schedule(
  'prannot-daily-reminder',
  '0 12 * * *',
  $$
  select net.http_post(
    url := 'https://VOTRE_PROJECT_REF.supabase.co/functions/v1/daily-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'VOTRE_CRON_SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Bilan hebdomadaire chaque dimanche à 18h UTC (13h Port-au-Prince)
select cron.schedule(
  'prannot-weekly-report',
  '0 18 * * 0',
  $$
  select net.http_post(
    url := 'https://VOTRE_PROJECT_REF.supabase.co/functions/v1/weekly-report',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'VOTRE_CRON_SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

## 6. Déployer le site statique
Aucun build requis : déposez le dossier racine sur Cloudflare Pages, Netlify, Vercel ou GitHub Pages en HTTPS (indispensable pour le Service Worker PWA, l'installation mobile et le micro/caméra).
