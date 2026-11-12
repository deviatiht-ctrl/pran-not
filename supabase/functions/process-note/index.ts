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
      ? 'Harmonise et traduis proprement tout le texte en créole haïtien clair (garde les termes techniques entre parenthèses).'
      : mode === 'harmonize_fr'
        ? 'Harmonise et traduis proprement tout le texte en français universitaire clair.'
        : `Produis la fiche propre principalement en ${language === 'fr' ? 'français' : 'créole haïtien'}, en corrigeant l'orthographe et les erreurs de transcription.`;

    const prompt = `${langDirective}

Cours existants de l'étudiant : ${JSON.stringify(courses.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })))}

Retourne STRICTEMENT ce JSON :
{
  "title": "Titre court et précis de la séance",
  "summary": "Résumé clair en 5 lignes maximum",
  "content_html": "HTML propre utilisant uniquement <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <code>, <blockquote> (plan structuré, définitions, points clés, exemples, formules)",
  "takeaways": ["Point clé 1 à retenir", "Point clé 2", "Point clé 3"],
  "keywords": ["mot-clé 1", "mot-clé 2", "mot-clé 3", "mot-clé 4"],
  "implied_points": ["Déduction ou idée implicite du professeur clairement formulée comme suggestion d'étude (et non comme propos littéral du professeur)"],
  "suggested_course_id": "uuid du cours le plus pertinent parmi les cours existants, ou null"
}

Note brute à traiter :
${rawText.slice(0, 18000)}`;

    const out = await runAiTask(auth.admin, auth.user.id, auth.profile?.ai_daily_quota || 60, {
      task: 'process_note',
      faculty,
      level,
      language,
      prompt,
      expectJson: true,
      cacheKeyPayload: { rawText: rawText.slice(0, 18000), mode, language },
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
