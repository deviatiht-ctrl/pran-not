// Edge Function : generate-flashcards
// Génération automatique de flashcards (SM-2) avec types variés et JSON validé
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { authenticateUser } from '../_shared/supabase.ts';
import { QuotaExceededError, runAiTask } from '../_shared/ai.ts';

const VALID_TYPES = new Set(['qa', 'definition', 'cloze', 'true_false', 'formula', 'case']);

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  try {
    const auth = await authenticateUser(req);
    if ('error' in auth) return errorResponse(auth.error, 'Non authentifié', auth.status);

    const body = await req.json();
    const content = String(body.content || '').trim();
    const title = String(body.title || 'Kat memwa').trim();
    const count = Math.min(20, Math.max(3, Number(body.count || 8)));
    if (!content && !title) return errorResponse('invalid_input', 'Contenu source ou titre manquant.', 400);

    const effectiveContent = content || `Tèm etid : "${title}". Jenere kat memwa pou memorizasyon konsèp kle sou sijè sa a.`;

    const faculty = body.faculty || auth.profile?.faculty_id || 'autre';
    const level = body.level || auth.profile?.level || 'L1';
    const language = body.language || auth.profile?.language || 'ht';

    const langInstruction = language === 'ht'
      ? 'ENPÒTAN: Ekri TOUT kat yo (kesyon devan, repons dèyè) NÈT ALKÒLE an KREYÒL AYISYEN klè e kòrèk.'
      : 'IMPORTANT : Rédige TOUTES les cartes (recto et verso) STRICTEMENT en Français académique.';

    const prompt = `${langInstruction}
À partir du contenu ci-dessous (titre : "${title.replace(/"/g, "'")}"), génère exactement ${count} flashcards utiles pour la mémorisation espacée.
Varie les types parmi : "qa", "definition", "cloze" (entoure le mot à deviner avec {{mot}} dans front), "true_false", "formula", "case" (cas pratique adapté à la faculté ${faculty}).

Retourne STRICTEMENT et UNIQUEMENT ce JSON valide, sans balises markdown, sans texte additionnel :
{
  "cards": [
    {
      "type": "qa|definition|cloze|true_false|formula|case",
      "front": "Question ou énoncé (pour cloze : phrase avec {{mot}})",
      "back": "Réponse claire et concise",
      "tags": ["tag1", "tag2"]
    }
  ]
}

Contenu :
${effectiveContent.slice(0, 16000)}`;

    const out = await runAiTask(auth.admin, auth.user.id, auth.profile?.ai_daily_quota || 500, {
      task: 'generate_flashcards',
      faculty,
      level,
      language,
      prompt,
      expectJson: true,
      cacheKeyPayload: { title, content: effectiveContent.slice(0, 16000), count, language, faculty },
    });

    const rawCards = Array.isArray((out.result as { cards?: unknown[] })?.cards)
      ? (out.result as { cards: Array<Record<string, unknown>> }).cards
      : [];

    const cards = rawCards
      .map((c) => {
        const item = (c && typeof c === 'object') ? (c as Record<string, unknown>) : {};
        const front = String(item.front || item.question || item.recto || '').trim();
        const back = String(item.back || item.answer || item.reponse || item.verso || '').trim();
        if (!front || !back) return null;

        const type = VALID_TYPES.has(String(item.type)) ? String(item.type) : 'qa';
        const tags = Array.isArray(item.tags)
          ? item.tags.map(String).slice(0, 5)
          : Array.isArray(item.keywords)
            ? (item.keywords as unknown[]).map(String).slice(0, 5)
            : [];

        return { type, front, back, tags };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    let deckId = body.deckId || null;
    if (body.save !== false && cards.length) {
      if (!deckId) {
        const { data: deck, error: dErr } = await auth.admin
          .from('pran_not_flashcard_decks')
          .insert({
            user_id: auth.user.id,
            course_id: body.courseId || null,
            unit_id: body.unitId || null,
            note_id: body.noteId || null,
            title,
          })
          .select()
          .single();
        if (dErr) throw dErr;
        deckId = deck.id;
      }

      const rows = cards.map((c) => ({
        user_id: auth.user.id,
        deck_id: deckId,
        course_id: body.courseId || null,
        unit_id: body.unitId || null,
        note_id: body.noteId || null,
        type: c.type,
        front: c.front,
        back: c.back,
        tags: c.tags,
      }));
      await auth.admin.from('pran_not_flashcards').insert(rows);
    }

    return jsonResponse({ ok: true, deckId, cards, provider: out.provider, cached: out.cached });
  } catch (err) {
    if (err instanceof QuotaExceededError) return errorResponse('quota_exceeded', err.message, 429);
    console.error('[generate-flashcards]', err);
    return errorResponse('flashcards_error', (err as Error).message || 'Erreur génération flashcards', 500);
  }
});
