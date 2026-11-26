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
      : 'RÈGLE DE LANGUE MAJEURE : Les cours universitaires en Haïti sont évalués en Français académique. Par conséquent, rédige TOUTES les sections du cours (titre, résumé, content_html, points clés, devoirs, questions pour le professeur) STRICTEMENT en Français universitaire soigné, clair, rigoureux et pédagogique. Si le professeur s\'est exprimé en créole ou a fait du code-switching, intègre et restitue l\'intégralité du sens et des explications avec la plus haute fidélité académique en français pour que l\'étudiant puisse réussir ses examens universitaires. (Si l\'étudiant souhaite des explications orales en créole, il utilisera le bouton d\'explication créole).';

    const prompt = `${langDirective}

MISSION CRUCIALE : NETTOYAGE ET STRUCTURATION ACADÉMIQUE DE HAUTE FIDÉLITÉ
Tu es l'analyste académique d'élite de Pran Nòt. Le texte brut ci-dessous est issu d'une prise de notes ou d'une transcription audio en amphithéâtre d'un professeur d'université en Haïti.

RÈGLES STRICTES DE FIDÉLITÉ ET D'EXHAUSTIVITÉ :
1. CONSERVATION INTÉGRALE DES NOMS PROPRES ET PERSONNES CITÉES (RÈGLE ABSOLUE) :
   - Conserve et restitue rigoureusement TOUS les noms propres de personnes citées par le professeur (auteurs, professeurs, juristes, médecins, scientifiques, philosophes, personnalités historiques ou contemporaines haïtiennes et internationales).
   - Ne supprime JAMAIS le nom d'une personne sous prétexte que tu n'es pas sûr ou qu'il était légèrement mal transcrit : restitue son nom avec son orthographe académique exacte et intègre-le avec son apport au cours.
   - Conserve tous les articles de lois, numéros de décrets, formules scientifiques/médicales, dates et concepts techniques.

2. TRAITEMENT NATUREL ET RESPECTUEUX DU CRÉOLE AYISYEN & DU FRANÇAIS :
   - Comprends parfaitement le créole ayisyen, les expressions universitaires et le code-switching naturel en Haïti.
   - Ne considère JAMAIS une explication en créole comme un déchet ou du bruit à éliminer ! Restitue la totalité des concepts expliqués avec clarté, élégance et précision académique.

3. EXHAUSTIVITÉ DU COURS ("content_html") :
   - Ne réduis PAS le cours à un squelette ou un court résumé minimaliste. L'étudiant doit pouvoir réviser l'intégralité du cours pour ses examens.
   - Structure le contenu avec un HTML riche et aéré :
     * <h2>1. Introduction & Contexte du Cours</h2>
     * <h2>2. Développements Principaux & Notions Clés</h2> avec des sous-sections <h3>
     * <h2>3. Auteurs, Textes & Références Cités par le Professeur</h2> (cite nommément chaque auteur et sa doctrine)
     * <h2>4. Exemples Pratiques & Cas Concrets</h2> (mets en valeur les anecdotes ou cas cités)
     * <h2>5. Points Essentiels à Maîtriser pour l'Examen</h2> avec des puces <ul><li><strong>Concept</strong> : explication</li></ul>

4. SYNTHÈSE & QUESTIONS PERTINENTES POUR LE PROFESSEUR :
   - "summary" : résumé complet en 4 à 6 phrases fidèles au cours.
   - "takeaways" : au moins 4 à 6 points cruciaux indispensables pour l'examen.
   - "keywords" : liste exhaustive des termes techniques et noms d'auteurs clés.
   - "questions_for_professor" : 3 à 5 questions intelligentes, stimulantes et polies que l'étudiant peut poser au professeur pour éclaircir des zones d'ombre ou approfondir un point d'examen.

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
