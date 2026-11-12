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

    const prompt = `Analyse ce syllabus universitaire (droit, médecine, économie, génie, sciences, etc.).
Découpe-le en chapitres / unités d'apprentissage claires et exploitables par l'étudiant.
Extrais également les livres ou codes recommandés (ex : Code civil, Constitution, manuels), les devoirs et pondérations d'examen.

Retourne STRICTEMENT ce JSON :
{
  "course_title": "Titre exact du cours",
  "professor": "Nom de l'enseignant si présent",
  "objectives": ["Objectif général 1", "Objectif 2"],
  "evaluation": "Résumé clair du poids des évaluations (ex : Intra 30 %, TP 20 %, Final 50 %)",
  "recommended_books": ["Livre ou code juridique recommandé 1", "Livre 2"],
  "study_order": ["Titre unité 1", "Titre unité 2"],
  "units": [
    {
      "title": "Titre du chapitre / de l'unité",
      "description": "Résumé court du contenu",
      "objectives": ["Objectif spécifique 1", "Objectif 2"],
      "keywords": ["mot-clé 1", "mot-clé 2", "mot-clé 3"],
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
