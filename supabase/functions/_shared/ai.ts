// Routeur IA multi-fournisseurs gratuits avec repli automatique, cache, quotas et JSON validé
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export interface AiRequest {
  task: string;
  faculty?: string;
  level?: string;
  language?: 'ht' | 'fr' | 'mix';
  systemExtra?: string;
  prompt: string;
  imagesBase64?: string[]; // images JPEG/PNG sans préfixe data:
  expectJson?: boolean;
  cacheKeyPayload?: unknown;
  useCache?: boolean;
  exemptQuota?: boolean;
  temperature?: number;
  maxTokens?: number;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

/** Supprime tout emoji ou pictogramme Unicode des sorties IA. */
export function stripEmojis(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function sanitizeJsonEmojis(val: unknown): unknown {
  if (typeof val === 'string') return stripEmojis(val);
  if (Array.isArray(val)) return val.map(sanitizeJsonEmojis);
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = sanitizeJsonEmojis(v);
    }
    return out;
  }
  return val;
}

async function sha256(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function cleanAndRepairJson(raw: string): string {
  let str = String(raw || '').trim();

  // 1. Détecter et extraire le bloc markdown
  if (str.includes('```')) {
    const fencedMatch = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch && fencedMatch[1]) {
      str = fencedMatch[1].trim();
    } else {
      str = str.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    }
  }

  // 2. Délimiter le premier et dernier crochet/accolade
  const firstObj = str.indexOf('{');
  const firstArr = str.indexOf('[');
  let start = -1;
  let end = -1;

  if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
    start = firstObj;
    end = str.lastIndexOf('}');
  } else if (firstArr !== -1) {
    start = firstArr;
    end = str.lastIndexOf(']');
  }

  if (start !== -1 && end > start) {
    str = str.slice(start, end + 1);
  } else if (start !== -1) {
    str = str.slice(start);
  }

  // 3. Normaliser les guillemets typographiques
  str = str.replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"');
  str = str.replace(/[\u2018\u2019]/g, "'");

  // 4. Supprimer les commentaires JS // et /* */
  str = str.replace(/\/\/[^\n\r]*/g, '');
  str = str.replace(/\/\*[\s\S]*?\*\//g, '');

  // 5. Échapper les sauts de ligne et tabulations non échappés à l'intérieur des chaînes
  let inString = false;
  let escaped = false;
  let result = '';

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\r') {
        continue;
      }
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
      if (ch.charCodeAt(0) < 32) {
        continue;
      }
    }
    result += ch;
  }

  // 6. Supprimer les virgules traînantes avant } ou ]
  result = result.replace(/,\s*([}\]])/g, '$1');

  // 7. Équilibrer les accolades/crochets non fermés si le JSON a été tronqué
  const stack: string[] = [];
  inString = false;
  escaped = false;

  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
      else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
    }
  }

  if (inString) result += '"';
  result = result.replace(/,\s*$/, '');
  while (stack.length > 0) {
    const top = stack.pop();
    result += top === '{' ? '}' : ']';
  }

  return result;
}

function extractJson(raw: string): unknown {
  const cleaned = raw.trim();
  try {
    return JSON.parse(cleaned);
  } catch { /* premier échec direct */ }

  const repaired = cleanAndRepairJson(cleaned);
  try {
    return JSON.parse(repaired);
  } catch { /* deuxième échec réparé */ }

  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(cleanAndRepairJson(fenced[1].trim()));
    } catch { /* continue */ }
  }

  const firstObj = cleaned.indexOf('{');
  const lastObj = cleaned.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) {
    try {
      return JSON.parse(cleanAndRepairJson(cleaned.slice(firstObj, lastObj + 1)));
    } catch { /* continue */ }
  }

  const firstArr = cleaned.indexOf('[');
  const lastArr = cleaned.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) {
    try {
      return JSON.parse(cleanAndRepairJson(cleaned.slice(firstArr, lastArr + 1)));
    } catch { /* continue */ }
  }

  throw new Error('invalid_json_output');
}

function getApiKey(providerId: string): string | undefined {
  switch (providerId) {
    case 'gemini':
      return Deno.env.get('GEMINI_API_KEY');
    case 'groq':
      return Deno.env.get('GROQ_API_KEY');
    case 'mistral':
      return Deno.env.get('MISTRAL_API_KEY');
    case 'openrouter':
      return Deno.env.get('OPENROUTER_API_KEY');
    default:
      return undefined;
  }
}

function normalizeGeminiModel(m: string): string {
  if (!m || /3\.5|flash-lite|preview|latest/i.test(m)) {
    return 'gemini-2.5-flash';
  }
  return m;
}

function normalizeGroqModel(m: string): string {
  if (!m || /qwen|fake/i.test(m)) {
    return 'llama-3.3-70b-versatile';
  }
  return m;
}

async function callGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  req: AiRequest,
) {
  // Modèles valides et ultra-rapides pour Gemini (réponse < 1s)
  const normPrimary = normalizeGeminiModel(model);
  const modelCandidates = [
    normPrimary,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
  ].filter((m, i, arr) => m && arr.indexOf(m) === i);

  let lastErr: Error | null = null;

  for (let i = 0; i < modelCandidates.length; i++) {
    const candidateModel = modelCandidates[i];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidateModel)}:generateContent?key=${apiKey}`;

    try {
      const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
      if (req.messages?.length) {
        for (const m of req.messages) {
          contents.push({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          });
        }
      }

      const lastParts: Array<Record<string, unknown>> = [{ text: req.prompt }];
      if (req.imagesBase64?.length) {
        for (const b64 of req.imagesBase64) {
          lastParts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: b64,
            },
          });
        }
      }
      contents.push({ role: 'user', parts: lastParts });

      const generationConfig: Record<string, unknown> = {
        temperature: req.temperature ?? 0.35,
        maxOutputTokens: req.maxTokens ?? 4096,
      };
      if (req.expectJson) {
        generationConfig.responseMimeType = 'application/json';
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        const err = new Error(`gemini_${res.status}: ${errText.slice(0, 300)}`);
        (err as Error & { status?: number }).status = res.status;
        if ((res.status === 503 || res.status === 429 || res.status === 404 || res.status >= 500) && i < modelCandidates.length - 1) {
          console.warn(`[gemini] Model ${candidateModel} returned ${res.status}. Falling back to ${modelCandidates[i + 1]}...`);
          lastErr = err;
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        throw err;
      }

      const data = await res.json();
      const allParts = data?.candidates?.[0]?.content?.parts || [];
      const visibleParts = allParts.filter((p: { thought?: boolean; text?: string }) => !p.thought && Boolean(p.text));
      const text = (visibleParts.length ? visibleParts : allParts)
        .map((p: { text?: string }) => p.text || '')
        .join('\n')
        .trim();
      const usage = data?.usageMetadata || {};
      return {
        text,
        tokensIn: usage.promptTokenCount || 0,
        tokensOut: usage.candidatesTokenCount || 0,
      };
    } catch (err: any) {
      lastErr = err;
      if (i < modelCandidates.length - 1 && (err.status === 503 || err.status === 429 || err.status === 404 || /503|429|404|demand|unavailable/i.test(err.message))) {
        console.warn(`[gemini] Model ${candidateModel} failed. Falling back to ${modelCandidates[i + 1]}...`);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error('All Gemini model fallbacks failed');
}

async function callOpenAiCompat(
  endpoint: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  req: AiRequest,
  extraHeaders: Record<string, string> = {},
) {
  const messages: Array<{ role: string; content: unknown }> = [
    { role: 'system', content: systemPrompt },
  ];

  if (req.messages?.length) {
    for (const m of req.messages) {
      messages.push({ role: m.role, content: m.content });
    }
  }

  if (req.imagesBase64?.length) {
    const parts: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }];
    for (const b64 of req.imagesBase64) {
      parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
    }
    messages.push({ role: 'user', content: parts });
  } else {
    messages.push({ role: 'user', content: req.prompt });
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: req.temperature ?? 0.35,
    max_tokens: req.maxTokens ?? 4096,
  };
  if (req.expectJson && !endpoint.includes('openrouter')) {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`provider_${res.status}: ${errText.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || '';
  const usage = data?.usage || {};
  return {
    text,
    tokensIn: usage.prompt_tokens || 0,
    tokensOut: usage.completion_tokens || 0,
  };
}

/** Exécute une tâche IA avec quota, cache, prompts DB et bascule multi-fournisseurs. */
export async function runAiTask(
  admin: SupabaseClient,
  userId: string,
  userQuota: number,
  req: AiRequest,
) {
  const lang = req.language || 'ht';
  const faculty = req.faculty || 'autre';
  const level = req.level || 'L1';

  // 1. Vérifier le quota journalier de l'étudiant
  const todayIso = new Date().toISOString().slice(0, 10);
  const effectiveQuota = Math.max(userQuota || 500, 500);

  if (!req.exemptQuota) {
    const { count: usedToday } = await admin
      .from('pran_not_ai_usage')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('cached', false)
      .eq('success', true)
      .gte('created_at', `${todayIso}T00:00:00.000Z`);

    if ((usedToday ?? 0) >= effectiveQuota) {
      const msg = lang === 'fr'
        ? 'Limite quotidienne IA atteinte. Mettez la tâche en file ou réessayez demain.'
        : 'Ou rive nan limit IA jodi a. Ou ka mete travay la nan fil atant oswa eseye demen.';
      throw new QuotaExceededError(msg);
    }
  }

  // 2. Vérifier le cache (si activé)
  const useCache = req.useCache !== false && !req.messages?.length;
  let cacheHash = '';
  if (useCache) {
    cacheHash = await sha256(JSON.stringify({
      task: req.task,
      faculty,
      level,
      lang,
      payload: req.cacheKeyPayload ?? req.prompt,
      imgCount: req.imagesBase64?.length || 0,
    }));
    const { data: cachedRow } = await admin
      .from('pran_not_ai_cache')
      .select('result, hits')
      .eq('hash', cacheHash)
      .maybeSingle();

    if (cachedRow?.result) {
      await admin.from('pran_not_ai_cache').update({ hits: (cachedRow.hits || 0) + 1 }).eq('hash', cacheHash);
      await admin.from('pran_not_ai_usage').insert({
        user_id: userId,
        task: req.task,
        provider: 'cache',
        model: 'cache',
        cached: true,
        success: true,
      });
      return {
        result: cachedRow.result,
        provider: 'cache',
        cached: true,
      };
    }
  }

  // 3. Charger le prompt système depuis pran_not_ai_prompts + persona faculté
  const isGlobalFaculty = !faculty || faculty === 'general' || faculty === 'global' || faculty === 'autre';

  const { data: prompts } = await admin
    .from('pran_not_ai_prompts')
    .select('faculty_id, system_prompt')
    .eq('task', req.task)
    .eq('active', true)
    .or(isGlobalFaculty ? 'faculty_id.is.null' : `faculty_id.eq.${faculty},faculty_id.is.null`);

  const facultyPrompt = isGlobalFaculty ? null : prompts?.find((p) => p.faculty_id === faculty)?.system_prompt;
  const basePrompt = prompts?.find((p) => p.faculty_id === null)?.system_prompt || '';

  let facPersona = '';
  if (!isGlobalFaculty) {
    const { data: facRow } = await admin
      .from('pran_not_faculties')
      .select('name_fr, persona')
      .eq('id', faculty)
      .maybeSingle();
    if (facRow?.persona) {
      facPersona = `Contexte académique principal (${facRow.name_fr}) : ${facRow.persona}\nATTENTION : N'applique ce prisme de spécialité que si la question de l'étudiant ou le contenu porte explicitement ou indirectement sur ce domaine. Si l'étudiant pose une question de culture générale, de méthodologie générale, de lecture, de logique, de langue ou d'un autre domaine, réponds avec précision et clarté universelle SANS forcer de jargon ou d'analogies hors-sujet avec cette faculté.`;
    }
  } else {
    facPersona = `RÔLE ET PRISME ACADÉMIQUE GÉNÉRAL : Tu es un tuteur et assistant universitaire polyvalent et rigoureux couvrant TOUTES les disciplines (langue française, grammaire, conjugaison, littérature, mathématiques, logique, sciences, philosophie, méthodologie de travail, culture générale, histoire, économie, droit, etc.).
RÈGLE STRICTE DE NON-BIAIS : N'oriente JAMAIS tes réponses vers le droit ou la médecine de manière injustifiée. Réponds toujours avec les concepts, la rigueur et les règles exactes de la matière concernée par la question de l'étudiant.`;
  }

  const langRule = lang === 'ht'
    ? 'Langue de sortie : créole haïtien naturel, clair et respectueux (tolère les termes techniques français courants à l’université).'
    : lang === 'fr'
      ? 'Langue de sortie : français clair et académique.'
      : 'Langue de sortie : créole haïtien ou français selon la note.';

  const systemPrompt = [
    facultyPrompt || basePrompt,
    facPersona,
    `Niveau de l'étudiant : ${level}.`,
    langRule,
    'RÈGLE STRICTE : N’utilise JAMAIS aucun emoji ni symbole décoratif. Sois précis, pertinent, pédagogique et rigoureux. Ne réponds jamais à côté de la question. Si tu n’es pas certain d’un fait, d’un article de loi ou d’une donnée médicale, dis-le explicitement.',
    req.systemExtra || '',
  ].filter(Boolean).join('\n\n');

  // 4. Lister les fournisseurs éligibles triés par priorité
  const { data: providers } = await admin
    .from('pran_not_ai_providers')
    .select('*')
    .contains('tasks', [req.task])
    .neq('status', 'disabled')
    .order('priority', { ascending: true });

  const needsVision = Boolean(req.imagesBase64?.length);
  const candidates = (providers || []).filter((p) => {
    const key = getApiKey(p.id);
    if (!key) return false;
    if (needsVision && !p.model_vision) return false;
    if (p.quota_date === todayIso && p.status === 'exhausted') return false;
    if (p.quota_date === todayIso && p.used_today >= p.daily_quota) return false;
    return true;
  });

  if (!candidates.length) {
    throw new Error('no_ai_provider_configured');
  }

  // 5. Essayer chaque fournisseur jusqu'à succès
  let lastError: Error | null = null;

  for (const p of candidates) {
    const apiKey = getApiKey(p.id)!;
    const model = needsVision ? p.model_vision : p.model_text;
    const started = Date.now();

    // Réinitialiser le compteur quotidien si nouveau jour
    const prevUsed = p.quota_date === todayIso ? (p.used_today || 0) : 0;

    try {
      const invoke = async (overridePrompt?: string) => {
        const effectiveReq = overridePrompt ? { ...req, prompt: overridePrompt } : req;
        if (p.id === 'gemini') {
          return await callGemini(apiKey, model, systemPrompt, effectiveReq);
        }
        if (p.id === 'groq') {
          const groqM = normalizeGroqModel(model);
          return await callOpenAiCompat('https://api.groq.com/openai/v1/chat/completions', apiKey, groqM, systemPrompt, effectiveReq);
        }
        if (p.id === 'mistral') {
          return await callOpenAiCompat('https://api.mistral.ai/v1/chat/completions', apiKey, model, systemPrompt, effectiveReq);
        }
        if (p.id === 'openrouter') {
          return await callOpenAiCompat('https://openrouter.ai/api/v1/chat/completions', apiKey, model, systemPrompt, effectiveReq, {
            'HTTP-Referer': 'https://prannot.ht',
            'X-Title': 'Pran Not',
          });
        }
        throw new Error(`unknown_provider_${p.id}`);
      };

      const resp = await invoke();
      let finalResult: unknown;

      if (req.expectJson) {
        try {
          finalResult = sanitizeJsonEmojis(extractJson(resp.text));
        } catch {
          // Reprise automatique en cas de JSON invalide
          const repairPrompt = `Ton message précédent n'était pas un JSON valide. Corrige et renvoie UNIQUEMENT un objet JSON strictement valide sans texte autour :\n\n${resp.text.slice(0, 6000)}`;
          const repaired = await invoke(repairPrompt);
          finalResult = sanitizeJsonEmojis(extractJson(repaired.text));
        }
      } else {
        finalResult = { text: stripEmojis(resp.text) };
      }

      const latency = Date.now() - started;

      await admin.from('pran_not_ai_providers').update({
        used_today: prevUsed + 1,
        quota_date: todayIso,
        status: 'active',
      }).eq('id', p.id);

      await admin.from('pran_not_ai_usage').insert({
        user_id: userId,
        task: req.task,
        provider: p.id,
        model,
        tokens_in: resp.tokensIn,
        tokens_out: resp.tokensOut,
        cached: false,
        success: true,
        latency_ms: latency,
      });

      if (useCache && cacheHash) {
        await admin.from('pran_not_ai_cache').upsert({
          hash: cacheHash,
          task: req.task,
          result: finalResult as Record<string, unknown>,
        });
      }

      return { result: finalResult, provider: p.id, model, cached: false };
    } catch (err) {
      lastError = err as Error;
      const status = (err as Error & { status?: number }).status;
      const latency = Date.now() - started;

      await admin.from('pran_not_ai_providers').update({
        quota_date: todayIso,
        status: status === 429 ? 'exhausted' : 'active',
        last_error: String(lastError.message).slice(0, 300),
        last_error_at: new Date().toISOString(),
      }).eq('id', p.id);

      await admin.from('pran_not_ai_usage').insert({
        user_id: userId,
        task: req.task,
        provider: p.id,
        model,
        cached: false,
        success: false,
        error: String(lastError.message).slice(0, 300),
        latency_ms: latency,
      });
    }
  }

  throw lastError || new Error('all_providers_failed');
}
