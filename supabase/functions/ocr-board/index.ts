// Edge Function : ocr-board
// Lecture IA de photos du tableau ou de cahiers manuscrits (créole/français)
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
    const images: string[] = Array.isArray(body.imagesBase64) ? body.imagesBase64.slice(0, 6) : [];
    if (!images.length) {
      return errorResponse('invalid_input', 'Aucune image reçue.', 400);
    }

    const faculty = body.faculty || auth.profile?.faculty_id || 'autre';
    const level = body.level || auth.profile?.level || 'L1';
    const language = body.language || auth.profile?.language || 'ht';

    const prompt = `Analyse attentivement ces photos de tableau ou de cahier universitaire.
Reconstitue fidèlement toute la structure logique (colonnes de gauche à droite, titres, définitions, théorèmes, formules mathématiques/chimiques/physiques, et exercices/devoirs éventuels).
Décris précisément les schémas et graphiques entre crochets [Schéma : ...].
Garde le bilinguisme naturel (français et créole haïtien).
Pour tout mot ou symbole difficile à lire ou incertain, ajoute une entrée dans "uncertain".

Retourne STRICTEMENT un objet JSON de la forme :
{
  "text": "texte complet reconstitué avec sauts de ligne et hiérarchie logique",
  "formulas": ["formule 1", "formule 2"],
  "diagrams": ["description schéma 1"],
  "uncertain": [
    { "text": "mot ou fragment lu", "suggestion": "meilleure interprétation probable", "reason": "écriture floue ou coupée" }
  ]
}`;

    const out = await runAiTask(auth.admin, auth.user.id, auth.profile?.ai_daily_quota || 500, {
      task: 'ocr_board',
      faculty,
      level,
      language,
      prompt,
      imagesBase64: images,
      expectJson: true,
      cacheKeyPayload: { count: images.length, sample: images.map((s) => s.slice(0, 120) + s.length) },
    });

    const data = out.result as Record<string, unknown>;
    if (body.noteId) {
      await auth.admin
        .from('pran_not_note_sources')
        .update({
          ocr_text: String(data?.text || ''),
          uncertain: Array.isArray(data?.uncertain) ? data.uncertain : [],
          status: 'done',
        })
        .eq('note_id', body.noteId)
        .eq('user_id', auth.user.id)
        .eq('kind', 'image');
    }

    return jsonResponse({ ok: true, ...(data || {}), provider: out.provider, cached: out.cached });
  } catch (err) {
    if (err instanceof QuotaExceededError) return errorResponse('quota_exceeded', err.message, 429);
    console.error('[ocr-board]', err);
    return errorResponse('ocr_error', (err as Error).message || 'Erreur OCR', 500);
  }
});
