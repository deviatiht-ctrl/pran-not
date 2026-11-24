// Edge Function : process-syllabus
// Analyse d'un syllabus (texte ou photo) en unités d'apprentissage structurées
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { authenticateUser } from '../_shared/supabase.ts';
import { QuotaExceededError, runAiTask } from '../_shared/ai.ts';

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  try {
    const auth = await authenticateUser(req);
    if ('error' in auth) return errorResponse(auth.error, 'Non authentifié', auth.status);

    const body = await req.json();
    const text = String(body.text || '').trim();
    const imageBase64 = body.imageBase64 ? String(body.imageBase64) : '';
    if (!text && !imageBase64) {
      return errorResponse('invalid_input', 'Texte ou image du syllabus manquant.', 400);
    }

    const faculty = body.faculty || auth.profile?.faculty_id || 'autre';
    const level = body.level || auth.profile?.level || 'L1';
    const language = body.language || auth.profile?.language || 'ht';

    const prompt = `MISSION : ANALYSE ET STRUCTURATION EXPERTE DE SYLLABUS UNIVERSITAIRE
Tu es l'ingénieur pédagogique en chef de Pran Nòt, spécialisé dans les programmes universitaires en Haïti (Droit, Médecine, Sciences Économiques, Sciences Informatiques, Génie, Agronomie, Lettres, etc.).

Le texte brut ou document ci-dessous est un plan de cours / syllabus universitaire.
Ta tâche est de le structurer rigoureusement en un découpage chronologique clair, précis et hautement exploitable par l'étudiant pour ses révisions.

RÈGLES STRICTES DE STRUCTURATION :
1. DÉCOUPAGE CHRONOLOGIQUE ET COHÉRENT EN UNITÉS / CHAPITRES :
   - Extrais tous les chapitres ou unités dans l'ordre pédagogique exact (ex: Chapitre 1, Chapitre 2, ...).
   - Chaque unité doit comporter :
     * "title" : Titre académique clair (ex: "Chapitre 1 : Les sources constitutionnelles du droit").
     * "description" : Synthèse substantielle des thèmes abordés (3 à 5 lignes détaillant les notions clés).
     * "objectives" : 2 à 4 compétences précises que l'étudiant doit maîtriser à la fin de cette unité.
     * "keywords" : 4 à 8 termes techniques, concepts ou noms d'auteurs fondamentaux de cette unité.
     * "planned_week" : Numéro de semaine estimé (1, 2, 3...).
     * "weight" : Poids estimé en pourcentage pour l'examen (le total des unités doit avoisiner 100).

2. LIVRES ET CODES DE RÉFÉRENCE :
   - Isole tous les ouvrages, codes juridiques, manuels médicaux ou références cités dans le syllabus.

3. ÉVALUATIONS & OBJECTIFS GLOBAUX :
   - Résume avec exactitude les modalités d'évaluation (Intra, Devoirs/TP, Examen Final avec pourcentages).
   - Dégage les grands objectifs d'apprentissage du cours.

Langue demandée : ${language === 'fr' ? 'Français académique soigné' : 'Kreyòl ayisyen natirèl e klè (ak tèm teknik franse yo si nesesè)'}.

Retourne STRICTEMENT ce JSON :
{
  "course_title": "Titre exact du cours",
  "professor": "Nom complet de l'enseignant ou professeur si présent",
  "objectives": ["Objectif général 1", "Objectif général 2", "Objectif général 3"],
  "evaluation": "Modalités d'évaluation (ex: Examen Intra 30%, TP/Devoirs 20%, Examen Final 50%)",
  "recommended_books": ["Titre livre/code 1", "Titre livre 2"],
  "study_order": ["Chapitre 1", "Chapitre 2", "Chapitre 3"],
  "units": [
    {
      "title": "Titre du chapitre / unité",
      "description": "Description détaillée des concepts et sous-thèmes abordés",
      "objectives": ["Objectif spécifique 1", "Objectif spécifique 2"],
      "keywords": ["terme 1", "terme 2", "terme 3", "terme 4"],
      "planned_week": 1,
      "weight": 15
    }
  ]
}

Contenu du syllabus :
${text.slice(0, 28000)}`;

    const out = await runAiTask(auth.admin, auth.user.id, auth.profile?.ai_daily_quota || 500, {
      task: 'process_syllabus',
      faculty,
      level,
      language,
      prompt,
      imagesBase64: imageBase64 ? [imageBase64] : undefined,
      expectJson: true,
      cacheKeyPayload: { text: text.slice(0, 28000), hasImg: Boolean(imageBase64), language },
    });

    const analysis = out.result as Record<string, unknown>;

    if (body.syllabusId) {
      await auth.admin
        .from('pran_not_syllabi')
        .update({ analysis, status: 'done' })
        .eq('id', body.syllabusId)
        .eq('user_id', auth.user.id);
    }

    return jsonResponse({ ok: true, analysis, provider: out.provider, cached: out.cached });
  } catch (err) {
    if (err instanceof QuotaExceededError) return errorResponse('quota_exceeded', err.message, 429);
    console.error('[process-syllabus]', err);
    return errorResponse('syllabus_error', (err as Error).message || 'Erreur analyse syllabus', 500);
  }
});
