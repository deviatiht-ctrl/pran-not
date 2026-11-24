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

/** Nettoie et répare une chaîne JSON issue d'un LLM pour éviter toute SyntaxError */
export function cleanAndParseJsonClient(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  let str = String(raw).trim();

  // 1. Essai direct
  try {
    return JSON.parse(str);
  } catch { /* suite */ }

  // 2. Extraire bloc markdown ```json ... ```
  if (str.includes('```')) {
    const fencedMatch = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch && fencedMatch[1]) {
      str = fencedMatch[1].trim();
      try {
        return JSON.parse(str);
      } catch { /* suite */ }
    } else {
      str = str.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    }
  }

  // 3. Délimiter premier et dernier crochet ou accolade
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

  // 4. Normaliser guillemets typographiques
  str = str.replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"');
  str = str.replace(/[\u2018\u2019]/g, "'");

  // 5. Supprimer commentaires JS // et /* */
  str = str.replace(/\/\/[^\n\r]*/g, '');
  str = str.replace(/\/\*[\s\S]*?\*\//g, '');

  // 6. Échapper les sauts de ligne et tabulations non échappés à l'intérieur des chaînes
  let inString = false;
  let escaped = false;
  let repaired = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      repaired += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      repaired += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      repaired += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') {
        repaired += '\\n';
        continue;
      }
      if (ch === '\r') continue;
      if (ch === '\t') {
        repaired += '\\t';
        continue;
      }
      if (ch.charCodeAt(0) < 32) continue;
    }
    repaired += ch;
  }

  // 7. Supprimer les virgules traînantes avant } ou ]
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // 8. Équilibrer les accolades/crochets non fermés
  const stack = [];
  inString = false;
  escaped = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
      else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
    }
  }
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, '');
  while (stack.length > 0) {
    const top = stack.pop();
    repaired += top === '{' ? '}' : ']';
  }

  try {
    return JSON.parse(repaired);
  } catch (err) {
    console.warn('[cleanAndParseJsonClient] JSON parse failed after repair:', err, repaired.slice(0, 160));
    return null;
  }
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
    const parsed = cleanAndParseJsonClient(reply);
    if (parsed && (parsed.content_html || parsed.summary || parsed.title)) {
      if (!parsed.content_text && parsed.content_html) {
        parsed.content_text = parsed.content_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      return { ok: true, ...parsed, provider: tutorRes?.provider || 'gemini-fallback' };
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
      const parsed = cleanAndParseJsonClient(reply);
      if (Array.isArray(parsed?.units) && parsed.units.length) {
        return { analysis: parsed, provider: tutorRes?.provider || 'gemini-fallback' };
      }
    } catch (fallbackErr) {
      console.warn('[ai] askTutor syllabus fallback failed:', fallbackErr);
    }
    throw err;
  }
}

/** Repli local intelligent pour créer des flashcards sans IA */
function createClientFallbackCards({ content = '', title = 'Kat memwa', count = 8, language = 'ht' } = {}) {
  const isHt = language === 'ht';
  const clean = String(content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = clean
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.length < 220);

  const cards = [];

  cards.push({
    type: 'definition',
    front: isHt ? `Ki lide oswa sijè prensipal "${title}" abòde ?` : `Quel est le thème principal abordé dans "${title}" ?`,
    back: isHt
      ? (sentences[0] || `Konsèp fondamantal etidye nan kad "${title}".`)
      : (sentences[0] || `Notion fondamentale abordée dans le cadre de "${title}".`),
    tags: [title.slice(0, 30)],
  });

  for (let i = 1; i < Math.min(sentences.length, count); i++) {
    const s = sentences[i];
    cards.push({
      type: 'qa',
      front: isHt ? `Kisa pou w sonje sou pwen sa a : "${s.slice(0, 100)}..." ?` : `Que retenir de ce point clé : "${s.slice(0, 100)}..." ?`,
      back: s,
      tags: ['etid'],
    });
  }

  if (cards.length < count) {
    cards.push({
      type: 'qa',
      front: isHt ? `Ki pi bon estrateji pou metrize nòt sa a ?` : `Quelle est la méthode recommandée pour assimiler ce cours ?`,
      back: isHt
        ? 'Pratike repitisyon espase chak jou ak tès regilye sou Pran Nòt.'
        : 'Pratiquer la répétition espacée quotidienne et des quiz réguliers sur Pran Nòt.',
      tags: ['metodoloji'],
    });
  }

  return {
    ok: true,
    cards: cards.slice(0, count),
    provider: 'local-resilient',
  };
}

/** Repli local intelligent pour créer un quiz sans IA */
function createClientFallbackQuiz({ content = '', title = 'Tès etid', count = 5, language = 'ht' } = {}) {
  const isHt = language === 'ht';
  const clean = String(content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = clean
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.length < 220);

  const questions = [];

  // Question 1 : Sijè prensipal kou a
  questions.push({
    position: 1,
    type: 'mcq',
    prompt: isHt
      ? `Ki pwen prensipal kou "${title}" la abòde an premye lye ?`
      : `Quel est le thème central abordé dans le cours "${title}" ?`,
    options: isHt
      ? [
          `Prensip kle ak konsèp fondamantal ${title}`,
          `Istwa jeneral san rapò dirèk ak kou a`,
          `Règ jesyon finansyè sèlman`,
          `Detay segondè ki pa nan pwogram nan`,
        ]
      : [
          `Les principes clés et concepts fondamentaux de ${title}`,
          `Une thématique sans lien direct avec le cours`,
          `Une étude purement administrative hors programme`,
          `Des détails anecdotiques non essentiels`,
        ],
    answer: 0,
    explanation: isHt
      ? `Kou sa a konsantre prensipalman sou konesans ak metòd ki gen rapò ak ${title}.`
      : `Ce cours se concentre principalement sur les concepts et méthodes liés à ${title}.`,
    keyword: title.slice(0, 40),
    points: 1,
  });

  // Question 2 : Konpreyansyon dirèk sou tèks la
  if (sentences.length > 0) {
    const s1 = sentences[0];
    questions.push({
      position: 2,
      type: 'true_false',
      prompt: isHt
        ? `Dapre nòt kou a : "${s1.slice(0, 160)}". Èske deklarasyon sa a kòrèk ?`
        : `D'après les notes de cours : "${s1.slice(0, 160)}". Cette affirmation est-elle exacte ?`,
      options: isHt ? ['Vre', 'Fo'] : ['Vrai', 'Faux'],
      answer: 0,
      explanation: isHt
        ? `Sa koresponn dirèkteman ak pwen ki devlope nan kou a.`
        : `Cette phrase correspond directement aux éléments présentés dans le cours.`,
      keyword: 'konpreyansyon',
      points: 1,
    });
  }

  // Question 3 : Aplikasyon / Apwofondisman
  if (sentences.length > 1) {
    const s2 = sentences[Math.min(1, sentences.length - 1)];
    questions.push({
      position: 3,
      type: 'mcq',
      prompt: isHt
        ? `Konsènan pwen sa a : "${s2.slice(0, 130)}...", kisa ki pi enpòtan pou w sonje ?`
        : `Concernant ce passage : "${s2.slice(0, 130)}...", que faut-il retenir en priorité ?`,
      options: isHt
        ? [
            `Konprann lojik ak aplikasyon pratik konsèp la`,
            `Ignorer deklarasyon sa a nan egzamen`,
            `Se sèlman yon opinyon san fondasyon`,
            `Li pa gen okenn enpak sou etid yo`,
          ]
        : [
            `Comprendre la logique et l'application pratique de cette notion`,
            `Ignorer ce passage lors des révisions`,
            `Considérer qu'il s'agit d'une simple hypothèse non vérifiée`,
            `Aucun impact sur la compréhension globale`,
          ],
      answer: 0,
      explanation: isHt
        ? `Nan nenpòt etid akademik, metrize aplikasyon konsèp yo esansyèl pou egzamen.`
        : `Dans toute révision académique, assimiler le sens et l'application des concepts est primordial.`,
      keyword: 'metodoloji',
      points: 1,
    });
  }

  // Question 4 : Metòd etid (Vre / Fo)
  questions.push({
    position: questions.length + 1,
    type: 'true_false',
    prompt: isHt
      ? `Pou metrize kou "${title}" la nèt, li ase pou li l yon sèl fwa san revize l ankò.`
      : `Pour maîtriser le cours "${title}", une seule lecture rapide sans révision espacée est suffisante.`,
    options: isHt ? ['Vre', 'Fo'] : ['Vrai', 'Faux'],
    answer: 1, // Fo
    explanation: isHt
      ? `Memorizasyon efikas mande repete regilyèman ak fè tès pratik sou Pran Nòt.`
      : `La mémorisation à long terme nécessite la répétition espacée et des tests fréquents.`,
    keyword: 'revizyon',
    points: 1,
  });

  // Question 5 : Bon pratik
  if (questions.length < count) {
    questions.push({
      position: questions.length + 1,
      type: 'mcq',
      prompt: isHt
        ? `Ki pi bon estrateji pou reyisi egzamen sou "${title}" ?`
        : `Quelle est la méthode recommandée pour réussir l'évaluation sur "${title}" ?`,
      options: isHt
        ? [
            `Pran nòt klè, revize kat memwa yo epi pratike sou tès yo regilyèman`,
            `Tann lavèy egzamen an pou li tout nòt yo yon sèl kou`,
            `Pa janm poze kesyon lè yon pati pa fin klè`,
            `Fè tès yo san gade eksplikasyon yo`,
          ]
        : [
            `Prendre des notes structurées, réviser les flashcards et faire des tests réguliers`,
            `Attendre la veille de l'examen pour tout relire d'un coup`,
            `Ne poser aucune question en cas de doute`,
            `Répondre au hasard sans lire les explications`,
          ],
      answer: 0,
      explanation: isHt
        ? `Metòd etid aktif ak Pran Nòt pèmèt ou estoke konesans yo pou lontan.`
        : `La méthode active combinant prise de notes, flashcards et auto-évaluation est la plus efficace.`,
      keyword: 'estrateji',
      points: 1,
    });
  }

  return {
    ok: true,
    title,
    questions: questions.slice(0, count),
    provider: 'local-resilient',
  };
}

/** Génération automatique de flashcards (SM-2) avec repli triple couche */
export async function generateFlashcards({
  content,
  title = 'Kat memwa',
  language,
  faculty,
  level,
  count = 8,
  courseId,
  unitId,
  noteId,
  save = true,
} = {}) {
  const targetLang = language || getLang();
  const safeTitle = String(title || 'Kat memwa').trim();
  const safeContent = String(content || '').trim() || safeTitle;

  // Couche 1 : Appel Edge Function
  try {
    const res = await callEdge('generate-flashcards', {
      content: safeContent,
      title: safeTitle,
      language: targetLang,
      faculty,
      level,
      count,
      courseId,
      unitId,
      noteId,
      save,
    });
    if (res?.ok && Array.isArray(res.cards) && res.cards.length > 0) {
      return res;
    }
  } catch (err) {
    console.warn('[ai] generate-flashcards edge function failed, falling back to askTutor:', err);
  }

  // Couche 2 : Repli via askTutor
  try {
    const langPrompt = targetLang === 'ht'
      ? 'Ekri TOUT kat yo (kesyon devan, repons dèyè) NÈT ALKÒLE an KREYÒL AYISYEN klè.'
      : 'Rédige TOUTES les cartes mémoires (recto et verso) STRICTEMENT en Français académique.';

    const tutorPrompt = `${langPrompt}
Jenere yon seri de ${count} kat memwa (flashcards) sou sijè "${safeTitle}".
Kontni kou :
${safeContent.slice(0, 12000)}

Retounen STRICTEMENT yon sèl objè JSON valide san tèks deyò :
{
  "cards": [
    {
      "type": "qa",
      "front": "Kesyon oswa konsèp pou devine",
      "back": "Repons klè ak kout",
      "tags": ["tag1"]
    }
  ]
}`;

    const tutorRes = await askTutor({
      message: tutorPrompt,
      mode: 'simple',
      scope: 'global',
      contextType: 'general',
      faculty,
      level,
      language: targetLang,
    });

    const parsed = cleanAndParseJsonClient(tutorRes?.reply || tutorRes?.text || '');
    const rawCards = Array.isArray(parsed?.cards) ? parsed.cards : (Array.isArray(parsed) ? parsed : []);
    const cards = rawCards
      .map((c) => {
        const item = (c && typeof c === 'object') ? c : {};
        const front = String(item.front || item.question || item.recto || '').trim();
        const back = String(item.back || item.answer || item.reponse || item.verso || '').trim();
        if (!front || !back) return null;
        return {
          type: item.type || 'qa',
          front,
          back,
          tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 5) : [],
        };
      })
      .filter(Boolean);

    if (cards.length > 0) {
      return {
        ok: true,
        cards,
        provider: tutorRes?.provider || 'gemini-fallback',
      };
    }
  } catch (tutorErr) {
    console.warn('[ai] askTutor flashcards fallback failed:', tutorErr);
  }

  // Couche 3 : Repli local intelligent
  return createClientFallbackCards({
    content: safeContent,
    title: safeTitle,
    count,
    language: targetLang,
  });
}

/** Génération d'un test ciblé ou rattrapage avec repli triple couche */
export async function generateTest({
  content,
  title = 'Tès etid',
  difficulty = 'medium',
  kind = 'standard',
  language,
  faculty,
  level,
  count = 5,
  weakKeywords = [],
} = {}) {
  const targetLang = language || getLang();
  const safeTitle = String(title || 'Tès etid').trim();
  const safeContent = String(content || '').trim() || safeTitle;

  // Couche 1 : Appel Edge Function
  try {
    const edgeRes = await callEdge('generate-test', {
      content: safeContent,
      title: safeTitle,
      difficulty,
      kind,
      language: targetLang,
      faculty,
      level,
      count,
      weakKeywords,
    });
    if (edgeRes?.ok && Array.isArray(edgeRes.questions) && edgeRes.questions.length > 0) {
      return edgeRes;
    }
  } catch (edgeErr) {
    console.warn('[ai] generate-test edge function failed, falling back to askTutor:', edgeErr);
  }

  // Couche 2 : Repli via askTutor
  try {
    const langPrompt = targetLang === 'ht'
      ? 'Ekri TOUT kesyon yo, tout opsyon yo ak tout eksplikasyon yo NÈT ALKÒLE an KREYÒL AYISYEN klè.'
      : 'Rédige TOUTES les questions, options et explications STRICTEMENT en Français académique.';

    const tutorPrompt = `${langPrompt}
Jenere yon tès evalyasyon ${count} kesyon sou sijè sa a : "${safeTitle}".
Kontni kou a :
${safeContent.slice(0, 12000)}

Retounen STRICTEMENT yon sèl objè JSON valide san kòmantè, san okenn lòt tèks deyò :
{
  "title": "${safeTitle.replace(/"/g, "'")}",
  "questions": [
    {
      "type": "mcq",
      "prompt": "Kesyon an",
      "options": ["Chwa A", "Chwa B", "Chwa C", "Chwa D"],
      "answer": 0,
      "explanation": "Eksplikasyon poukisa chwa sa a kòrèk",
      "keyword": "tèm kle",
      "points": 1
    }
  ]
}`;

    const tutorRes = await askTutor({
      message: tutorPrompt,
      mode: 'simple',
      scope: 'global',
      contextType: 'general',
      faculty,
      level,
      language: targetLang,
    });

    const parsed = cleanAndParseJsonClient(tutorRes?.reply || tutorRes?.text || '');
    const rawQuestions = Array.isArray(parsed?.questions) ? parsed.questions : (Array.isArray(parsed) ? parsed : []);
    const questions = rawQuestions
      .map((q, idx) => {
        const item = (q && typeof q === 'object') ? q : {};
        const promptText = String(item.prompt || item.question || item.enonce || '').trim();
        if (!promptText) return null;

        let options = Array.isArray(item.options) ? item.options.map(String) : (Array.isArray(item.choices) ? item.choices.map(String) : []);
        const rawType = String(item.type || 'mcq').toLowerCase().trim();
        const type = ['mcq', 'true_false', 'short', 'case'].includes(rawType) ? rawType : 'mcq';

        if (type === 'mcq' && options.length < 2) {
          options = targetLang === 'ht' ? ['Wi / Vre', 'Non / Fo'] : ['Vrai', 'Faux'];
        }

        let answer = item.answer ?? item.correct_answer ?? item.reponse ?? 0;
        if (type === 'mcq') {
          if (typeof answer === 'string') {
            const trimmed = answer.trim();
            if (/^[0-3]$/.test(trimmed)) answer = parseInt(trimmed, 10);
            else if (/^[A-D]$/i.test(trimmed)) answer = trimmed.toUpperCase().charCodeAt(0) - 65;
            else {
              const fIdx = options.findIndex((o) => o.toLowerCase() === trimmed.toLowerCase());
              answer = fIdx >= 0 ? fIdx : 0;
            }
          } else if (typeof answer === 'number') {
            if (answer < 0 || answer >= options.length) answer = 0;
          } else {
            answer = 0;
          }
        } else if (type === 'true_false') {
          if (typeof answer === 'boolean') {
            answer = answer ? 0 : 1;
            if (!options.length) options = targetLang === 'ht' ? ['Vre', 'Fo'] : ['Vrai', 'Faux'];
          } else if (typeof answer === 'string') {
            const isTrue = /^(vre|vrai|true|t|0)$/i.test(answer.trim());
            answer = isTrue ? 0 : 1;
            if (!options.length) options = targetLang === 'ht' ? ['Vre', 'Fo'] : ['Vrai', 'Faux'];
          }
        } else {
          answer = String(answer ?? '');
        }

        return {
          position: idx + 1,
          type,
          prompt: promptText,
          options,
          answer,
          explanation: String(item.explanation || item.eksplikasyon || '').trim(),
          keyword: String(item.keyword || item.tag || '').trim().slice(0, 80),
          points: type === 'case' ? 3 : type === 'short' ? 2 : 1,
        };
      })
      .filter(Boolean);

    if (questions.length > 0) {
      return {
        ok: true,
        title: String(parsed?.title || safeTitle),
        questions,
        provider: tutorRes?.provider || 'gemini-fallback',
      };
    }
  } catch (tutorErr) {
    console.warn('[ai] askTutor test fallback failed:', tutorErr);
  }

  // Couche 3 : Repli local intelligent
  return createClientFallbackQuiz({
    content: safeContent,
    title: safeTitle,
    count,
    language: targetLang,
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
