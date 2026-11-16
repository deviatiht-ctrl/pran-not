// Edge Function : process-note
// Nettoyage, correction, harmonisation créole/français, structuration et suggestion de cours
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
    const rawText = String(body.rawText || '').trim();
    if (!rawText) return errorResponse('invalid_input', 'Texte brut manquant.', 400);

    const faculty = body.faculty || auth.profile?.faculty_id || 'autre';
    const level = body.level || auth.profile?.level || 'L1';
    const language = body.language || auth.profile?.language || 'ht';
    const mode = String(body.mode || 'standard'); // 'standard' | 'harmonize_ht' | 'harmonize_fr'

    // Charger les cours de l'étudiant si non fournis pour suggérer le rattachement
    let courses = Array.isArray(body.courses) ? body.courses : [];
    if (!courses.length) {
      const { data: cRows } = await auth.admin
        .from('pran_not_courses')
        .select('id, name, professor')
        .eq('user_id', auth.user.id)
        .eq('archived', false);
      courses = cRows || [];
    }

    const langDirective = mode === 'harmonize_ht'
      ? 'Langue principale demandée : KREYÒL AYISYEN klè, natirèl, akademik e pedagojik (mete tèm teknik franse yo ant parantèz).'
      : mode === 'harmonize_fr'
        ? 'Langue principale demandée : Français universitaire soigné, clair et pédagogique.'
        : `Langue de synthèse : ${language === 'fr' ? 'Français académique soigné' : 'Kreyòl ayisyen natirèl e klè'}.`;

    const prompt = `${langDirective}

MISSION CRUCIALE D'EXTRACTION & DE PURIFICATION PÉDAGOGIQUE :
Tu es l'analyste académique d'élite de Pran Nòt. Le texte brut ci-dessous est issu d'une prise de notes ou d'une transcription audio en direct de la classe d'un professeur d'université.
Ce texte brut contient des bruits parasites, des interruptions, des phrases inachevées, des digressions inutiles, ou des hallucinations de transcription vocale.

TES OBLIGATIONS STRICTES DE STRUCTURATION :
1. PURIFICATION RADICALE DU BRUIT & SÉPARATION INTELLIGENTE :
   - Écarte TOTALEMENT les bruits parasites, les bavardages, les phrases sans queue ni tête et les hésitations.
   - Si le professeur a parlé en kreyòl avec des expressions de tous les jours ou approximatives, ne les retranscris JAMAIS de manière brute ou informe ! Transforme-les en explications limpides, structurées et pédagogiques.
2. SYNTHÈSE PUISSANTE & POINT PAR POINT ("content_html") :
   - Ne produis JAMAIS un gros bloc de texte indigeste ou un simple paragraphe au kilomètre.
   - Structure le contenu avec des sections titrées claires :
     * <h2>Introduction & Notions Clés</h2>
     * <h2>Développements & Explications Approfondies</h2> avec des sous-titres <h3>
     * <h2>Points Essentiels à Retenir pour les Examens</h2> sous forme de listes à puces <ul><li><strong>Concept</strong> : explication...</li></ul>
     * <h2>Exemples & Cas Concrets du Professeur</h2> (mets en valeur les exemples donnés en classe avec des <blockquote> ou <em>)
3. POINTS CLÉS POUR EXAMEN ("takeaways") :
   - Liste au moins 3 à 6 points cruciaux indispensables à retenir pour réussir l'examen sur ce cours.
4. RÉSUMÉ EXÉCUTIF ("summary") :
   - Rédige un résumé percutant, clair et complet en 4 à 6 phrases synthétisant exactement la thèse et les leçons principales de la séance.
5. DEVOIRS & MOTS-CLÉS :
   - Remplis rigoureusement "homework" si un travail a été annoncé.
   - Isole les termes techniques exacts dans "keywords".

Cours existants de l'étudiant : ${JSON.stringify(courses.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })))}

Retourne STRICTEMENT ce JSON :
{
  "title": "Titre court, précis et académique de la séance",
  "summary": "Résumé clair, percutant et complet en 4 à 6 phrases",
  "verbatim_raw": "Retranscription nettoyée des passages clés du professeur",
  "content_html": "HTML propre avec <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote> (organisé par grandes rubriques, définitions nettes, listes à puces aérées, points d'examen)",
  "takeaways": ["Point clé 1 indispensable pour examen", "Point clé 2", "Point clé 3", "Point clé 4"],
  "keywords": ["mot-clé 1", "mot-clé 2", "mot-clé 3", "mot-clé 4"],
  "corrections": [
    { "original": "mot ou phrase approximative", "corrected": "formulation exacte et académique", "reason": "faute de transcription ou lapsus oral" }
  ],
  "homework": [
    { "title": "Devoir ou travail mentionné", "due_hint": "Échéance ou date mentionnée", "description": "Consignes données" }
  ],
  "research_topics": ["Thème ou ressource de droit/médecine/ingénierie/lettres à approfondir"],
  "implied_points": ["Déduction ou idée implicite formulée sobrement"],
  "suggested_course_id": "uuid du cours le plus pertinent parmi les cours existants, ou null"
}

Texte brut de cours à traiter :
${rawText.slice(0, 22000)}`;

    const out = await runAiTask(auth.admin, auth.user.id, auth.profile?.ai_daily_quota || 500, {
      task: 'process_note',
      faculty,
      level,
      language,
      prompt,
      expectJson: true,
      cacheKeyPayload: { rawText: rawText.slice(0, 22000), mode, language },
    });

    const structured = out.result as Record<string, unknown>;
    const validCourseId = courses.some((c: { id: string }) => c.id === structured?.suggested_course_id)
      ? String(structured.suggested_course_id)
      : null;
    structured.suggested_course_id = validCourseId;

    if (body.noteId) {
      const contentHtml = String(structured.content_html || `<p>${rawText}</p>`);
      const contentText = contentHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      await auth.admin
        .from('pran_not_notes')
        .update({
          title: String(structured.title || 'Nòt'),
          summary: String(structured.summary || ''),
          content_html: contentHtml,
          content_text: contentText,
          structured,
          ai_course_suggestion: validCourseId,
          status: 'ready',
        })
        .eq('id', body.noteId)
        .eq('user_id', auth.user.id);

      const kwList = Array.isArray(structured.keywords) ? structured.keywords.slice(0, 10) : [];
      for (const kw of kwList) {
        const term = String(kw || '').trim();
        if (!term) continue;
        let q = auth.admin
          .from('pran_not_keywords')
          .select('id')
          .eq('user_id', auth.user.id)
          .ilike('term', term);
        q = validCourseId ? q.eq('course_id', validCourseId) : q.is('course_id', null);
        const { data: existingKw } = await q.maybeSingle();
        if (!existingKw) {
          await auth.admin.from('pran_not_keywords').insert({
            user_id: auth.user.id,
            course_id: validCourseId,
            note_id: body.noteId,
            term,
          });
        }
      }
    }

    return jsonResponse({ ok: true, ...structured, provider: out.provider, cached: out.cached });
  } catch (err) {
    if (err instanceof QuotaExceededError) return errorResponse('quota_exceeded', err.message, 429);
    console.error('[process-note]', err);
    return errorResponse('process_note_error', (err as Error).message || 'Erreur traitement note', 500);
  }
});
