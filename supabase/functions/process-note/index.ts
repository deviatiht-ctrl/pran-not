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

    const langDirective = `RÈGLE MAJEURE DE BILINGUISME INTÉGRAL & EXHAUSTIVITÉ :
Tu dois impérativement fournir les DEUX versions complètes du cours :
1. "content_html" : Version académique en Français universitaire soigné, rigoureux, précis et exhaustif pour réussir les examens.
2. "content_html_ht" : Vèsyon pedagojik konplè an Kreyòl Ayisyen klè, vivan, ak egzanp konkrè ki fasil pou etidyan an konprann pwofondèman.
3. "simple_explanation_fr" & "simple_explanation_ht" : Explication simple étape par étape sans jargon technique (en français et en kreyòl).
4. "exam_qa" : 4 à 6 questions et réponses types d'examen avec explications détaillées.
5. "questions_for_professor" : 3 à 5 questions intelligentes à poser au professeur.`;

    const prompt = `${langDirective}

MISSION CRUCIALE : NETTOYAGE ET STRUCTURATION ACADÉMIQUE DE HAUTE FIDÉLITÉ
Tu es l'analyste académique d'élite de Pran Nòt. Le texte brut ci-dessous est issu d'une prise de notes ou d'une transcription audio en amphithéâtre d'un professeur d'université en Haïti.

RÈGLES STRICTES DE FIDÉLITÉ ET D'EXHAUSTIVITÉ :
1. CONSERVATION INTÉGRALE DES NOMS PROPRES ET PERSONNES CITÉES (RÈGLE ABSOLUE) :
   - Conserve et restitue rigoureusement TOUS les noms propres de personnes citées par le professeur (auteurs, professeurs, juristes, médecins, scientifiques, philosophes, personnalités historiques ou contemporaines haïtiennes et internationales).
   - Ne supprime JAMAIS le nom d'une personne sous prétexte que tu n'es pas sûr : restitue son nom avec son orthographe académique exacte et intègre-le avec son apport au cours.
   - Conserve tous les articles de lois, numéros de décrets, formules scientifiques/médicales, dates et concepts techniques.

2. TRAITEMENT NATUREL ET RESPECTUEUX DU CRÉOLE AYISYEN & DU FRANÇAIS :
   - Comprends parfaitement le créole ayisyen, les expressions universitaires et le code-switching naturel en Haïti.
   - Ne considère JAMAIS une explication en créole comme un déchet ou du bruit à éliminer ! Restitue la totalité des concepts expliqués avec clarté, élégance et précision académique.

3. EXHAUSTIVITÉ DU COURS ("content_html" en français ET "content_html_ht" en kreyòl) :
   - Ne réduis PAS le cours à un squelette ou un court résumé minimaliste. L'étudiant doit pouvoir réviser l'intégralité du cours pour ses examens.
   - Structure le contenu avec un HTML riche et aéré :
     * <h2>1. Introduction & Contexte du Cours</h2>
     * <h2>2. Développements Principaux & Notions Clés</h2> avec des sous-sections <h3>
     * <h2>3. Auteurs, Textes & Références Cités par le Professeur</h2>
     * <h2>4. Exemples Pratiques & Cas Concrets</h2>
     * <h2>5. Points Essentiels à Maîtriser pour l'Examen</h2> avec des puces <ul><li><strong>Concept</strong> : explication</li></ul>

4. EXAM_QA ET QUESTIONS PERTINENTES POUR LE PROFESSEUR :
   - "exam_qa" : Fournis 4 à 6 questions probables d'examen avec des réponses modèles très complètes et des explications.
   - "questions_for_professor" : 3 à 5 questions intelligentes, stimulantes et polies que l'étudiant peut poser au professeur.

Cours existants de l'étudiant : ${JSON.stringify(courses.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })))}

Retourne STRICTEMENT ce JSON :
{
  "title": "Titre court, précis et académique de la séance (en Français)",
  "title_ht": "Tit kout, klè e presi nan seyans la (an Kreyòl)",
  "summary": "Résumé clair, percutant et complet en 4 à 6 phrases (Français)",
  "summary_ht": "Rezime klè, konplè an 4 a 6 fraz (Kreyòl)",
  "verbatim_raw": "Retranscription nettoyée des passages clés du professeur",
  "content_html": "HTML complet et riche en Français universitaire soigné",
  "content_html_ht": "HTML konplè ak rich an Kreyòl Ayisyen pedagojik",
  "simple_explanation_fr": "Explication simple, fluide, sans jargon pour révision rapide",
  "simple_explanation_ht": "Eksplikasyon senp, etap pa etap san mo difisil an Kreyòl",
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
  "exam_qa": [
    {
      "question": "Question classique ou piège susceptible de tomber à l'examen",
      "answer": "Réponse modèle complète, rigoureuse et argumentée",
      "explanation": "Pourquoi cette réponse est attendue et critères de notation"
    }
  ],
  "questions_for_professor": [
    {
      "question": "Question académique précise et stimulante à poser au professeur",
      "purpose": "Pourquoi cette question éclaire un point subtil ou prépare l'examen",
      "hint": "Élément clé à écouter dans l'explication du professeur"
    }
  ],
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
