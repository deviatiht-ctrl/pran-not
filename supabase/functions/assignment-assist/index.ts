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
    const action = String(body.action || 'plan'); // 'plan' | 'coherence' | 'biblio' | 'rephrase' | 'library_research'
    const title = String(body.title || '').trim();
    const instructions = String(body.instructions || '').trim();
    const content = String(body.content || '').trim();
    const useLibrary = body.useLibrary !== false;
    const bookIds = Array.isArray(body.bookIds) ? body.bookIds.filter(Boolean).slice(0, 5) : [];

    if (!title && !instructions && !content) {
      return errorResponse('invalid_input', 'Sujet ou contenu du devoir manquant.', 400);
    }

    const faculty = body.faculty || auth.profile?.faculty_id || 'autre';
    const level = body.level || auth.profile?.level || 'L1';
    const language = body.language || auth.profile?.language || 'ht';

    // Recherche contextuelle dans les livres, manuels et codes juridiques de la Bibliothèque
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

    if (useLibrary || action === 'library_research') {
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
    if (action === 'library_research') {
      prompt = `Appuie-toi sur les ouvrages et codes juridiques de la Bibliothèque ci-dessous pour préparer une fiche de recherche documentaire destinée au devoir de l'étudiant.
RÈGLES ANTI-PLAGIAT STRICTES :
1. Rédige les analyses et pistes avec tes propres mots, sans recopier les sources.
2. Pour les articles de loi / Constitution, cite les références exactes présentes dans les extraits fournis (ne fabrique jamais un numéro d'article absent).
3. Ne rédige pas le devoir complet à la place de l'étudiant : donne-lui la matière sourcée pour construire sa propre argumentation.

Retourne STRICTEMENT ce JSON :
{
  "synthesis_notes": ["Idée documentée 1 issue de la bibliothèque [Liv #...]", "Idée 2"],
  "legal_citations": ["Référence précise d'article ou de texte officiel pertinent s'il y a lieu"],
  "research_leads": ["Piste d'analyse ou problématique à creuser"],
  "sources_to_find": ["Ouvrage / article / texte de référence à citer"],
  "tips": ["Conseil méthodologique et anti-plagiat"]
}

Titre du devoir : ${title}
Consigne : ${instructions}
${libraryContext ? `\nEXTRAITS DE LA BIBLIOTHÈQUE DISPONIBLES :\n${libraryContext}` : ''}`;
    } else if (action === 'plan') {
      prompt = `L'étudiant doit réaliser le devoir suivant. Ne rédige JAMAIS le devoir à sa place : guide-le avec un plan détaillé, des pistes de recherche, des mots-clés à chercher en bibliothèque/web et une structure académique.
${libraryContext ? 'Intègre et référence explicitement les extraits de livres/codes disponibles ci-dessous dans les pistes et sources.' : ''}
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

Titre : ${title}
Consigne : ${instructions}
${libraryContext ? `\nEXTRAITS DE LA BIBLIOTHÈQUE :\n${libraryContext}` : ''}`;
    } else if (action === 'coherence') {
      prompt = `Vérifie la cohérence, l'enchaînement logique et le respect de la consigne (et des textes de référence disponibles si pertinents) dans le brouillon de l'étudiant sans le réécrire entièrement.
Retourne STRICTEMENT ce JSON :
{
  "strengths": ["Point fort 1", "Point fort 2"],
  "issues": ["Manque ou incohérence 1", "Suggestion d'amélioration 2"],
  "tips": ["Conseil prioritaire"]
}

Consigne : ${instructions}
${libraryContext ? `\nTEXTES DE RÉFÉRENCE :\n${libraryContext}\n` : ''}
Brouillon :
${content.slice(0, 14000)}`;
    } else if (action === 'biblio') {
      prompt = `Propose des conseils pour structurer la bibliographie (normes APA / juridiques) à partir des livres réellement trouvés dans la bibliothèque et des mots-clés académiques à vérifier (ne cite jamais une référence inventée).
Retourne STRICTEMENT ce JSON :
{
  "sources_to_find": ["Mot-clé ou référence exacte issue des extraits ci-dessous", "Type de texte officiel à consulter"],
  "tips": ["Format APA / citation juridique", "Vérifie chaque citation directement dans l'ouvrage original."]
}

Titre : ${title}
Consigne : ${instructions}
${libraryContext ? `\nOUVRAGES TROUVÉS EN BIBLIOTHÈQUE :\n${libraryContext}` : ''}`;
    } else {
      prompt = `Aide l'étudiant à améliorer la clarté et le style universitaire de son passage sans plagiat, tout en expliquant les améliorations.
Retourne STRICTEMENT ce JSON :
{
  "suggestion": "Proposition de reformulation claire et originale",
  "tips": ["Explication de ce qui a été amélioré"]
}

Texte à reformuler :
${content.slice(0, 6000)}`;
    }

    const out = await runAiTask(auth.admin, auth.user.id, auth.profile?.ai_daily_quota || 60, {
      task: 'assignment_assist',
      faculty,
      level,
      language,
      prompt,
      expectJson: true,
      cacheKeyPayload: { action, title, instructions, content: content.slice(0, 6000), language, useLibrary, bookIds },
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
