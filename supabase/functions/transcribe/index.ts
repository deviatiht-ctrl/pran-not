// Edge Function : transcribe
// Transcription haute fidélité pour salles de cours (Kreyòl ayisyen + Français) :
// 1. Groq Whisper (whisper-large-v3 avec filtrage anti-hallucinations & contexte du cours)
// 2. Raffinement ou repli multimodal natif via Gemini Audio (gemini-3.5-flash-lite / fallback)
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { authenticateUser } from '../_shared/supabase.ts';
import { QuotaExceededError, stripEmojis } from '../_shared/ai.ts';

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_GEMINI_AUDIO_BYTES = 14 * 1024 * 1024;

function cleanBase64Input(raw: string): string {
  return raw.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '').trim();
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function normalizeAudioMime(rawMime: string): { mime: string; ext: string; geminiMime: string } {
  const clean = String(rawMime || 'audio/webm').split(';')[0].trim().toLowerCase() || 'audio/webm';
  if (clean.includes('mp4')) return { mime: 'audio/mp4', ext: 'mp4', geminiMime: 'audio/mp4' };
  if (clean.includes('m4a')) return { mime: 'audio/mp4', ext: 'm4a', geminiMime: 'audio/mp4' };
  if (clean.includes('aac')) return { mime: 'audio/aac', ext: 'aac', geminiMime: 'audio/aac' };
  if (clean.includes('mpeg') || clean.includes('mp3')) return { mime: 'audio/mpeg', ext: 'mp3', geminiMime: 'audio/mp3' };
  if (clean.includes('ogg') || clean.includes('opus')) return { mime: 'audio/ogg', ext: 'ogg', geminiMime: 'audio/ogg' };
  if (clean.includes('wav')) return { mime: 'audio/wav', ext: 'wav', geminiMime: 'audio/wav' };
  if (clean.includes('flac')) return { mime: 'audio/flac', ext: 'flac', geminiMime: 'audio/flac' };
  return { mime: 'audio/webm', ext: 'webm', geminiMime: 'audio/webm' };
}

const HALLUCINATION_PATTERNS = [
  /\bamara\.org\b/i,
  /\bsubtitles?\s+(by|for|made|provided|created|community)\b/i,
  /^sous[- ]?titr(?:es?|age)\s+(r[ée]alis[ée]s?|faits?|par)\b/i,
  /\bmerci\s+d['’]avoir\s+(regard[ée]|[ée]cout[ée]|suivi)\b/i,
  /\bthank\s+you\s+for\s+(watching|listening)\b/i,
  /\bplease\s+(subscribe|like\s+and\s+subscribe)\b/i,
  /\btranscri(?:bed|ption)\s+by\b/i,
  /\bmbc\s+pro\b/i,
  /^kou\s+iniv[èe]site\s+an\s+ayiti/i,
  /melanj\s+natir[èe]l\s+krey[òo]l\s+ayisyen/i,
  /^www\.\S+\.\S+$/i,
  /^[\s.,!?;:\-–—'"()[\]]+$/,
];

function isSilentPcmWav(bytes: Uint8Array, mime: string): boolean {
  if (mime !== 'audio/wav' || bytes.byteLength < 64) return false;
  // Vérifier en-tête RIFF....WAVE
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return false;
  if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let audioFmt = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 24 <= bytes.byteLength) {
      audioFmt = view.getUint16(offset + 8, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (id === 'data' && audioFmt === 1 && bitsPerSample === 16) {
      const end = Math.min(bytes.byteLength - 1, offset + 8 + size);
      let peak = 0;
      const step = Math.max(2, Math.floor((end - (offset + 8)) / 4000) * 2);
      for (let i = offset + 8; i + 1 < end; i += step) {
        const sample = Math.abs(view.getInt16(i, true));
        if (sample > peak) peak = sample;
        if (peak > 40) return false;
      }
      return peak <= 40;
    }
    offset += 8 + size + (size % 2);
  }
  return false;
}

function cleanTranscriptText(raw: string): string {
  const stripped = stripEmojis(String(raw || '')).replace(/\s+\n/g, '\n').trim();
  if (!stripped) return '';
  if (HALLUCINATION_PATTERNS.some((re) => re.test(stripped))) return '';
  return stripped;
}

function filterWhisperSegments(data: Record<string, unknown>): string {
  const segments = Array.isArray(data?.segments) ? data.segments as Array<{
    text?: string;
    no_speech_prob?: number;
    avg_logprob?: number;
  }> : [];

  if (!segments.length) {
    return cleanTranscriptText(String(data?.text || ''));
  }

  const kept: string[] = [];
  let prevNorm = '';
  let repeatCount = 0;

  for (const seg of segments) {
    const segText = cleanTranscriptText(seg.text || '');
    if (!segText) continue;

    const noSpeech = typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : 0;
    const avgLogProb = typeof seg.avg_logprob === 'number' ? seg.avg_logprob : 0;

    // Écarter uniquement les segments franchement silencieux ou hallucinations aléatoires (tolérant pour le créole/micro éloigné)
    if (noSpeech > 0.92 && avgLogProb < -1.4) continue;
    if (avgLogProb < -2.45) continue;

    const norm = segText.toLowerCase();
    if (norm === prevNorm) {
      repeatCount++;
      if (repeatCount >= 2) continue;
    } else {
      prevNorm = norm;
      repeatCount = 0;
    }
    kept.push(segText);
  }

  const joined = cleanTranscriptText(kept.join(' '));
  if (joined) return joined;

  // Repli sur le texte global s'il n'est pas une hallucination connue
  const avgNoSpeech = segments.reduce((s, seg) => s + (typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : 0), 0) / segments.length;
  if (avgNoSpeech < 0.94 && data?.text) {
    return cleanTranscriptText(String(data.text));
  }
  return '';
}

async function runGroqWhisper(params: {
  apiKey: string;
  model: string;
  bytes: Uint8Array;
  mime: string;
  ext: string;
  language: string;
  prompt: string;
}) {
  const form = new FormData();
  const blob = new Blob([params.bytes], { type: params.mime });
  form.append('file', blob, `lecture.${params.ext}`);
  form.append('model', params.model);
  form.append('temperature', '0');
  form.append('response_format', 'verbose_json');
  form.append('prompt', params.prompt.slice(0, 700));
  if (params.language === 'fr') {
    form.append('language', 'fr');
  }

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${params.apiKey}` },
    signal: AbortSignal.timeout(45000),
    body: form,
  });

  if (!res.ok) {
    const errTxt = await res.text();
    const err = new Error(`groq_${res.status}: ${errTxt.slice(0, 220)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const data = await res.json();
  return {
    text: filterWhisperSegments(data),
    detectedLang: String(data?.language || ''),
    durationSec: Number(data?.duration || 0),
  };
}

async function runGeminiAudio(params: {
  apiKey: string;
  model: string;
  audioBase64: string;
  geminiMime: string;
  language: string;
  courseName: string;
  faculty: string;
  previousContext: string;
  whisperDraft: string;
}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.model)}:generateContent?key=${params.apiKey}`;
  const langGuide = params.language === 'fr'
    ? 'Transcris fidèlement en français académique, en conservant les citations éventuelles.'
    : params.language === 'ht'
      ? 'Transkri ak presizyon an Kreyòl ayisyen (ak tèm teknik/syantifik inivèsitè egzak).'
      : 'Transcris fidèlement en gardant le mélange naturel Créole haïtien / Français du professeur tel que prononcé, tout en corrigeant l’orthographe des termes techniques.';

  const silenceRule = params.whisperDraft
    ? 'Un moteur ASR a déjà détecté des paroles dans cet extrait. Écoute attentivement même si le volume est faible ou si le créole haïtien se mêle au français, corrige l’orthographe et restitue fidèlement toutes les phrases entendues sans rien supprimer.'
    : 'Écoute très attentivement même les voix faibles ou lointaines. Réponds __SILENCE__ uniquement si l’audio ne contient vraiment aucune parole humaine compréhensible.';

  const systemInstruction = [
    'Tu es un transcripteur universitaire haïtien spécialisé dans la prise de notes en amphithéâtre.',
    'Le professeur parle parfois vite, loin du microphone ou à volume modéré en Kreyòl ayisyen et Français.',
    'PRIORITÉ ABSOLUE : ISOLE LA VOIX DU PROFESSEUR. Ignore les chuchotements, rires, froissements de papier et bavardages parasites des étudiants en arrière-plan. Si un étudiant pose une question audible au professeur, indique sobrement "[Kesyon] ..." puis transcris la réponse du professeur.',
    langGuide,
    'RÈGLE STRICTE DE FIDÉLITÉ : transcris fidèlement ce qui est prononcé dans l’audio. N’invente jamais de contenu hors sujet et ne modifie pas la logique du cours.',
    silenceRule,
    'Structure légèrement avec des retours à la ligne ou puces sobres si le professeur énumère des points, définitions ou formules.',
    'RÈGLE OBLIGATOIRE : ZÉRO emoji ou pictogramme dans la réponse.',
  ].join('\n');

  const contextLines = [
    params.courseName ? `Cours : ${params.courseName}` : '',
    params.faculty ? `Faculté : ${params.faculty}` : '',
    params.previousContext ? `Contexte immédiat précédent : "${params.previousContext.slice(-260)}"` : '',
    params.whisperDraft
      ? `Brouillon ASR détecté à vérifier et affiner fidèlement selon l’audio :\n"${params.whisperDraft}"`
      : 'Écoute attentivement l’audio joint (y compris les voix faibles) et fournis la transcription exacte.',
  ].filter(Boolean).join('\n\n');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{
        role: 'user',
        parts: [
          { text: contextLines },
          { inlineData: { mimeType: params.geminiMime, data: params.audioBase64 } },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
      },
    }),
  });

  if (!res.ok) {
    const errTxt = await res.text();
    const err = new Error(`gemini_${res.status}: ${errTxt.slice(0, 220)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const visible = parts.filter((p: { thought?: boolean; text?: string }) => !p.thought && Boolean(p.text));
  const rawOut = (visible.length ? visible : parts).map((p: { text?: string }) => p.text || '').join('\n').trim();
  const usage = data?.usageMetadata || {};
  const isSilence = !rawOut || /^\s*__SILENCE__\s*$/i.test(rawOut);
  return {
    text: isSilence ? '' : cleanTranscriptText(rawOut),
    isSilence,
    tokensIn: usage.promptTokenCount || 0,
    tokensOut: usage.candidatesTokenCount || 0,
  };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  try {
    const auth = await authenticateUser(req);
    if ('error' in auth) return errorResponse(auth.error, 'Non authentifié', auth.status);

    const groqKey = Deno.env.get('GROQ_API_KEY') || '';
    const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';
    if (!groqKey && !geminiKey) {
      return errorResponse('no_provider', 'Aucun fournisseur audio configuré (GROQ_API_KEY / GEMINI_API_KEY).', 500);
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const effectiveQuota = Math.max(auth.profile?.ai_daily_quota || 500, 500) * 4; // Quota étendu pour les segments de cours en direct
    const { count: usedToday } = await auth.admin
      .from('pran_not_ai_usage')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', auth.user.id)
      .eq('cached', false)
      .eq('success', true)
      .gte('created_at', `${todayIso}T00:00:00.000Z`);

    if ((usedToday ?? 0) >= effectiveQuota) {
      throw new QuotaExceededError('Ou rive nan limit segman IA jodi a. Ou ka kontinye pran nòt dirèk alamen san entèripsyon.');
    }

    const body = await req.json();
    const audioBase64 = cleanBase64Input(String(body.audioBase64 || ''));
    if (!audioBase64) return errorResponse('invalid_input', 'Audio manquant.', 400);

    const bytes = base64ToUint8Array(audioBase64);
    if (bytes.byteLength < 200) {
      return jsonResponse({ ok: true, text: '', empty: true, provider: 'none' });
    }
    if (bytes.byteLength > MAX_AUDIO_BYTES) {
      return errorResponse('file_too_large', 'Fichye odyo a depase limit 24 Mo pou yon segman.', 413);
    }

    const language = String(body.language || 'mix');
    const mode = body.mode === 'fast' ? 'fast' : 'detailed';
    const courseName = String(body.courseName || '').trim();
    const faculty = String(body.faculty || auth.profile?.faculty_id || '').trim();
    const previousContext = String(body.previousContext || '').trim();
    const { mime, ext, geminiMime } = normalizeAudioMime(body.mimeType || 'audio/webm');

    if (isSilentPcmWav(bytes, mime)) {
      return jsonResponse({ ok: true, text: '', empty: true, provider: 'none' });
    }

    // Lire les modèles configurés dans admin
    const { data: provRows } = await auth.admin
      .from('pran_not_ai_providers')
      .select('id, model_audio, status')
      .in('id', ['groq', 'gemini']);

    const groqCfg = provRows?.find((p) => p.id === 'groq');
    const geminiCfg = provRows?.find((p) => p.id === 'gemini');
    const groqModelPrimary = groqCfg?.model_audio || 'whisper-large-v3';
    const geminiModelPrimary = geminiCfg?.model_audio || 'gemini-3.5-flash-lite';

    const whisperPrompt = [
      'Kou inivèsitè an Ayiti. Melanj natirèl Kreyòl ayisyen ak Fransè.',
      'Konsantre sou vwa pwofesè a. Inyore chwichwi ak bri etidyan.',
      courseName ? `Matyè : ${courseName}.` : '',
      faculty ? `Fakilte : ${faculty}.` : '',
      previousContext ? previousContext.slice(-220) : '',
    ].filter(Boolean).join(' ');

    let groqText = '';
    let detectedLang = '';
    let usedProvider = '';
    let groqFailed = false;

    // 1. Passe Groq Whisper (whisper-large-v3 -> repli whisper-large-v3-turbo)
    if (groqKey && groqCfg?.status !== 'disabled') {
      const modelsToTry = Array.from(new Set([groqModelPrimary, 'whisper-large-v3-turbo']));
      for (const m of modelsToTry) {
        const started = Date.now();
        try {
          const res = await runGroqWhisper({
            apiKey: groqKey,
            model: m,
            bytes,
            mime,
            ext,
            language,
            prompt: whisperPrompt,
          });
          groqText = res.text;
          detectedLang = res.detectedLang;
          usedProvider = `groq:${m}`;
          await auth.admin.from('pran_not_ai_usage').insert({
            user_id: auth.user.id,
            task: 'transcribe',
            provider: 'groq',
            model: m,
            cached: false,
            success: true,
            latency_ms: Date.now() - started,
          });
          groqFailed = false;
          break;
        } catch (err) {
          groqFailed = true;
          await auth.admin.from('pran_not_ai_usage').insert({
            user_id: auth.user.id,
            task: 'transcribe',
            provider: 'groq',
            model: m,
            cached: false,
            success: false,
            error: String((err as Error).message || err).slice(0, 300),
            latency_ms: Date.now() - started,
          });
        }
      }
    } else {
      groqFailed = true;
    }

    // 2. Passe Gemini Audio multimodal :
    // - soit en raffinement précis ("detailed") si l'audio <= 14 MB
    // - soit en secours complet si Groq a échoué / retourné vide sur un vrai extrait audio
    let finalText = groqText;
    let refined = false;
    const shouldCallGemini = Boolean(geminiKey)
      && geminiCfg?.status !== 'disabled'
      && bytes.byteLength <= MAX_GEMINI_AUDIO_BYTES
      && (groqFailed || !groqText || mode === 'detailed');

    if (shouldCallGemini) {
      const gemModels = mode === 'detailed'
        ? Array.from(new Set(['gemini-2.5-flash', geminiModelPrimary]))
        : Array.from(new Set([geminiModelPrimary, 'gemini-2.5-flash']));
      for (const gm of gemModels) {
        const started = Date.now();
        try {
          const gRes = await runGeminiAudio({
            apiKey: geminiKey,
            model: gm,
            audioBase64,
            geminiMime,
            language,
            courseName,
            faculty,
            previousContext,
            whisperDraft: groqText,
          });
          await auth.admin.from('pran_not_ai_usage').insert({
            user_id: auth.user.id,
            task: 'transcribe',
            provider: 'gemini',
            model: gm,
            tokens_in: gRes.tokensIn,
            tokens_out: gRes.tokensOut,
            cached: false,
            success: true,
            latency_ms: Date.now() - started,
          });
          if (gRes.text) {
            finalText = gRes.text;
            refined = Boolean(groqText);
            usedProvider = groqText ? `${usedProvider}+gemini:${gm}` : `gemini:${gm}`;
            break;
          } else if (groqText) {
            // Ne jamais effacer un brouillon Groq valide si Gemini renvoie __SILENCE__
            finalText = groqText;
            refined = false;
            usedProvider = usedProvider || `groq:${groqModelPrimary}`;
            break;
          } else {
            usedProvider = usedProvider || `gemini:${gm}`;
            // Si le 1er modèle Gemini retourne silence mais qu'un fallback plus robuste existe, essayer le suivant
          }
        } catch (err) {
          await auth.admin.from('pran_not_ai_usage').insert({
            user_id: auth.user.id,
            task: 'transcribe',
            provider: 'gemini',
            model: gm,
            cached: false,
            success: false,
            error: String((err as Error).message || err).slice(0, 300),
            latency_ms: Date.now() - started,
          });
        }
      }
    }

    if (!usedProvider) {
      return errorResponse('transcribe_failed', 'Erreur de transcription audio.', 502);
    }

    if (body.noteId) {
      await auth.admin
        .from('pran_not_note_sources')
        .update({ transcript: finalText, status: 'done' })
        .eq('note_id', body.noteId)
        .eq('user_id', auth.user.id)
        .eq('chunk_index', Number(body.chunkIndex || 0))
        .eq('kind', 'audio');
    }

    return jsonResponse({
      ok: true,
      text: finalText,
      rawWhisper: groqText || null,
      refined,
      language: detectedLang || language || 'ht',
      provider: usedProvider,
    });
  } catch (err) {
    if (err instanceof QuotaExceededError) return errorResponse('quota_exceeded', err.message, 429);
    console.error('[transcribe]', err);
    return errorResponse('transcribe_error', (err as Error).message || 'Erreur transcription', 500);
  }
});
