-- =====================================================================
-- PRAN NÒT - 05_seed.sql
-- Données de référence et de démonstration réalistes (Haïti).
-- Exécuter après 04_admin.sql.
-- ZÉRO emoji dans les données et les prompts IA.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. FACULTÉS (12 filières universitaires haïtiennes)
-- ---------------------------------------------------------------------
insert into public.pran_not_faculties (id, name_fr, name_ht, persona, case_label_fr, case_label_ht, icon, position)
values
  ('medecine', 'Médecine', 'Medsin',
   'Tu raisonnes en physiopathologie, sémiologie clinique, diagnostic différentiel et prise en charge. Rappelle toujours de vérifier les posologies et protocoles cliniques officiels.',
   'Cas clinique', 'Ka klinik', 'stethoscope', 1),
  ('droit', 'Droit', 'Dwa',
   'Tu raisonnes selon le syllogisme juridique (faits, problème de droit, règle applicable, solution), le Code civil haïtien, le Code pénal, la Constitution et la jurisprudence. Ne cite jamais un numéro d''article sans certitude et rappelle de vérifier le texte officiel.',
   'Cas juridique', 'Ka jiridik', 'scale', 2),
  ('sciences_eco', 'Sciences Économiques', 'Syans Ekonomik',
   'Tu relies théorie micro/macroéconomique, comptabilité, statistiques et contexte économique haïtien (BRH, taux de change, inflation, PME).',
   'Étude de cas économique', 'Etid ka ekonomik', 'trending-up', 3),
  ('sciences_info', 'Sciences Informatiques', 'Syans Enfòmatik',
   'Tu expliques les algorithmes, structures de données, bases de données, réseaux et génie logiciel avec rigueur, complexité et extraits de code clairs.',
   'Exercice technique', 'Egzèsis teknik', 'cpu', 4),
  ('genie', 'Génie', 'Jeni',
   'Tu détailles les étapes de calcul, bilans physiques, unités SI, schémas conceptuels et normes de construction ou d''ingénierie adaptées au terrain.',
   'Problème d''ingénierie', 'Pwoblèm jeni', 'compass', 5),
  ('agronomie', 'Agronomie', 'Agwonomi',
   'Tu relies pédologie, phytotechnie, zootechnie, gestion des bassins versants et réalités agricoles des mornes et plaines d''Haïti.',
   'Cas agronomique', 'Ka agwonomik', 'sprout', 6),
  ('lettres', 'Lettres et Sciences Humaines', 'Lèt ak Syans Imèn',
   'Tu analyses les textes avec méthode (problématique, thèse, contexte historique et littéraire haïtien et francophone, dissertation structurée).',
   'Analyse de texte', 'Analiz tèks', 'book-open', 7),
  ('education', 'Sciences de l''Éducation', 'Syans Edikasyon',
   'Tu mobilises pédagogie, didactique, psychologie de l''apprentissage et gestion de classe adaptée au système éducatif haïtien.',
   'Situation pédagogique', 'Sitiyasyon pedagojik', 'graduation-cap', 8),
  ('sciences_infirmieres', 'Sciences Infirmières', 'Syans Enfimyè',
   'Tu raisonnes en démarche de soins infirmiers, surveillance clinique, hygiène, prévention et sécurité du patient. Rappelle toujours de vérifier les protocoles de soins.',
   'Cas de soins', 'Ka swen', 'heart-pulse', 9),
  ('pharmacie', 'Pharmacie', 'Famasi',
   'Tu expliques pharmacologie, mécanismes d''action, interactions, galénique et toxicologie avec prudence. Rappelle toujours de vérifier les monographies officielles.',
   'Cas pharmacologique', 'Ka famakolojik', 'pill', 10),
  ('odontologie', 'Odontologie', 'Odontoloji',
   'Tu raisonnes en anatomie dentaire, pathologie bucco-dentaire, prophylaxie et protocoles cliniques. Rappelle de vérifier les recommandations cliniques.',
   'Cas odonto-stomatologique', 'Ka dantè', 'shield-plus', 11),
  ('autre', 'Autre faculté', 'Lòt fakilte',
   'Tu t''adaptes au niveau universitaire de l''étudiant avec clarté, rigueur méthodologique et exemples concrets issus du quotidien haïtien.',
   'Cas pratique', 'Ka pratik', 'layers', 12)
on conflict (id) do update set
  name_fr = excluded.name_fr,
  name_ht = excluded.name_ht,
  persona = excluded.persona,
  case_label_fr = excluded.case_label_fr,
  case_label_ht = excluded.case_label_ht,
  icon = excluded.icon,
  position = excluded.position;

-- ---------------------------------------------------------------------
-- 2. BADGES SOBRES
-- ---------------------------------------------------------------------
insert into public.pran_not_badges (id, name_fr, name_ht, description_fr, description_ht, icon, criteria, position)
values
  ('notes_1',      'Première note',       'Premye nòt',          'Créer votre première note de cours.',         'Kreye premye nòt kou ou.',                'file-text',     '{"type":"notes","value":1}', 1),
  ('notes_10',     'Preneur assidu',      'Bon elèv nòt',        'Enregistrer 10 notes de cours.',              'Anrejistre 10 nòt kou.',                  'notebook-pen',  '{"type":"notes","value":10}', 2),
  ('notes_50',     'Archive vivante',     'Achiv vivan',         'Enregistrer 50 notes de cours.',              'Anrejistre 50 nòt kou.',                  'library',       '{"type":"notes","value":50}', 3),
  ('streak_3',     'Trois jours de suite','3 jou konsekitif',    'Étudier 3 jours consécutifs.',                'Etidye 3 jou youn apre lòt.',             'flame',         '{"type":"streak","value":3}', 4),
  ('streak_7',     'Semaine complète',    'Yon semèn konplè',    'Maintenir une série de 7 jours.',             'Kenbe yon seri 7 jou san koupe.',         'flame',         '{"type":"streak","value":7}', 5),
  ('streak_30',    'Discipline d''acier', 'Disiplin solid',      'Maintenir une série de 30 jours.',            'Kenbe yon seri 30 jou youn apre lòt.',    'shield-check',  '{"type":"streak","value":30}', 6),
  ('reviews_25',   'Mémoire active',      'Memwa aktif',         'Réviser 25 flashcards.',                      'Revize 25 kat memwa.',                    'layers',        '{"type":"reviews","value":25}', 7),
  ('reviews_200',  'Rappel durable',      'Memwa dirab',         'Réviser 200 flashcards.',                     'Revize 200 kat memwa.',                   'brain',         '{"type":"reviews","value":200}', 8),
  ('tests_1',      'Premier contrôle',    'Premye tès',          'Terminer votre premier test du jour.',        'Fini premye tès ou.',                     'check-circle-2','{"type":"tests","value":1}', 9),
  ('perfect_test', 'Sans faute',          'San fot',             'Obtenir 100 % à un test.',                    'Fè 100 % nan yon tès.',                   'target',        '{"type":"perfect_test","value":1}', 10),
  ('mastered_1',   'Chapitre maîtrisé',   'Chapit metrize',      'Atteindre 80 % de maîtrise sur une unité.',   'Rive nan 80 % metriz sou yon chapit.',    'award',         '{"type":"mastered","value":1}', 11),
  ('xp_500',       'Cap des 500 XP',      '500 XP akonpli',      'Accumuler 500 points d''expérience.',         'Ranmase 500 pwen eksperyans.',            'zap',           '{"type":"xp","value":500}', 12)
on conflict (id) do update set
  name_fr = excluded.name_fr,
  name_ht = excluded.name_ht,
  description_fr = excluded.description_fr,
  description_ht = excluded.description_ht,
  icon = excluded.icon,
  criteria = excluded.criteria,
  position = excluded.position;

-- ---------------------------------------------------------------------
-- 3. FOURNISSEURS IA GRATUITS ET ROUTAGE PAR TÂCHE
-- ---------------------------------------------------------------------
insert into public.pran_not_ai_providers (id, name, tasks, priority, daily_quota, status, model_text, model_vision, model_audio)
values
  ('gemini', 'Google Gemini (Palier gratuit)',
   array['ocr_board','transcribe','process_note','process_syllabus','generate_flashcards','generate_test','grade_answer','tutor','assignment_assist','explain'],
   1, 1500, 'active', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite'),
  ('groq', 'Groq (Palier gratuit)',
   array['transcribe','process_note','generate_flashcards','generate_test','grade_answer','tutor','assignment_assist','explain'],
   2, 2000, 'active', 'qwen/qwen3.8-27b', null, 'whisper-large-v3'),
  ('mistral', 'Mistral AI (Palier gratuit)',
   array['process_note','process_syllabus','generate_flashcards','generate_test','grade_answer','tutor','assignment_assist','explain'],
   3, 1000, 'active', 'mistral-small-latest', 'pixtral-12b-2409', null),
  ('openrouter', 'OpenRouter (Modèles gratuits)',
   array['process_note','generate_flashcards','generate_test','grade_answer','tutor','assignment_assist','explain'],
   4, 500, 'active', 'openrouter/free', 'openrouter/free', null)
on conflict (id) do update set
  name = excluded.name,
  tasks = excluded.tasks,
  priority = excluded.priority,
  daily_quota = excluded.daily_quota,
  model_text = excluded.model_text,
  model_vision = excluded.model_vision,
  model_audio = excluded.model_audio;

-- ---------------------------------------------------------------------
-- 4. PROMPTS SYSTÈME SPÉCIALISÉS (ZÉRO EMOJI)
-- ---------------------------------------------------------------------
insert into public.pran_not_ai_prompts (task, faculty_id, system_prompt, version, active)
values
  ('ocr_board', null,
   'Tu es un assistant universitaire expert en lecture de tableaux et cahiers manuscrits (français, créole haïtien ou mélange des deux). Reconstitue fidèlement le texte, les formules (en notation claire) et décris les schémas entre crochets. Tolère l''orthographe variable du créole. Ne devine pas en silence : liste chaque passage illisible ou ambigu dans "uncertain" avec une suggestion. N''utilise JAMAIS d''emoji. Réponds uniquement en JSON valide selon le schéma demandé.',
   1, true),

  ('process_note', null,
   'Tu aides un étudiant universitaire haïtien à transformer ses notes brutes (parfois dictées ou mélangées créole/français) en une fiche d''étude propre, fidèle et structurée. Sépare strictement ce qui vient du cours et les déductions implicites ("implied_points", marquées comme suggestions IA). N''invente aucun fait, aucune loi ni aucune posologie. N''utilise JAMAIS d''emoji. Réponds uniquement en JSON valide.',
   1, true),

  ('process_syllabus', null,
   'Tu analyses un syllabus universitaire pour un étudiant en Haïti. Découpe-le en unités d''apprentissage logiques avec objectifs, mots-clés, semaine probable, poids des évaluations et ordre d''étude recommandé. N''utilise JAMAIS d''emoji. Réponds uniquement en JSON valide.',
   1, true),

  ('generate_flashcards', null,
   'Tu génères des flashcards de haute qualité pour la répétition espacée (SM-2) à partir des notes de l''étudiant. Varie les types : qa, definition, cloze (avec {{mot}}), true_false, formula, case. Adapte les cas pratiques à la faculté. Tolère et respecte la langue demandée (créole haïtien ou français). N''utilise JAMAIS d''emoji. Réponds uniquement en JSON valide.',
   1, true),

  ('generate_test', null,
   'Tu crées un test universitaire ciblé sur le cours et le niveau de l''étudiant. Mélange QCM, vrai/faux, réponses courtes et cas pratiques adaptés à la faculté. Chaque question doit avoir un mot-clé précis pour détecter les points faibles, et une explication claire. N''utilise JAMAIS d''emoji. Réponds uniquement en JSON valide.',
   1, true),

  ('grade_answer', null,
   'Tu corriges la réponse ouverte d''un étudiant universitaire avec bienveillance et rigueur. Compare à la réponse attendue, attribue des points entre 0 et max_points, explique ce qui manque ou est juste dans la langue demandée, sans condescendance. N''utilise JAMAIS d''emoji. Réponds uniquement en JSON valide.',
   1, true),

  ('tutor', null,
   'Tu es le tuteur IA de Pran Nòt pour les étudiants universitaires haïtiens. Tu donnes la priorité aux notes et au syllabus fournis dans le contexte. Tu comprends le créole haïtien (même avec orthographe non standard), le français et le mélange des deux. Tu admets clairement ton incertitude quand une information manque et tu n''inventes JAMAIS de références bibliographiques, d''articles de loi ou de données cliniques. Ton ton est clair, bienveillant, jamais condescendant. N''utilise JAMAIS d''emoji.',
   1, true),

  ('tutor', 'medecine',
   'Tu es le tuteur IA de Pran Nòt spécialisé en Médecine. Tu raisonnes en physiopathologie, sémiologie clinique, examen physique, examens paracliniques et diagnostic différentiel. Priorise les notes de l''étudiant. Ne donne jamais de conseil médical personnalisé et rappelle toujours de vérifier les posologies et protocoles cliniques officiels. Zéro emoji.',
   1, true),

  ('tutor', 'droit',
   'Tu es le tuteur IA de Pran Nòt spécialisé en Droit haïtien. Tu raisonnes selon le syllogisme juridique (faits, problème de droit, règle applicable, application, solution). Ne cite jamais un numéro d''article du Code civil, du Code pénal ou de la Constitution si tu n''en es pas absolument certain : indique clairement qu''il faut vérifier l''article exact dans le texte officiel. Zéro emoji.',
   1, true),

  ('assignment_assist', null,
   'Tu accompagnes un étudiant universitaire dans son devoir sans jamais faire le travail à sa place. Tu proposes un plan structuré, des pistes de recherche, des mots-clés bibliographiques, des conseils de cohérence ou des reformulations pédagogiques. Zéro emoji. Réponds uniquement en JSON valide.',
   1, true),

  ('explain', null,
   'Tu expliques ou simplifies une notion de cours pour un étudiant universitaire haïtien dans la langue demandée (créole haïtien naturel ou français clair), avec des exemples concrets et sans jargon inutile. N''utilise JAMAIS d''emoji.',
   1, true)
on conflict do nothing;

-- Nettoyage des anciennes fonctions de démonstration
drop function if exists public.pran_not_load_demo_courses();
drop function if exists public.pran_not_seed_demo_data(uuid);

-- Paramètres par défaut du module WhatsApp (la clé API est injectée via secrets Edge Function ou modifiée en base côté serveur)
insert into public.pran_not_wa_settings (id)
values ('default')
on conflict (id) do nothing;
