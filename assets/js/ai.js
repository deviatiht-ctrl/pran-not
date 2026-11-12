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
  return callEdge('process-note', {
    rawText,
    language: language || getLang(),
    faculty,
    level,
    courses,
    noteId,
    mode,
  });
}

/** Analyse d'un syllabus (texte ou image). */
export async function processSyllabus({ text, imageBase64, language, faculty, level, courseId, syllabusId } = {}) {
  return callEdge('process-syllabus', {
    text,
    imageBase64,
    language: language || getLang(),
    faculty,
    level,
    courseId,
    syllabusId,
  });
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

/** Assistance aux devoirs (plan, pistes, cohérence, reformulation, bibliographie, recherche bibliothèque). */
export async function assistAssignment({
  action = 'plan',
  title,
  instructions,
  content = '',
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
    useLibrary,
    bookIds,
    language: language || getLang(),
    faculty,
    level,
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
