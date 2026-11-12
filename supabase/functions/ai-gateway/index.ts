// Edge Function : ai-gateway
// Route générique : reçoit { task, faculty, level, language, payload }
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
    const task = String(body.task || '').trim();
    if (!task) return errorResponse('invalid_input', 'Tâche manquante.', 400);

    const faculty = body.faculty || auth.profile?.faculty_id || 'autre';
    const level = body.level || auth.profile?.level || 'L1';
    const language = body.language || auth.profile?.language || 'ht';
    const payload = body.payload || {};

    let prompt = '';
    let expectJson = false;

    if (task === 'grade_answer') {
      expectJson = true;
      prompt = `Corrige la réponse de l'étudiant et retourne STRICTEMENT ce JSON :
{ "points": number (entre 0 et ${Number(payload.maxPoints || 2)}), "correct": boolean, "feedback": "explication claire et bienveillante" }

Question : ${payload.question || ''}
Réponse attendue : ${payload.expectedAnswer || ''}
Réponse de l'étudiant : ${payload.studentAnswer || '(vide)'}
Barème max : ${Number(payload.maxPoints || 2)}`;
    } else if (task === 'explain') {
      expectJson = false;
      const modeHint = payload.mode === 'child'
        ? 'Explique comme à un enfant de 10 ans.'
        : payload.mode === 'haiti'
          ? 'Illustre avec un exemple concret tiré de la vie quotidienne en Haïti.'
          : 'Explique simplement, étape par étape, sans jargon inutile.';
      prompt = `${modeHint}\n\nContenu à expliquer :\n${String(payload.text || '').slice(0, 12000)}`;
    } else {
      expectJson = Boolean(body.expectJson);
      prompt = typeof payload === 'string' ? payload : JSON.stringify(payload);
    }

    const out = await runAiTask(auth.admin, auth.user.id, auth.profile?.ai_daily_quota || 60, {
      task,
      faculty,
      level,
      language,
      prompt,
      expectJson,
      cacheKeyPayload: payload,
      imagesBase64: Array.isArray(body.imagesBase64) ? body.imagesBase64 : undefined,
    });

    return jsonResponse({ ...out, ok: true });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return errorResponse('quota_exceeded', err.message, 429);
    }
    console.error('[ai-gateway]', err);
    return errorResponse('ai_error', (err as Error).message || 'Erreur IA', 500);
  }
});
