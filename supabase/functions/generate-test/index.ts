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
    const count = Math.min(15, Math.max(3, Number(body.count || 5)));
    const weakKeywords: string[] = Array.isArray(body.weakKeywords) ? body.weakKeywords.map(String) : [];

    if (!content && !weakKeywords.length && !title) {
      return errorResponse('invalid_input', 'Contenu ou titre manquant.', 400);
    }

    const effectiveContent = content || `Tèm etid : "${title}". Jenere kesyon evalyasyon akademik sou sijè sa a.`;

    const faculty = body.faculty || auth.profile?.faculty_id || 'autre';
    const level = body.level || auth.profile?.level || 'L1';
    const language = body.language || auth.profile?.language || 'ht';

    const langInstruction = language === 'ht'
      ? 'ENPÒTAN: Ekri TOUT kesyon yo, tout opsyon yo ak tout eksplikasyon yo NÈT ALKÒLE an KREYÒL AYISYEN klè, akademik e natirèl.'
      : 'IMPORTANT : Rédige TOUTES les questions, options et explications STRICTEMENT en Français académique.';

    const diffHint = difficulty === 'easy'
      ? (language === 'ht' ? 'Kesyon dirèk pou konpreyansyon ak memorizasyon.' : 'Questions directes de compréhension et mémorisation.')
      : difficulty === 'exam'
        ? (language === 'ht' ? 'Nivo egzamen inivèsitè rigourèz ak pyèj ak ka pratik.' : 'Niveau examen universitaire rigoureux avec pièges plausibles et cas pratiques.')
        : (language === 'ht' ? 'Nivo entèmedyè ak aplikasyon.' : 'Niveau intermédiaire avec mise en application.');

    const weakHint = weakKeywords.length
      ? (language === 'ht' ? `Ensiste sou pwen fèb sa yo : ${weakKeywords.join(', ')}.` : `Insiste particulièrement sur ces points faibles : ${weakKeywords.join(', ')}.`)
      : '';

    const prompt = `${langInstruction}
Génère un test académique de ${count} questions (difficulté : ${difficulty} — ${diffHint}) sur le thème "${title}".
${weakHint}

Types de questions à utiliser :
- "mcq" : Choix multiple avec exactement 4 options. "answer" est l'index 0, 1, 2 ou 3 du bon choix.
- "true_false" : Vrai ou Faux avec options ["Vre", "Fo"] (si créole) ou ["Vrai", "Faux"] (si français). "answer" est 0 (pour Vre/Vrai) ou 1 (pour Fo/Faux).
- "short" : Réponse courte. "options": [], "answer": "réponse modèle synthétique".
- "case" : Cas pratique. "options": [], "answer": "analyse et démarche attendue".

Retourne STRICTEMENT et UNIQUEMENT cet objet JSON valide, sans balises markdown, sans texte additionnel :
{
  "title": "${title.replace(/"/g, "'")}",
  "questions": [
    {
      "type": "mcq",
      "prompt": "Énoncé clair de la question",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answer": 0,
      "explanation": "Explication pédagogique complète",
      "keyword": "mot-clé principal",
      "points": 1
    }
  ]
}

Contenu source :
${effectiveContent.slice(0, 16000)}`;

    const out = await runAiTask(auth.admin, auth.user.id, auth.profile?.ai_daily_quota || 500, {
      task: 'generate_test',
      faculty,
      level,
      language,
      prompt,
      expectJson: true,
      cacheKeyPayload: { title, content: effectiveContent.slice(0, 16000), difficulty, kind, count, weakKeywords, language },
    });

    const resObj = (out.result && typeof out.result === 'object')
      ? (out.result as { title?: string; questions?: Array<Record<string, unknown>> })
      : {};

    const rawQuestions = Array.isArray(resObj?.questions) ? resObj.questions : [];
    const questions = rawQuestions
      .map((rawQ, idx) => {
        const q = (rawQ && typeof rawQ === 'object') ? (rawQ as Record<string, unknown>) : {};
        const promptText = String(q.prompt || q.question || q.enonce || q.title || '').trim();
        if (!promptText) return null;

        const rawType = String(q.type || 'mcq').toLowerCase().trim();
        const type = VALID_Q.has(rawType) ? rawType : 'mcq';

        let options: string[] = [];
        if (Array.isArray(q.options)) {
          options = q.options.map(String).map((s) => s.trim()).filter(Boolean);
        } else if (Array.isArray((q as Record<string, unknown>).choices)) {
          options = ((q as Record<string, unknown>).choices as unknown[]).map(String).map((s) => s.trim()).filter(Boolean);
        }

        if (type === 'mcq' && options.length < 2) {
          options = language === 'ht' ? ['Wi / Vre', 'Non / Fo'] : ['Vrai', 'Faux'];
        }

        let answer = q.answer ?? q.correct_answer ?? q.reponse ?? q.correctAnswer;
        if (type === 'mcq') {
          if (typeof answer === 'string') {
            const trimmed = answer.trim();
            if (/^[0-3]$/.test(trimmed)) {
              answer = parseInt(trimmed, 10);
            } else if (/^[A-D]$/i.test(trimmed)) {
              answer = trimmed.toUpperCase().charCodeAt(0) - 65;
            } else {
              const foundIdx = options.findIndex((opt) => opt.toLowerCase() === trimmed.toLowerCase());
              answer = foundIdx >= 0 ? foundIdx : 0;
            }
          } else if (typeof answer === 'number') {
            if (answer < 0 || answer >= (options.length || 4)) answer = 0;
          } else {
            answer = 0;
          }
        } else if (type === 'true_false') {
          if (typeof answer === 'boolean') {
            answer = answer ? 0 : 1;
            if (!options.length) options = language === 'ht' ? ['Vre', 'Fo'] : ['Vrai', 'Faux'];
          } else if (typeof answer === 'string') {
            const lower = answer.toLowerCase().trim();
            const isTrue = lower.includes('vre') || lower.includes('vrai') || lower === 'true' || lower === 't' || lower === '0';
            answer = isTrue ? 0 : 1;
            if (!options.length) options = language === 'ht' ? ['Vre', 'Fo'] : ['Vrai', 'Faux'];
          }
        } else {
          answer = String(answer ?? '');
        }

        const explanation = String(q.explanation || q.eksplikasyon || q.justification || '').trim();
        const keyword = String(q.keyword || q.tag || '').trim().slice(0, 80);
        const points = type === 'case' ? 3 : type === 'short' ? 2 : 1;

        return {
          position: idx + 1,
          type,
          prompt: promptText,
          options,
          answer,
          explanation,
          keyword,
          points,
        };
      })
      .filter((q): q is NonNullable<typeof q> => q !== null);

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
