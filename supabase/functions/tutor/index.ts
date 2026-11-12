// Edge Function : tutor
// Tuteur IA contextuel avec mémoire de conversation, contexte cours/note et garde-fous faculté
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
    const message = String(body.message || '').trim();
    if (!message) return errorResponse('invalid_input', 'Message vide.', 400);

    const faculty = body.faculty || auth.profile?.faculty_id || 'autre';
    const level = body.level || auth.profile?.level || 'L1';
    const language = body.language || auth.profile?.language || 'ht';
    const mode = String(body.mode || 'standard');
    const contextType = String(body.contextType || 'general');
    const contextId = body.contextId || null;
    const courseId = body.courseId || null;

    // Charger le contexte réel depuis la base de données si contextId ou courseId est fourni
    const contextSnippets: string[] = [];
    if (body.contextText) {
      contextSnippets.push(String(body.contextText).slice(0, 6000));
    }

    if (contextType === 'note' && contextId) {
      const { data: n } = await auth.admin
        .from('pran_not_notes')
        .select('title, summary, content_text, course_id')
        .eq('id', contextId)
        .eq('user_id', auth.user.id)
        .maybeSingle();
      if (n) {
        contextSnippets.push(`Note "${n.title}" :\n${n.summary || ''}\n${(n.content_text || '').slice(0, 5000)}`);
      }
    } else if (contextType === 'book' && contextId) {
      const { data: bk } = await auth.userClient
        .from('pran_not_library_books')
        .select('id, title, author, summary')
        .eq('id', contextId)
        .maybeSingle();
      const { data: bkChunks } = await auth.userClient
        .from('pran_not_library_chunks')
        .select('section_label, page_number, content')
        .eq('book_id', contextId)
        .order('chunk_index', { ascending: true })
        .limit(4);
      if (bk) {
        const chunkText = (bkChunks || [])
          .map((c: { section_label?: string; page_number?: number; content?: string }) =>
            `[${c.section_label || 'Extrait'}${c.page_number ? ` (p. ${c.page_number})` : ''}]\n${String(c.content || '').slice(0, 1100)}`)
          .join('\n\n');
        contextSnippets.push(`Ouvrage / Code sélectionné "${bk.title}" (${bk.author || 'Référence'}) :\n${bk.summary || ''}\n${chunkText}`);
      }
    } else if (courseId) {
      const { data: notes } = await auth.admin
        .from('pran_not_notes')
        .select('title, summary')
        .eq('course_id', courseId)
        .eq('user_id', auth.user.id)
        .order('updated_at', { ascending: false })
        .limit(5);
      if (notes?.length) {
        contextSnippets.push(
          'Extraits des notes du cours :\n' + notes.map((n) => `- ${n.title} : ${n.summary || ''}`).join('\n'),
        );
      }
      const { data: units } = await auth.admin
        .from('pran_not_syllabus_units')
        .select('title, objectives')
        .eq('course_id', courseId)
        .eq('user_id', auth.user.id)
        .limit(8);
      if (units?.length) {
        contextSnippets.push(
          'Chapitres du syllabus :\n' + units.map((u) => `- ${u.title}`).join('\n'),
        );
      }
    }

    // Recherche complémentaire dans la Bibliothèque & Codes officiels (RAG)
    let libraryCitations: Array<{ book_id: string; book_title: string; section_label: string; page_number: number | null }> = [];
    if (body.useLibrary !== false && message.length >= 4) {
      try {
        const { data: libHits } = await auth.userClient.rpc('pran_not_search_library', {
          p_query: message.slice(0, 220),
          p_faculty: faculty,
          p_scope: null,
          p_book_id: contextType === 'book' && contextId ? contextId : null,
          p_limit: 5,
        });
        if (Array.isArray(libHits) && libHits.length) {
          libraryCitations = libHits.map((h: Record<string, unknown>) => ({
            book_id: String(h.book_id || ''),
            book_title: String(h.book_title || 'Ouvrage'),
            section_label: String(h.section_label || ''),
            page_number: typeof h.page_number === 'number' ? h.page_number : null,
          }));
          contextSnippets.push(
            'Extraits pertinents de la Bibliothèque / Codes officiels (cite la référence exacte, sans plagiat) :\n'
            + libHits.map((h: Record<string, unknown>) =>
              `[Liv : ${h.book_title}${h.section_label ? ` — ${h.section_label}` : ''}${h.page_number ? ` (p. ${h.page_number})` : ''}]\n${String(h.content || '').slice(0, 950)}`,
            ).join('\n\n'),
          );
        }
      } catch { /* optionnel si tables absentes */ }
    }

    const modeDirectives: Record<string, string> = {
      simple: 'Mode : explique très simplement, avec des phrases courtes et des mots accessibles.',
      child: 'Mode : explique comme à un enfant de 10 ans, à l’aide d’images simples du quotidien.',
      haiti: 'Mode : illustre impérativement avec un exemple concret tiré de la vie ou du contexte en Haïti.',
      compare: 'Mode : compare clairement deux notions proches (ressemblances, différences, erreurs à éviter).',
      mnemonic: 'Mode : propose un moyen mnémotechnique facile à retenir.',
      quiz: 'Mode : pose une question ciblée à l’étudiant pour tester sa compréhension, sans donner tout de suite la réponse complète.',
      standard: 'Mode : réponse structurée, claire et pédagogique.',
    };

    const systemExtra = [
      modeDirectives[mode] || modeDirectives.standard,
      contextSnippets.length ? `CONTEXTE DE L'ÉTUDIANT (à utiliser en priorité) :\n${contextSnippets.join('\n\n')}` : '',
    ].filter(Boolean).join('\n\n');

    // Gérer la conversation persistante
    let conversationId = body.conversationId || null;
    if (!conversationId) {
      const { data: conv } = await auth.admin
        .from('pran_not_tutor_conversations')
        .insert({
          user_id: auth.user.id,
          course_id: courseId,
          context_type: ['general','note','course','card','deck','test','assignment','unit','book'].includes(contextType) ? contextType : 'general',
          context_id: contextId,
          title: message.slice(0, 70),
        })
        .select('id')
        .single();
      conversationId = conv?.id || null;
    }

    if (conversationId) {
      await auth.admin.from('pran_not_tutor_messages').insert({
        conversation_id: conversationId,
        user_id: auth.user.id,
        role: 'user',
        content: message,
        mode,
      });
    }

    const history = Array.isArray(body.history)
      ? body.history
          .filter((m: { role?: string; content?: string }) => (m.role === 'user' || m.role === 'assistant') && m.content)
          .slice(-8)
          .map((m: { role: 'user' | 'assistant'; content: string }) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
      : [];

    const out = await runAiTask(auth.admin, auth.user.id, auth.profile?.ai_daily_quota || 60, {
      task: 'tutor',
      faculty,
      level,
      language,
      systemExtra,
      prompt: message,
      messages: history,
      expectJson: false,
      useCache: false,
      temperature: 0.45,
    });

    const reply = String((out.result as { text?: string })?.text || '');

    if (conversationId && reply) {
      await auth.admin.from('pran_not_tutor_messages').insert({
        conversation_id: conversationId,
        user_id: auth.user.id,
        role: 'assistant',
        content: reply,
        mode,
      });
      await auth.admin.from('pran_not_tutor_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
    }

    return jsonResponse({ ok: true, conversationId, reply, libraryCitations, provider: out.provider });
  } catch (err) {
    if (err instanceof QuotaExceededError) return errorResponse('quota_exceeded', err.message, 429);
    console.error('[tutor]', err);
    return errorResponse('tutor_error', (err as Error).message || 'Erreur tuteur', 500);
  }
});
