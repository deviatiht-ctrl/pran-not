// Edge Function : generate-test
// Création de tests progressifs ou de rattrapage avec mots-clés ciblés
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { authenticateUser } from '../_shared/supabase.ts';
import { QuotaExceededError, runAiTask } from '../_shared/ai.ts';

const VALID_Q = new Set(['mcq', 'true_false', 'short', 'case']);

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  try {
    const auth = await authenticateUser(req);
    if ('error' in auth) return errorResponse(auth.error, 'Non authentifié', auth.status);

    const body = await req.json();
    const content = String(body.content || '').trim();
    const title = String(body.title || 'Tès').trim();
    const difficulty = ['easy', 'medium', 'exam'].includes(body.difficulty) ? body.difficulty : 'medium';
    const kind = ['standard', 'remedial', 'flash'].includes(body.kind) ? body.kind : 'standard';
    const count = Math.min(15, Math.max(3, Number(body.count || 6)));
    const weakKeywords: string[] = Array.isArray(body.weakKeywords) ? body.weakKeywords.map(String) : [];

    if (!content && !weakKeywords.length) {
      return errorResponse('invalid_input', 'Contenu ou mots-clés faibles manquants.', 400);
    }

    const faculty = body.faculty || auth.profile?.faculty_id || 'autre';
    const level = body.level || auth.profile?.level || 'L1';
    const language = body.language || auth.profile?.language || 'ht';

    const diffHint = difficulty === 'easy'
      ? 'Questions directes de compréhension et mémorisation.'
      : difficulty === 'exam'
        ? 'Niveau examen universitaire rigoureux avec pièges plausibles et cas pratiques.'
        : 'Niveau intermédiaire avec mise en application.';

    const weakHint = weakKeywords.length
      ? `Insiste particulièrement sur ces points faibles : ${weakKeywords.join(', ')}.`
      : '';

    const prompt = `Génère un test de ${count} questions (difficulté : ${difficulty} — ${diffHint}) sur le thème "${title}".
${weakHint}
Mélange QCM ("mcq" avec 4 options et "answer" = index 0..3), Vrai/Faux ("true_false" avec "options":[] et "answer": true ou false), Réponse courte ("short" avec "options":[] et "answer": "réponse modèle") et Cas pratique ("case" avec "options":[] et "answer": "raisonnement et réponse attendue").

Retourne STRICTEMENT ce JSON :
{
  "title": "Titre du test",
  "questions": [
    {
      "type": "mcq|true_false|short|case",
      "prompt": "Énoncé clair de la question",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answer": 0,
      "explanation": "Explication pédagogique claire",
      "keyword": "mot-clé principal évalué",
      "points": 1
    }
  ]
}

Contenu source :
${content.slice(0, 16000)}`;

    const out = await runAiTask(auth.admin, auth.user.id, auth.profile?.ai_daily_quota || 500, {
      task: 'generate_test',
      faculty,
      level,
      language,
      prompt,
      expectJson: true,
      cacheKeyPayload: { title, content: content.slice(0, 16000), difficulty, kind, count, weakKeywords, language },
    });

    const resObj = out.result as { title?: string; questions?: Array<Record<string, unknown>> };
    const questions = (Array.isArray(resObj?.questions) ? resObj.questions : [])
      .filter((q) => q?.prompt && q?.answer !== undefined)
      .map((q, idx) => {
        const type = VALID_Q.has(String(q.type)) ? String(q.type) : 'mcq';
        return {
          position: idx + 1,
          type,
          prompt: String(q.prompt).trim(),
          options: type === 'mcq' && Array.isArray(q.options) ? q.options.map(String).slice(0, 5) : [],
          answer: q.answer,
          explanation: String(q.explanation || ''),
          keyword: String(q.keyword || '').trim().slice(0, 80),
          points: type === 'case' ? 3 : type === 'short' ? 2 : 1,
        };
      });

    return jsonResponse({
      ok: true,
      title: String(resObj?.title || title),
      questions,
      provider: out.provider,
      cached: out.cached,
    });
  } catch (err) {
    if (err instanceof QuotaExceededError) return errorResponse('quota_exceeded', err.message, 429);
    console.error('[generate-test]', err);
    return errorResponse('test_error', (err as Error).message || 'Erreur génération test', 500);
  }
});
