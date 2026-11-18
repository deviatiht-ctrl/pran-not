// Edge Function : assignment-assist
// Accompagnement méthodologique aux devoirs (plan, pistes, cohérence, bibliographie,
// reformulation et recherche documentaire sur la Bibliothèque + Codes officiels)
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
    const action = String(body.action || 'plan'); // 'solve' | 'plan' | 'coherence' | 'biblio' | 'rephrase' | 'library_research' | 'critique_submission' | 'qa' | 'instruct' | 'explain_details'
    const title = String(body.title || '').trim();
    const instructions = String(body.instructions || '').trim();
    const content = String(body.content || '').trim();
    const question = String(body.question || '').trim();
    const useLibrary = body.useLibrary !== false;
    const bookIds = Array.isArray(body.bookIds) ? body.bookIds.filter(Boolean).slice(0, 5) : [];

    if (!title && !instructions && !content && !question) {
      return errorResponse('invalid_input', 'Sujet ou contenu du devoir manquant.', 400);
    }

    // Déterminer le texte effectif et la consigne pour ne JAMAIS avoir de texte vide
    const effectiveContent = content || instructions || question || title;
    const effectiveInstructions = instructions || question || title || content;
    const effectiveTarget = question || instructions || title || content;

    const isGlobal = body.scope === 'global' || body.faculty === 'general' || body.faculty === 'global';
    const faculty = isGlobal ? 'general' : (body.faculty || auth.profile?.faculty_id || 'general');
    const level = body.level || auth.profile?.level || 'L1';
    const language = body.language || auth.profile?.language || 'ht';

    // Détecter si la consigne concerne la grammaire, la conjugaison ou la langue française
    const combinedQuery = `${title} ${instructions} ${question} ${content.slice(0, 300)}`.toLowerCase();
    const isGrammarOrLanguage = /verbe|conjug|grammai|orthograph|participe|subjonctif|imparfait|passé simple|passé composé|futur|conditionnel|accord |temps de l|temps du verbe|contraindre|contreindre/i.test(combinedQuery);
    const effectiveFaculty = isGlobal || isGrammarOrLanguage ? 'general' : faculty;

    // Recherche contextuelle dans les livres, manuels et codes juridiques de la Bibliothèque (sauf si purement linguistique ou mode global)
    let librarySources: Array<{
      book_id: string;
      book_title: string;
      author: string;
      category: string;
      section_label: string;
      page_number: number | null;
      excerpt: string;
    }> = [];
    let libraryContext = '';

    if (!isGlobal && (useLibrary || action === 'library_research') && !isGrammarOrLanguage) {
      const searchQuery = [title, instructions].filter(Boolean).join(' ').slice(0, 220) || content.slice(0, 220);
      try {
        const { data: libHits } = await auth.userClient.rpc('pran_not_search_library', {
          p_query: searchQuery,
          p_faculty: faculty,
          p_scope: null,
          p_book_id: bookIds.length === 1 ? bookIds[0] : null,
          p_limit: 8,
        });
        let hits = Array.isArray(libHits) ? libHits : [];
        if (bookIds.length > 1) {
          const filtered = hits.filter((h: Record<string, unknown>) => bookIds.includes(String(h.book_id)));
          if (filtered.length) hits = filtered;
        }
        librarySources = hits.slice(0, 6).map((h: Record<string, unknown>) => ({
          book_id: String(h.book_id || ''),
          book_title: String(h.book_title || 'Ouvrage'),
          author: String(h.author || ''),
          category: String(h.category || 'manuel'),
          section_label: String(h.section_label || ''),
          page_number: typeof h.page_number === 'number' ? h.page_number : null,
          excerpt: String(h.content || '').slice(0, 280),
        }));
        if (hits.length) {
          libraryContext = hits.slice(0, 6).map((h: Record<string, unknown>, i: number) =>
            `[Liv #${i + 1} : ${h.book_title}${h.section_label ? ` — ${h.section_label}` : ''}${h.page_number ? ` (p. ${h.page_number})` : ''}]\n${String(h.content || '').slice(0, 1100)}`
          ).join('\n\n');
        }
      } catch (libErr) {
        console.warn('[assignment-assist] library search skipped:', libErr);
      }
    }

    let prompt = '';
    if (action === 'solve' || action === 'draft_full') {
      prompt = `Tu es l'assistant d'excellence de rédaction et de résolution intégrale de devoirs universitaires et scolaires pour l'étudiant.
L'étudiant te demande de résoudre complètement son exercice, son devoir ou sa consigne de manière exhaustive, rigoureuse, soignée et immédiatement prête à l'emploi.

RÈGLES CAPITALES :
1. RÉSOLUTION INTÉGRALE ET CONCRÈTE : Résous ou rédige TOUT le devoir demandé. Ne dis JAMAIS que le texte est introuvable ou vide. Ne renvoie JAMAIS l'étudiant à faire le travail seul, et ne te contente pas d'un simple plan quand une résolution ou rédaction complète est demandée.
2. CONJUGAISON & GRAMMAIRE : Si la consigne porte sur une conjugaison (ex: un verbe à tous les temps, comme "contraindre"), fournis TOUS les modes (indicatif, subjonctif, conditionnel, impératif, participe, infinitif, gérondif) et TOUS les temps sans exception ni omission :
- Indicatif : Présent, Imparfait, Passé simple, Futur simple, Passé composé, Plus-que-parfait, Passé antérieur, Futur antérieur.
- Subjonctif : Présent, Imparfait, Passé, Plus-que-parfait.
- Conditionnel : Présent, Passé 1ère forme, Passé 2ème forme.
- Impératif : Présent, Passé.
- Participe : Présent, Passé composé.
- Infinitif : Présent, Passé.
- Gérondif : Présent, Passé.
Présente chaque mode et chaque temps clairement avec toutes les personnes (je/tu/il/nous/vous/ils).
3. EXERCICE & PROBLÈMES : Fournis la résolution intégrale, étape par étape, détaillée, avec justification des résultats ou argumentation rédigée.
4. DISSERTATION & DÉVELOPPEMENT : Rédige une introduction complète, un développement structuré avec titres clairs, et une conclusion.
5. DOMAINE ACADÉMIQUE : Traite le sujet dans sa matière exacte (langue française, conjugaison, mathématiques, économie, droit, etc.) sans forcer de biais hors-sujet.
6. AUCUN EMOJI : Absolument aucun emoji dans le texte.

Retourne STRICTEMENT ce JSON :
{
  "content_proposal": "Texte complet, structuré et rédigé de la solution ou du devoir prêt à être inséré",
  "explanation": "Explication méthodologique ou règles clés appliquées",
  "tips": ["Conseil ou règle essentielle à retenir pour réussir ce type d'exercice"]
}

Titre du devoir : ${title || 'Devoir'}
Consigne officielle ou exercice à résoudre :
${effectiveTarget}
${content ? `Brouillon actuel ou extrait du devoir déjà saisi par l'étudiant :\n${content.slice(0, 4000)}\n` : ''}
${libraryContext ? `\nEXTRAITS PERTINENTS DE LA BIBLIOTHÈQUE :\n${libraryContext}\n` : ''}`;
    } else if (action === 'instruct') {
      prompt = `L'étudiant te donne une consigne ou des directives spécifiques sur son devoir. Tu es son assistant IA personnel de rédaction et d'étude.
RÈGLES IMPORTANTES :
1. Exécute EXACTEMENT et COMPLÈTEMENT ce que l'étudiant te demande (rédiger un passage, développer une argumentation, résoudre un exercice, conjuguer un verbe à tous les temps, faire une synthèse).
2. Ne dis JAMAIS que le texte est introuvable ou vide.
3. Fournis un contenu directement réutilisable et complet dans son devoir, sans tronquer.
4. Si la demande concerne la langue française (conjugaison, grammaire, orthographe), fournis la réponse complète en français impeccable.
5. Reste clair, structuré, académique et sans remplissage inutile.
6. Aucun emoji.

Retourne STRICTEMENT ce JSON :
{
  "content_proposal": "Texte rédigé selon les consignes de l'étudiant à insérer dans le devoir",
  "explanation": "Explication claire de la démarche suivie pour répondre à la consigne",
  "tips": ["Conseil ou rappel clé"]
}

Titre du devoir : ${title || 'Devoir'}
Consigne / Directive de l'étudiant :
${effectiveTarget}
${content ? `Brouillon actuel :\n${content.slice(0, 4000)}\n` : ''}`;
    } else if (action === 'explain_details') {
      prompt = `L'étudiant demande une EXPLICATION DÉTAILLÉE et didactique de son devoir ou de sa consigne d'exercice.
RÈGLES IMPORTANTES :
1. Si un devoir complet ou un brouillon est fourni, explique dans les moindres détails les concepts clés, le raisonnement utilisé, et chaque étape de la démonstration ou de la rédaction.
2. Si le devoir n'est pas encore rédigé et que seule la consigne/l'exercice est fourni, explique en détail la consigne : ce que demande le professeur, les notions théoriques indispensables, la méthode étape par étape pour y répondre, et les pièges classiques à éviter.
3. Ne dis JAMAIS qu'aucun devoir ou texte n'a été trouvé car le sujet ou brouillon est obligatoirement fourni ci-dessous.
4. Sois très didactique, complet et facile à comprendre.
5. Aucun emoji.

Retourne STRICTEMENT ce JSON :
{
  "global_summary": "Vue d'ensemble du devoir ou de la consigne et de son fil conducteur",
  "detailed_breakdown": [
    { "part": "Nom de la section ou notion", "explanation": "Explication complète et détaillée de ce qui y est fait ou attendu" }
  ],
  "key_learnings": ["Notion clé 1 à retenir", "Notion clé 2"],
  "oral_defense_tips": ["Conseil pour présenter ce devoir devant le professeur"]
}

Titre du devoir : ${title || 'Devoir'}
Consigne du professeur : ${effectiveInstructions}
${content ? `Devoir rédigé par l'étudiant :\n${content.slice(0, 14000)}` : `Sujet / Consigne à analyser et expliquer en détail :\n${effectiveContent.slice(0, 14000)}`}`;
    } else if (action === 'qa') {
      prompt = `Tu es le tuteur d'assistance pour le devoir de l'étudiant.
RÈGLES IMPORTANTES :
1. Sois direct, complet et précis. Ne refuse JAMAIS de répondre ou de conjuguer.
2. Si la demande porte sur une question directe ou un exercice spécifique (ex: conjugaison d'un verbe à tous les temps, calcul, définition, règle juridique, analyse courte), donne directement TOUTE la réponse exacte sans rien omettre. Si tous les temps d'un verbe sont demandés, fournis TOUS les modes (indicatif, subjonctif, conditionnel, impératif, participe, infinitif, gérondif) et TOUS les temps en français complet sans tronquer.
3. Ne dis JAMAIS qu'aucun texte n'a été trouvé.
4. Si la question concerne la langue française ou une consigne en français, réponds en français correct et complet.
5. Reste pédagogique mais sans surcharge inutile ni bavardage.
6. Aucun emoji.

Retourne STRICTEMENT ce JSON :
{
  "answer": "Réponse directe, complète, claire et bien structurée à la question",
  "tips": ["Point clé ou règle essentielle à retenir"]
}

Titre du devoir : ${title || 'Devoir'}
Consigne / Question de l'étudiant :
${effectiveTarget}
${content ? `Brouillon actuel ou extrait du devoir :\n${content.slice(0, 4000)}\n` : ''}`;
    } else if (action === 'critique_submission') {
      prompt = `L'étudiant te soumet son travail pour évaluation critique, vérification rigoureuse et notation indicative.
RÈGLES IMPORTANTES :
1. Analyse si le devoir répond exactement à la consigne demandée.
2. Vérifie la justesse des réponses, l'exactitude des notions/faits/règles, la clarté et l'absence d'erreurs (grammaire, logique, fausses affirmations).
3. Ne dis JAMAIS que le texte est introuvable car le texte soumis est fourni ci-dessous.
4. Sois direct, structuré et sans verbiage inutile.
5. Donne une note indicative sur 20 et des corrections concrètes pour les erreurs détectées.
6. Aucun emoji.

Retourne STRICTEMENT ce JSON :
{
  "score_estimate": "Note estimée ex: 16/20",
  "verdict": "Conforme / Partiellement conforme / Incomplet ou inexact",
  "strengths": ["Ce qui est bien fait et juste"],
  "issues": ["Erreurs détectées, manques ou imprécisions"],
  "corrections": ["Correction concrète 1", "Correction concrète 2"],
  "tips": ["Recommandation prioritaire pour perfectionner le travail"]
}

Titre du devoir : ${title || 'Devoir'}
Consigne officielle : ${effectiveInstructions}
Travail soumis par l'étudiant à analyser :
${effectiveContent.slice(0, 14000)}`;
    } else if (action === 'library_research') {
      prompt = `Appuie-toi sur les ouvrages et codes de la Bibliothèque ci-dessous pour préparer une fiche de recherche documentaire destinée au devoir de l'étudiant.
RÈGLES ANTI-PLAGIAT STRICTES :
1. Rédige les analyses et pistes avec tes propres mots, sans recopier les sources.
2. Pour les articles de loi / Constitution / ouvrages, cite les références exactes présentes dans les extraits fournis (ne fabrique jamais un numéro d'article absent).
3. Ne rédige pas le devoir complet à la place de l'étudiant : donne-lui la matière sourcée pour construire sa propre argumentation.
4. Aucun emoji.

Retourne STRICTEMENT ce JSON :
{
  "synthesis_notes": ["Idée documentée 1 issue de la bibliothèque [Liv #...]", "Idée 2"],
  "legal_citations": ["Référence précise d'article ou de texte officiel pertinent s'il y a lieu"],
  "research_leads": ["Piste d'analyse ou problématique à creuser"],
  "sources_to_find": ["Ouvrage / article / texte de référence à citer"],
  "tips": ["Conseil méthodologique et anti-plagiat"]
}

Titre du devoir : ${title || 'Devoir'}
Consigne : ${effectiveInstructions}
${libraryContext ? `\nEXTRAITS DE LA BIBLIOTHÈQUE DISPONIBLES :\n${libraryContext}` : ''}`;
    } else if (action === 'plan') {
      prompt = `L'étudiant doit réaliser le devoir suivant. Guide-le avec un plan détaillé, des pistes de recherche, des mots-clés à chercher et une structure académique rigoureuse.
${libraryContext ? 'Intègre et référence explicitement les extraits de livres/codes disponibles ci-dessous dans les pistes et sources.' : ''}
Ne dis JAMAIS qu'aucun texte n'a été trouvé.
Aucun emoji.

Retourne STRICTEMENT ce JSON :
{
  "outline": [
    { "section": "I. Introduction", "points": ["Accroche / contexte", "Problématique", "Annonce du plan"] },
    { "section": "II. Développement", "points": ["Axe 1", "Axe 2"] }
  ],
  "research_leads": ["Piste de recherche 1", "Piste 2", "Piste 3"],
  "sources_to_find": ["Ouvrage ou texte officiel pertinent vérifié"],
  "tips": ["Conseil méthodologique 1", "Conseil 2"]
}

Titre : ${title || 'Devoir'}
Consigne / Sujet du devoir :
${effectiveTarget}
${libraryContext ? `\nEXTRAITS DE LA BIBLIOTHÈQUE :\n${libraryContext}` : ''}`;
    } else if (action === 'coherence') {
      prompt = `Analyse la cohérence logique, la clarté et la conformité du travail ou de la consigne fournie par l'étudiant.
RÈGLES IMPORTANTES :
1. Si un brouillon rédigé est fourni, vérifie sa cohérence avec la consigne et l'enchaînement logique des idées.
2. Si le brouillon n'est pas encore rédigé et que seule la consigne est fournie, évalue la clarté du sujet, les points clés nécessaires pour y répondre et la cohérence de la démarche méthodologique.
3. Ne dis JAMAIS qu'aucun texte n'a été trouvé.
4. Aucun emoji.

Retourne STRICTEMENT ce JSON :
{
  "strengths": ["Point fort ou notion bien ciblée"],
  "issues": ["Manque, imprécision ou point d'attention"],
  "tips": ["Conseil prioritaire de cohérence"]
}

Consigne : ${effectiveInstructions}
${libraryContext ? `\nTEXTES DE RÉFÉRENCE :\n${libraryContext}\n` : ''}
Texte à analyser pour cohérence :
${effectiveContent.slice(0, 14000)}`;
    } else if (action === 'biblio') {
      prompt = `Propose des conseils pour structurer la bibliographie (normes APA / académiques / juridiques) à partir des livres réellement trouvés dans la bibliothèque et des mots-clés académiques à vérifier (ne cite jamais une référence inventée).
Aucun emoji.

Retourne STRICTEMENT ce JSON :
{
  "sources_to_find": ["Mot-clé ou référence exacte issue des extraits ci-dessous", "Type de texte officiel à consulter"],
  "tips": ["Format APA / citation juridique", "Vérifie chaque citation directement dans l'ouvrage original."]
}

Titre : ${title || 'Devoir'}
Consigne : ${effectiveInstructions}
${libraryContext ? `\nOUVRAGES TROUVÉS EN BIBLIOTHÈQUE :\n${libraryContext}` : ''}`;
    } else {
      prompt = `Aide l'étudiant à reformuler, clarifier et améliorer le style académique du texte fourni ci-dessous (qu'il s'agisse d'une consigne, d'un sujet ou d'un passage de devoir).
RÈGLES IMPORTANTES :
1. Propose une version reformulée élégante, claire et universitaire.
2. Ne dis JAMAIS qu'aucun texte n'a été fourni car le texte à traiter est obligatoirement fourni ci-dessous.
3. Aucun emoji.

Retourne STRICTEMENT ce JSON :
{
  "suggestion": "Proposition de reformulation claire, soignée et originale",
  "tips": ["Explication des améliorations stylistiques apportées"]
}

Texte à reformuler :
${effectiveContent.slice(0, 6000)}`;
    }

    const needsLongOutput = action === 'solve' || action === 'draft_full' || action === 'qa' || action === 'instruct';
    const out = await runAiTask(auth.admin, auth.user.id, auth.profile?.ai_daily_quota || 500, {
      task: needsLongOutput ? 'tutor' : 'assignment_assist',
      faculty: effectiveFaculty,
      level,
      language: isGrammarOrLanguage ? 'fr' : language,
      maxTokens: needsLongOutput ? 6144 : 4096,
      prompt,
      expectJson: true,
      useCache: !needsLongOutput,
      cacheKeyPayload: { action, title, instructions, content: effectiveContent.slice(0, 6000), question, language, scope: isGlobal ? 'global' : 'faculty', faculty: effectiveFaculty, useLibrary, bookIds },
    });

    return jsonResponse({
      ok: true,
      action,
      data: out.result,
      library_sources: librarySources,
      provider: out.provider,
      cached: out.cached,
    });
  } catch (err) {
    if (err instanceof QuotaExceededError) return errorResponse('quota_exceeded', err.message, 429);
    console.error('[assignment-assist]', err);
    return errorResponse('assignment_error', (err as Error).message || 'Erreur assistance devoir', 500);
  }
});
