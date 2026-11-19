/* =====================================================================
   PRAN NÒT - ai.js
   Passerelle client vers les Edge Functions IA de Supabase.
   AUCUNE clé API IA côté client.
   ===================================================================== */
import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from './supabase.js';
import { t, getLang } from './i18n.js';

/** Erreur typée retournée par les fonctions IA. */
export class AiError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.userMessage = message;
    this.status = status;
  }
}

/**
 * Appelle une Edge Function Supabase authentifiée.
 * @param {string} fnName
 * @param {object} body
 */
export async function callEdge(fnName, body = {}) {
  if (!navigator.onLine) {
    throw new AiError('offline', t('errors.offline'), 0);
  }
  const db = window.db;
  const { data } = await db.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) {
    throw new AiError('not_authenticated', t('errors.session_expired'), 401);
  }

  let res;
  try {
    res = await fetch(`${FUNCTIONS_URL}/${fnName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AiError('network', t('errors.network'), 0);
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    const code = json?.code || (res.status === 429 ? 'quota_exceeded' : 'ai_error');
    const msg = json?.message || (code === 'quota_exceeded' ? t('errors.quota') : t('errors.ai_unavailable'));
    throw new AiError(code, msg, res.status);
  }

  return json;
}

/** Appel générique à ai-gateway. */
export async function aiGateway({ task, faculty = 'autre', level = 'L1', language, payload = {} }) {
  return callEdge('ai-gateway', {
    task,
    faculty,
    level,
    language: language || getLang(),
    payload,
  });
}

/** OCR de photos de tableau / cahier (base64 JPEG compressées). */
export async function ocrBoard({ imagesBase64, language, faculty, level, noteId } = {}) {
  return callEdge('ocr-board', {
    imagesBase64,
    language: language || getLang(),
    faculty,
    level,
    noteId,
  });
}

/** Transcription audio haute fidélité (Whisper large-v3 + Gemini audio) créole / français / mélange. */
export async function transcribeAudio({
  audioBase64,
  mimeType = 'audio/webm',
  language,
  noteId,
  chunkIndex = 0,
  mode = 'detailed',
  courseName = '',
  faculty = '',
  previousContext = '',
} = {}) {
  return callEdge('transcribe', {
    audioBase64,
    mimeType,
    language: language || getLang(),
    noteId,
    chunkIndex,
    mode,
    courseName,
    faculty,
    previousContext,
  });
}

/** Structuration complète d'une note brute + suggestion de cours. */
export async function processNote({ rawText, language, faculty, level, courses = [], noteId, mode = 'standard' } = {}) {
  const chosenLang = language || getLang();
  try {
    const res = await callEdge('process-note', {
      rawText,
      language: chosenLang,
      faculty,
      level,
      courses,
      noteId,
      mode,
    });
    if (res && (res.content_html || res.title || res.summary)) {
      return res;
    }
  } catch (err) {
    console.warn('[ai] process-note edge function failed, activating deep academic fallback via askTutor:', err);
  }

  // Repli robuste vers l'IA tuteur en direct pour structuration pédagogique approfondie
  try {
    const langLabel = chosenLang === 'fr' ? 'Français académique soigné' : 'Kreyòl Ayisyen klè, akademik e natirèl';
    const courseListHint = courses.length ? `Kou ki egziste deja : ${JSON.stringify(courses.map(c => ({ id: c.id, name: c.name })))}` : '';

    const fallbackPrompt = `Tu es l'analyste académique d'élite de Pran Nòt pou etidyan inivèsitè an Ayiti.
MISYON CRUCIALE :
Analize tèks brit sa a ki soti nan yon kou an dirèk oswa yon dikte vokal. Tèks la ka gen bri, mo ki manke, fraz kreyòl oswa franse ki pa fin lojik oswa ki koupe.
Ou dwe :
1. Analize CHAK mo ak CHAK lide nan tèks la san w pa koupe l kout. Pa fè yon rezime twò kout !
2. Si gen fraz ki pa lojik, refè lojik la pou l vin klè, inivèsitè, e byen eksplike.
3. Rekonstwi yon kou konplè, rich, byen devlope avèk seksyon tit klè.

LANGUE EXIGÉE : ${langLabel}.
${courseListHint}

ESTRIKTI OBLIGATWA POU "content_html" :
- <h2>1. Entwodiksyon & Konsèp Kle</h2> (mete kontèks la ak gwo definisyon yo)
- <h2>2. Devlopman & Eksplikasyon Detaye</h2> (itilize <h3> pou chak gwo lide, <p> byen ekri, definisyon konplè)
- <h2>3. Pwen Esansyèl pou Egzamen</h2> (anba fòm lis <ul><li><strong>Mo/Pwen</strong> : Eksplikasyon detaye...</li></ul>)
- <h2>4. Egzanp Konkrè Pwofesè a</h2> (itilize <blockquote> pou ilistrasyon oswa ka pratik)

Retounen STRICTEMENT yon sèl objè JSON valide san okenn lòt tèks oswa kòd deyò a :
{
  "title": "Tit presi ak akademik pou kou a",
  "summary": "Rezime konplè ak pècutan an 4 a 6 fraz sou tout sa k te di nan kou a",
  "content_html": "HTML rich ak pwòp ki gen <h2>, <h3>, <p>, <ul>, <li>, <strong>, <blockquote>",
  "content_text": "Tout tèks kou a devlope san baliz HTML",
  "takeaways": ["Pwen kle 1 pou egzamen", "Pwen kle 2", "Pwen kle 3", "Pwen kle 4"],
  "keywords": ["Tèm 1", "Tèm 2", "Tèm 3", "Tèm 4"],
  "homework": [
    { "title": "Travay oswa devwa", "description": "Detay sou devwa a si pwofesè a te bay li" }
  ],
  "suggested_course_id": null
}

Tèks brit kou a :
${String(rawText || '').slice(0, 24000)}`;

    const tutorRes = await askTutor({
      message: fallbackPrompt,
      mode: 'simple',
      scope: 'global',
      contextType: 'general',
      faculty: faculty || 'autre',
      level: level || 'L1',
      language: chosenLang,
    });

    const reply = tutorRes?.reply || '';
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed && (parsed.content_html || parsed.summary || parsed.title)) {
        if (!parsed.content_text && parsed.content_html) {
          parsed.content_text = parsed.content_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        return { ok: true, ...parsed, provider: tutorRes?.provider || 'gemini-fallback' };
      }
    }
  } catch (fallbackErr) {
    console.warn('[ai] askTutor note processing fallback failed:', fallbackErr);
  }

  // Dernier recours : structuration locale basique élégante
  const safeText = String(rawText || '').trim();
  const paragraphs = safeText.split(/\n\s*\n/).filter(Boolean).map((p) => `<p>${p.trim()}</p>`).join('');
  return {
    ok: true,
    title: safeText.slice(0, 50) || 'Nòt Kou',
    summary: safeText.slice(0, 240),
    content_html: `<h2>Nòt Kou</h2>${paragraphs || `<p>${safeText}</p>`}`,
    content_text: safeText,
    takeaways: [],
    keywords: [],
    homework: [],
    suggested_course_id: null,
  };
}

/** Analyse d'un syllabus (texte ou image). */
export async function processSyllabus({ text, imageBase64, language, faculty, level, courseId, syllabusId } = {}) {
  try {
    return await callEdge('process-syllabus', {
      text,
      imageBase64,
      language: language || getLang(),
      faculty,
      level,
      courseId,
      syllabusId,
    });
  } catch (err) {
    console.warn('[ai] process-syllabus edge function failed, falling back to askTutor:', err);
    try {
      const fallbackPrompt = `Analyse ce syllabus universitaire et découpe-le en chapitres / unités d'apprentissage claires.
Retourne UNIQUEMENT un JSON valide au format exact suivant, sans aucun bloc markdown, sans texte additionnel :
{
  "course_title": "Titre du cours",
  "professor": "Nom de l'enseignant",
  "objectives": ["Objectif 1", "Objectif 2"],
  "evaluation": "Pondération des examens",
  "study_order": ["Chapitre 1", "Chapitre 2"],
  "units": [
    {
      "title": "Titre du chapitre",
      "description": "Description concise",
      "objectives": ["Obj 1"],
      "keywords": ["mot-clé 1"],
      "planned_week": 1,
      "weight": 15
    }
  ]
}

Texte du syllabus :
${(text || '').slice(0, 25000)}`;

      const tutorRes = await askTutor({
        message: fallbackPrompt,
        mode: 'simple',
        scope: 'global',
        contextType: 'general',
        faculty,
        level,
        language: language || getLang(),
      });

      const reply = tutorRes?.reply || '';
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed?.units) && parsed.units.length) {
          return { analysis: parsed, provider: tutorRes?.provider || 'gemini-fallback' };
        }
      }
    } catch (fallbackErr) {
      console.warn('[ai] askTutor syllabus fallback failed:', fallbackErr);
    }
    throw err;
  }
}

/** Génération automatique de flashcards (SM-2). */
export async function generateFlashcards({ content, title, language, faculty, level, count = 8, courseId, unitId, noteId } = {}) {
  return callEdge('generate-flashcards', {
    content,
    title,
    language: language || getLang(),
    faculty,
    level,
    count,
    courseId,
    unitId,
    noteId,
  });
}

/** Génération d'un test ciblé ou rattrapage. */
export async function generateTest({ content, title, difficulty = 'medium', kind = 'standard', language, faculty, level, count = 6, weakKeywords = [] } = {}) {
  return callEdge('generate-test', {
    content,
    title,
    difficulty,
    kind,
    language: language || getLang(),
    faculty,
    level,
    count,
    weakKeywords,
  });
}

/** Correction IA d'une réponse courte ou d'un cas pratique. */
export async function gradeAnswer({ question, expectedAnswer, studentAnswer, maxPoints = 2, language, faculty, level } = {}) {
  return aiGateway({
    task: 'grade_answer',
    faculty,
    level,
    language: language || getLang(),
    payload: { question, expectedAnswer, studentAnswer, maxPoints },
  });
}

/** Tuteur IA contextuel. */
export async function askTutor({
  conversationId,
  message,
  mode = 'standard',
  scope = 'global',
  contextType = 'general',
  contextId = null,
  contextText = '',
  courseId = null,
  useLibrary = true,
  faculty,
  level,
  language,
  history = [],
} = {}) {
  return callEdge('tutor', {
    conversationId,
    message,
    mode,
    scope,
    contextType,
    contextId,
    contextText,
    courseId,
    useLibrary,
    faculty,
    level,
    language: language || getLang(),
    history,
  });
}

/** Assistance aux devoirs (plan, pistes, cohérence, reformulation, critique soumission, questions directes, bibliographie, recherche bibliothèque). */
export async function assistAssignment({
  action = 'solve',
  title,
  instructions,
  content = '',
  question = '',
  scope = 'global',
  useLibrary = true,
  bookIds = [],
  language,
  faculty,
  level,
} = {}) {
  return callEdge('assignment-assist', {
    action,
    title,
    instructions,
    content,
    question,
    scope,
    useLibrary,
    bookIds,
    language: language || getLang(),
    faculty,
    level,
  });
}

/** Eskane foto kouvèti yon liv pou idantifye l epi chèche PDF la otomatikman. */
export async function scanBookCover({
  imageBase64,
  faculty,
  level,
  language,
} = {}) {
  return callEdge('library-research', {
    action: 'scan_cover',
    imageBase64,
    faculty,
    level,
    language: language || getLang(),
  });
}

/** Recherche universelle (Bibliothèque officielle/personnelle + Web académique réel). */
export async function searchLibraryWeb({
  query,
  faculty,
  includeLibrary = true,
  language,
} = {}) {
  return callEdge('library-research', {
    action: 'search_web',
    query,
    faculty,
    includeLibrary,
    language: language || getLang(),
  });
}

/** Analyse sécurisée d'une source Web / PDF / Texte avec vérification anti-plagiat. */
export async function analyzeLibrarySource({
  url = '',
  rawText = '',
  title = '',
  author = '',
  topic = '',
  faculty,
  language,
  saveToLibrary = false,
} = {}) {
  return callEdge('library-research', {
    action: 'analyze_source',
    url,
    rawText,
    title,
    author,
    topic,
    faculty,
    language: language || getLang(),
    saveToLibrary,
  });
}

/** Assistant IA sourcé sur les livres, codes de loi et sources web. */
export async function askLibrary({
  question,
  bookIds = [],
  useWeb = false,
  faculty,
  level,
  language,
} = {}) {
  return callEdge('library-research', {
    action: 'ask_library',
    question,
    bookIds,
    useWeb,
    faculty,
    level,
    language: language || getLang(),
  });
}

/** Créateur de livre / manuel universitaire original sans plagiat. */
export async function generateLibraryBook({
  topic,
  instructions = '',
  chapterCount = 5,
  selectedBookIds = [],
  includeWebSearch = true,
  saveToLibrary = true,
  faculty,
  level,
  language,
} = {}) {
  return callEdge('library-research', {
    action: 'generate_book',
    topic,
    instructions,
    chapterCount,
    selectedBookIds,
    includeWebSearch,
    saveToLibrary,
    faculty,
    level,
    language: language || getLang(),
  });
}

/** Explication rapide ou simplification d'une note. */
export async function explainText({ text, mode = 'simple', language, faculty, level } = {}) {
  return aiGateway({
    task: 'explain',
    faculty,
    level,
    language: language || getLang(),
    payload: { text, mode },
  });
}

/** Statut du quota journalier de l'étudiant. */
export async function getQuotaStatus() {
  if (!navigator.onLine) {
    try {
      const cached = localStorage.getItem('prannot.quota');
      if (cached) return JSON.parse(cached);
    } catch { /* ignore */ }
    return { used: 0, quota: 60 };
  }
  try {
    const { data, error } = await window.db.rpc('pran_not_ai_quota_status');
    if (error) throw error;
    const res = data || { used: 0, quota: 60 };
    try { localStorage.setItem('prannot.quota', JSON.stringify(res)); } catch { /* ignore */ }
    return res;
  } catch {
    return { used: 0, quota: 60 };
  }
}

/** Met une tâche IA lourde en file d'attente (pran_not_ai_jobs) pour traitement différé. */
export async function queueAiJob(task, payload = {}) {
  const { data: sessionData } = await window.db.auth.getSession();
  const uid = sessionData?.session?.user?.id;
  if (!uid) throw new AiError('not_authenticated', t('errors.session_expired'), 401);
  const { data, error } = await window.db
    .from('pran_not_ai_jobs')
    .insert({ user_id: uid, task, payload, status: 'queued' })
    .select()
    .single();
  if (error) throw error;
  return data;
}
