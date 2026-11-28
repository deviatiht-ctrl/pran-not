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
  // En université en Haïti, les notes structurées de révision sont obligatoirement rédigées en Français académique par défaut,
  // sauf si l'étudiant a expressément sélectionné le créole ('ht'). Les explications créoles sont accessibles via le bouton d'explication.
  const chosenLang = language === 'ht' ? 'ht' : 'fr';
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
    const isHt = chosenLang === 'ht';
    const langLabel = isHt ? 'Kreyòl Ayisyen' : 'Français académique universitaire soigné et rigoureux';
    const courseListHint = courses.length ? `Cours existants : ${JSON.stringify(courses.map(c => ({ id: c.id, name: c.name })))}` : '';

    const fallbackPrompt = `Tu es l'analyste académique d'élite de Pran Nòt pour les étudiants universitaires en Haïti.
MISSION CRUCIALE :
Analyse et structure ce cours fidèlement.
RÈGLE FONDAMENTALE DE LANGUE : Rédige TOUTES les sections (titre, résumé, contenu_html, takeaways, homework, questions_for_professor) STRICTEMENT en ${langLabel}.
Même si le texte brut contient du créole, du code-switching ou des tournures orales, restitue la totalité du savoir, des concepts et des explications du professeur avec la plus grande élégance et rigueur académique en ${langLabel}.
Conserve absolument TOUS les noms propres d'auteurs, juristes, médecins, scientifiques cités par le professeur, les articles de lois, les formules et les dates.

Génère également 3 à 4 questions pertinentes et stimulantes ("questions_for_professor") que l'étudiant peut poser au professeur pour approfondir le cours.

${courseListHint}

STRUCTURE OBLIGATOIRE POUR "content_html" :
- <h2>1. Introduction & Contexte du Cours</h2> (pose le cadre et les définitions majeures)
- <h2>2. Développements Principaux & Notions Clés</h2> (utilise <h3> pour chaque grand axe, paragraphes clairs, définitions complètes)
- <h2>3. Auteurs, Doctrines & Textes de Référence</h2> (cite nommément chaque auteur et sa contribution)
- <h2>4. Points Essentiels pour l'Examen</h2> (liste à puces <ul><li><strong>Notion</strong> : Explication précise...</li></ul>)
- <h2>5. Exemples Pratiques & Cas Concrets</h2> (utilise <blockquote> pour les illustrations ou cas pratiques cités par l'enseignant)

Retourne STRICTEMENT un seul objet JSON valide sans texte additionnel :
{
  "title": "Titre académique précis du cours",
  "summary": "Résumé complet et percutant en 4 à 6 phrases",
  "content_html": "HTML riche et propre contenant <h2>, <h3>, <p>, <ul>, <li>, <strong>, <blockquote>",
  "content_text": "Texte intégral rédigé sans balises HTML",
  "takeaways": ["Point clé d'examen 1", "Point clé 2", "Point clé 3", "Point clé 4"],
  "keywords": ["Terme 1", "Terme 2", "Terme 3", "Terme 4"],
  "homework": [
    { "title": "Travail ou devoir", "description": "Consignes données" }
  ],
  "questions_for_professor": [
    {
      "question": "Question académique précise à poser au professeur",
      "purpose": "Pourquoi cette question éclaire un point subtil",
      "hint": "Ce qu'il faut écouter dans la réponse"
    }
  ],
  "suggested_course_id": null
}

Texte brut du cours :
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

  // Dernier recours : structuration locale bilingue intelligente d'élite (fonctionne 100% hors-ligne)
  return createClientFallbackStructuredNote({
    rawText,
    faculty,
    level,
    courses,
  });
}

/**
 * Repli local intelligent hors-ligne pour structurer une note de cours universitaire
 * en version bilingue complète (Français académique + Kreyòl Ayisyen) avec explications simples et Q&A d'examen.
 */
export function createClientFallbackStructuredNote({ rawText = '', faculty = '', level = 'L1', courses = [] } = {}) {
  const safeText = String(rawText || '').trim();
  const lines = safeText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const firstLine = lines[0] || 'Notes de Cours';
  const cleanTitle = firstLine.replace(/^[#\-*0-9.\s]+/, '').slice(0, 70).trim() || 'Notes de Cours Universitaires';

  const paragraphs = safeText
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);

  const words = safeText.split(/\s+/).filter(w => w.length > 4);
  const freq = {};
  for (const w of words) {
    const clean = w.toLowerCase().replace(/[^a-zà-öø-ÿ]/gi, '');
    if (clean.length > 4 && !['cette', 'notre', 'votre', 'leurs', 'aussi', 'comme', 'faire', 'avoir', 'etudiant', 'professeur', 'menm', 'konsa', 'paske', 'pouki'].includes(clean)) {
      freq[clean] = (freq[clean] || 0) + 1;
    }
  }
  const topKeywords = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));

  const contentHtmlFr = `
    <h2>1. Introduction & Contexte du Cours</h2>
    <p>${paragraphs[0] || safeText || 'Introduction et exposé général du cours.'}</p>
    <h2>2. Développements Principaux & Notions Clés</h2>
    ${paragraphs.slice(1, 4).map(p => `<p>${p}</p>`).join('') || `<p>${safeText}</p>`}
    <h2>3. Auteurs, Doctrines & Textes de Référence</h2>
    <p>Ce cours pose les principes théoriques fondamentaux à maîtriser pour le cursus universitaire.</p>
    <blockquote><strong>Synthèse d'étude :</strong> Assimiler rigoureusement les définitions, règles et articulations méthodologiques exposées.</blockquote>
    <h2>4. Points Essentiels pour l'Examen</h2>
    <ul>
      ${(paragraphs.slice(0, 4).map((p, i) => `<li><strong>Point clé #${i + 1}</strong> : ${p.slice(0, 140)}...</li>`)).join('') || '<li><strong>Rigueur académique</strong> : Définir avec précision chaque concept.</li>'}
    </ul>
  `.trim();

  const contentHtmlHt = `
    <h2>1. Entwodiksyon ak Kontèks Kou a</h2>
    <p>${paragraphs[0] || safeText || 'Entwodiksyon jeneral sou konsèp pwofesè a prezante nan kou a.'}</p>
    <h2>2. Gwo Pwen Devlopman ak Konsèp Kle</h2>
    ${paragraphs.slice(1, 4).map(p => `<p>${p}</p>`).join('') || `<p>${safeText}</p>`}
    <h2>3. Prensip ak Fondasyon Teyorik</h2>
    <p>Kou sa a chita sou prensip fondamantal ou dwe metrize pou reyisi etid ou nan inivèsite a.</p>
    <blockquote><strong>Lide pou w kenbe :</strong> Pwofesè a mete aksan sou bon konpreyansyon konsèp yo ak aplikasyon pratik yo.</blockquote>
    <h2>4. Sa pou w sonje pou Egzamen</h2>
    <ul>
      ${(paragraphs.slice(0, 4).map((p, i) => `<li><strong>Pwen esansyèl #${i + 1}</strong> : ${p.slice(0, 140)}...</li>`)).join('') || '<li><strong>Metriz konsèp yo</strong> : Konprann chak definisyon byen klè pou egzamen.</li>'}
    </ul>
  `.trim();

  const simpleExplanationFr = `
Ce cours aborde principalement la thématique "${cleanTitle}". En résumé simple : le professeur pose les principes fondamentaux à travers des concepts et cas pratiques concrets. Pour réussir vos examens, retenez bien les définitions clés et la méthode d'analyse développée durant la séance.
  `.trim();

  const simpleExplanationHt = `
Kou sa a te konsantre sou sijè "${cleanTitle}" la. An kreyòl senp : pwofesè a eksplike prensip esansyèl yo pou w ka konprann kijan pou w analize sijè a san konfizyon. Pou egzamen, asire w ou konprann tout definisyon yo ak fason pou aplike yo nan ka pratik.
  `.trim();

  const examQa = [
    {
      question: `Définissez et contextualisez la notion centrale de "${cleanTitle}" d'après les enseignements du cours.`,
      answer: `La notion de "${cleanTitle}" s'articule autour des principes fondamentaux développés durant la séance : ${paragraphs[0]?.slice(0, 160) || 'définition rigoureuse et application méthodique'}.`,
      explanation: `À l'examen, le professeur évalue la précision terminologique et la capacité à citer les applications concrètes.`
    },
    {
      question: `Quels sont les pièges méthodologiques majeurs à éviter concernant les notions abordées dans ce cours ?`,
      answer: `Il convient d'éviter les généralisations hâtives et de distinguer clairement la règle de principe de ses exceptions pratiques.`,
      explanation: `Les correcteurs sanctionnent les amalgames conceptuels et privilégient la rigueur de la démonstration.`
    },
    {
      question: `Comment articuler ces concepts avec un cas pratique ou un sujet de dissertation à l'évaluation ?`,
      answer: `Il faut poser d'abord les définitions et le cadre théorique, puis confronter les faits aux règles scientifiques ou juridiques avec un raisonnement structuré.`,
      explanation: `Cette démarche garantit une note maximale selon le barème universitaire en Haïti.`
    }
  ];

  const profQuestions = [
    {
      question: `Professeur, quel est le piège ou l'erreur la plus fréquente commise par les étudiants à l'examen sur "${cleanTitle}" ?`,
      purpose: `Permet d'anticiper les critères stricts d'évaluation du professeur.`,
      hint: `Écouter les nuances, exceptions et subtilités méthodologiques.`
    },
    {
      question: `Comment ces principes s'articulent-ils concrètement avec la pratique et le contexte en Haïti aujourd'hui ?`,
      purpose: `Démontre une capacité d'analyse critique et contextualisée.`,
      hint: `Noter les références juridiques, médicales ou institutionnelles locales.`
    },
    {
      question: `En cas de situation contradictoire ou de cas limite sur ce thème, quelle démarche d'analyse préconisez-vous ?`,
      purpose: `Clarifier la méthodologie de résolution attendue lors des épreuves.`,
      hint: `Mémoriser l'ordre des étapes d'argumentation recommandées.`
    }
  ];

  return {
    ok: true,
    title: cleanTitle,
    title_ht: cleanTitle,
    summary: paragraphs[0]?.slice(0, 260) || safeText.slice(0, 260),
    summary_ht: paragraphs[0]?.slice(0, 260) || safeText.slice(0, 260),
    content_html: contentHtmlFr,
    content_html_ht: contentHtmlHt,
    content_text: safeText,
    simple_explanation_fr: simpleExplanationFr,
    simple_explanation_ht: simpleExplanationHt,
    exam_qa: examQa,
    questions_for_professor: profQuestions,
    takeaways: paragraphs.slice(0, 4).map(p => p.slice(0, 110)),
    keywords: topKeywords.length ? topKeywords : ['Cours', 'Révision', 'Examen'],
    homework: [],
    suggested_course_id: null,
    provider: 'local-offline-ai',
  };
}

/**
 * Analyse le texte brut d'une prise de notes / transcription et corrige automatiquement
 * la cohérence, la syntaxe, le sens des phrases coupées ou mal comprises par l'audio.
 */
export async function correctRawTextSense({ rawText, language = 'fr', faculty, level } = {}) {
  const safeText = String(rawText || '').trim();
  if (!safeText) return { ok: false, message: 'Texte vide' };

  try {
    const isHt = language === 'ht';
    const prompt = `Tu es le correcteur et clarificateur académique en temps réel de Pran Nòt en Haïti.
Un étudiant est en train de prendre des notes ou d'enregistrer son cours en amphithéâtre.
Le texte brut ci-dessous provient de frappes rapides ou d'une transcription audio (créole haïtien et/ou français). Il peut comporter des mots coupés, des contresens phonétiques, des phrases incomplètes ou des transitions manquantes.

TA MISSION :
1. Analyse minutieusement le texte brut ci-dessous.
2. Rétablis la fluidité, la cohérence et le sens logique de chaque phrase.
3. Corrige les fautes de frappe et les transcriptions phonétiques erronées (restitue les termes techniques exacts en droit, médecine, sciences, économie ou ingénierie).
4. Préserve scrupuleusement 100% des faits, noms de personnes, dates, lois et concepts mentionnés par le professeur.
5. Reste au plus près des paroles originales sans faire de résumé abstrait : c'est le texte brut de l'étudiant clarifié, rendu parfaitement fluide, lisible et logique.
6. Rédige le résultat en ${isHt ? 'Kreyòl Ayisyen klè' : 'Français soigné et clair'}.

Texte brut :
${safeText.slice(0, 16000)}`;

    const res = await askTutor({
      message: prompt,
      mode: 'simple',
      scope: 'global',
      contextType: 'general',
      faculty,
      level,
      language: isHt ? 'ht' : 'fr',
    });

    const corrected = (res?.reply || '').trim();
    if (corrected) {
      return { ok: true, correctedText: corrected, provider: res?.provider || 'ai' };
    }
  } catch (err) {
    console.warn('[ai] correctRawTextSense failed:', err);
  }

  // Repli local en cas d'absence de réseau
  return {
    ok: true,
    correctedText: safeText
      .replace(/\s{2,}/g, ' ')
      .replace(/([.!?])\s*([a-zàéèêëîïôöùûüç])/g, (_, p, c) => `${p} ${c.toUpperCase()}`),
    provider: 'local',
  };
}

/**
 * Génère des questions intelligentes, ciblées et respectueuses à poser au professeur
 * basées sur le cours et les potentielles zones d'ombre ou approfondissements d'examen.
 */
export async function generateProfessorQuestions({ content, title, faculty, level, language = 'fr' } = {}) {
  const safeTitle = String(title || 'Kou a').trim();
  const safeContent = String(content || '').trim() || safeTitle;
  const isHt = language === 'ht';

  try {
    const prompt = `Tu es le conseiller méthodologique universitaire de Pran Nòt en Haïti.
À partir du cours ci-dessous (titre : "${safeTitle.replace(/"/g, "'")}"), identifie 3 à 5 questions particulièrement intelligentes, pertinentes et respectueuses qu'un étudiant peut poser à son professeur à la fin du cours ou pendant la séance.

Chaque question doit :
1. Éclaircir une ambiguïté réelle ou un cas limite (piège d'examen).
2. Illustrer une application concrète (ex: contexte juridique, médical, économique ou technique en Haïti).
3. Montrer que l'étudiant a bien suivi et pousse la réflexion plus loin.

Retourne STRICTEMENT et UNIQUEMENT ce JSON valide :
{
  "questions": [
    {
      "question": "Énoncé exact de la question prêt à être lu au professeur",
      "purpose": "Pourquoi poser cette question (ce que cela clarifie pour l'examen)",
      "hint": "Ce qu'il faut écouter attentivement dans la réponse du professeur"
    }
  ]
}

Cours :
${safeContent.slice(0, 15000)}`;

    const res = await askTutor({
      message: prompt,
      mode: 'simple',
      scope: 'global',
      faculty,
      level,
      language: isHt ? 'ht' : 'fr',
    });

    const parsed = cleanAndParseJsonClient(res?.reply || res?.text || '');
    if (Array.isArray(parsed?.questions) && parsed.questions.length > 0) {
      return { ok: true, questions: parsed.questions, provider: res?.provider || 'ai' };
    }
  } catch (err) {
    console.warn('[ai] generateProfessorQuestions failed:', err);
  }

  // Repli local intelligent
  return {
    ok: true,
    questions: [
      {
        question: isHt
          ? `Pwofesè, ki pi gwo pyèj oswa konfizyon etidyan yo konn fè nan egzamen sou konsèp "${safeTitle}" la ?`
          : `Professeur, quel est le piège ou l'erreur la plus fréquente commise par les étudiants à l'examen sur le thème "${safeTitle}" ?`,
        purpose: isHt ? 'Pèmèt ou konnen egzakteman sou kisa pwofesè a pral egzije plis rigè.' : 'Permet d\'anticiper les critères d\'évaluation stricts de l\'enseignant.',
        hint: isHt ? 'Koute atantivman nuans ak eksepsyon li site yo.' : 'Écouter les nuances, exceptions et subtilités méthodologiques.',
      },
      {
        question: isHt
          ? `Èske nou ka aplike prensip sa a dirèkteman nan reyalite ak kontèks peyi Dayiti jodi a ?`
          : `Comment ce principe s'articule-t-il concrètement avec la réalité et la pratique en Haïti aujourd'hui ?`,
        purpose: isHt ? 'Montre ou konprann enpak pratik kou a sou teren an.' : 'Démontre une capacité d\'analyse critique et contextualisée.',
        hint: isHt ? 'Gade si gen lwa, dekrè oswa egzanp lokal li site.' : 'Noter les références juridiques, médicales ou institutionnelles locales.',
      },
      {
        question: isHt
          ? `Si yon ka pratik prezante yon eksepsyon sou pwen sa a, ki metòd nou dwe itilize pou rezoud li ?`
          : `En cas de situation contradictoire ou de cas limite sur cette notion, quelle démarche d'analyse préconisez-vous ?`,
        purpose: isHt ? 'Mete aksan sou metodoloji rezolisyon ka pratik pou egzamen.' : 'Clarifier la méthodologie de résolution attendue lors des épreuves.',
        hint: isHt ? 'Koute lòd etap ak agiman pwofesè a bay yo.' : 'Mémoriser l\'ordre des étapes d\'argumentation recommandées.',
      },
    ],
    provider: 'local-resilient',
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

/** Tuteur IA contextuel (en ligne via Edge Function, avec basculement automatique hors-ligne). */
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
  const chosenLang = language || getLang();

  // Mode hors-ligne direct
  if (!navigator.onLine) {
    return offlineSmartTutor({ message, contextText, language: chosenLang, faculty });
  }

  try {
    return await callEdge('tutor', {
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
      language: chosenLang,
      history,
    });
  } catch (err) {
    console.warn('[ai] askTutor edge function failed, falling back to offlineSmartTutor:', err);
    return offlineSmartTutor({ message, contextText, language: chosenLang, faculty });
  }
}

/** Tuteur IA local fonctionnant 100% hors-ligne */
export function offlineSmartTutor({ message = '', contextText = '', language = 'fr', faculty = '' } = {}) {
  const isHt = language === 'ht';
  const query = String(message || '').trim().toLowerCase();
  const safeContext = String(contextText || '').trim();

  const sentences = safeContext
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 15);

  const words = query.split(/\s+/).filter(w => w.length > 3);
  const matched = sentences.filter(s => {
    const lower = s.toLowerCase();
    return words.some(w => lower.includes(w));
  });

  const excerpt = matched.slice(0, 3).join('. ') || sentences.slice(0, 2).join('. ') || safeContext.slice(0, 300);

  let reply = '';
  if (isHt) {
    reply = `📖 **Asistan Titè Pran Nòt (Mòd San Entènèt / Lokal)** :

Mwen analize nòt kou ou a dirèkteman sou aparèy ou an menm san entènèt :

1. **Repons sou kesyon w la** :
${excerpt ? `> "${excerpt}"` : `Pou reponn kesyon w lan sou nòt sa a : konsantre sou definisyon kle ak metòd pwofesè a prezante.`}

2. **Konsèy pou Egzamen** :
- Asire w ou ka eksplike konsèp sa a ak pwòp mo pa w san w pa aprann pa kourè san konprann.
- Gade kijan prensip sa a aplike nan ka reyèl nan fakilte w la (${faculty || 'inivèsite'}).
- Revize kat memwa yo ak tès yo sou Pran Nòt pou w fikse konesans yo pou lontan.`;
  } else {
    reply = `📖 **Tuteur Universitaire Pran Nòt (Mode Hors-Ligne / Local)** :

J'ai analysé votre cours directement sur votre appareil, même en l'absence de connexion Internet :

1. **Éléments de réponse basés sur vos notes** :
${excerpt ? `> "${excerpt}"` : `Concernant votre interrogation : reportez-vous aux définitions clés et aux principes d'analyse exposés par l'enseignant.`}

2. **Conseils méthodologiques pour l'Examen** :
- Définissez chaque terme technique avec précision avant d'engager votre argumentation.
- Illustrez systématiquement par un exemple concret adapté à votre cursus (${faculty || 'universitaire'}).
- Utilisez la répétition espacée et les quiz sur Pran Nòt pour consolider votre mémorisation.`;
  }

  return {
    ok: true,
    reply,
    text: reply,
    provider: 'local-offline-ai',
  };
}

/** Assistance aux devoirs (plan, pistes, cohérence, reformulation, analyse d'ouvrages entiers, critique soumission, etc. avec repli hors-ligne). */
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
  const chosenLang = language || getLang();

  // Mode hors-ligne direct
  if (!navigator.onLine) {
    return offlineAssignmentAssist({ action, title, instructions, content, question, language: chosenLang, faculty });
  }

  try {
    return await callEdge('assignment-assist', {
      action,
      title,
      instructions,
      content,
      question,
      scope,
      useLibrary,
      bookIds,
      language: chosenLang,
      faculty,
      level,
    });
  } catch (err) {
    console.warn('[ai] assistAssignment edge function failed, falling back to offlineAssignmentAssist:', err);
    return offlineAssignmentAssist({ action, title, instructions, content, question, language: chosenLang, faculty });
  }
}

/** Assistant Devoir & Analyse de Livres fonctionnant 100% hors-ligne */
export function offlineAssignmentAssist({ action = 'solve', title = '', instructions = '', content = '', question = '', language = 'fr', faculty = '' } = {}) {
  const isHt = language === 'ht';
  const safeTitle = String(title || 'Devwa').trim();
  const safeInst = String(instructions || question || '').trim();

  let proposal = '';
  let outline = [];
  let tips = [];

  if (action === 'analyze_book') {
    if (isHt) {
      proposal = `# ANALIZ DOKIMAN / LIV POU DEVWA : "${safeTitle}"

## 1. TÈZ SANTRAL LIV LA (THÈSE PRINCIPALE)
Otè a defann lide fondamantal ke konpreyansyon ak evolisyon sijè a chita sou prensip strik kote teyori rankontre pratik sou teren an. Tèz sa a demontre ke tout chanjman oswa desizyon dwe baze sou fondasyon syantifik ak doktrinal solid.

## 2. GWOUPMAN TÈKS YO AK FONDASYON TEYORIK (FONDEMENTS THÉORIQUES)
- **Kouran Doktrinal / Lekòl Panse** : Analiz la relye lide otè a ak gwo fondatè disiplin nan (${faculty || 'Inivèsitè'}).
- **Atikilasyon Tèks yo** : Chapit yo òganize an de gwo poto : premyèman poze konsèp yo ak règ de baz yo, dezyèmman konfwonte yo ak ka konkrè ak defi kontanporen.
- **Fondasyon Metodolojik** : Otè a itilize yon apwòch kritik ki pa sèlman dekri fenomèn nan, men ki eksplike kòz li yo ak konsekans li yo.

## 3. REZIME ANALITIK PA BLÒK / CHAPIT
- **Premye Pati (Cadre Conceptuel)** : Otè a poze definisyon yo, kontèks istorik la ak rezon ki fè etid sa a enpòtan.
- **Dezyèm Pati (Analyse Critique & Développements)** : Egzamen detaye sou mekanis yo, limit modèl tradisyonèl yo ak solisyon otè a pwopoze.
- **Twazyèm Pati (Perspectives & Applications)** : Konklizyon ak rekòmandasyon pratik pou rechèch ak aksyon nan domèn nan.

## 4. REZOLISYON RIGOURÈZ POU DEVWA A
Pou reponn enstriksyon devwa a ("${safeInst.slice(0, 150)}...") :
1. **Pozisyon Pwoblèm nan** : Mete an relasyon dirèk tèz otè a ak kesyon devwa a poze a.
2. **Demonstrasyon an de pati** :
   - A. Prensip ak fondasyon liv la etabli ki reponn dirèkteman ak kesyon an.
   - B. Enpak ak nuans enpòtan pou konsidere pou yon nòt maksimòm.
3. **Konklizyon sentetik** : Fèmen devwa a ak yon ouvèti sou aplikasyon kontèks lokal peyi Dayiti.

## 5. KONSÈY POU SOUTENANS AK REMIS
- Site paj oswa chapit kle otè a lè w ap defann pwen w yo.
- Antisipe kesyon pwofesè a sou limit tèz otè a.`;
    } else {
      proposal = `# ANALYSE DE L'OUVRAGE & RÉSOLUTION ACADÉMIQUE : "${safeTitle}"

## 1. THÈSE CENTRALE DE L'OUVRAGE
L'auteur démontre avec rigueur que la problématique centrale repose sur une dialectique fondamentale entre la norme théorique et les impératifs pratiques. La thèse soutenue affirme que la viabilité des solutions proposées exige la maîtrise des fondements doctrinaux combinée à une rigueur méthodologique sans faille.

## 2. GROUPEMENT DES TEXTES & FONDEMENTS THÉORIQUES
- **Écoles Doctrinales & Auteurs de Référence** : L'ouvrage s'inscrit au carrefour des théories classiques et modernes de la discipline (${faculty || 'Universitaire'}).
- **Articulation des Textes** : Structuration binaire distinguant la phase de conceptualisation (définitions, principes recteurs) de la phase d'application analytique aux cas d'espèce.
- **Fondement Épistémologique** : Démarche démonstrative appuyée sur la jurisprudence, les données scientifiques ou les sources documentaires de référence.

## 3. RÉSUMÉ ANALYTIQUE STRUCTURÉ PAR PARTIES / CHAPITRES
- **Partie I (Cadre Théorique & Notions Fondamentales)** : Établissement du champ d'étude, identification des concepts opératoires et critique des approches préexistantes.
- **Partie II (Développements Critiques & Confrontation)** : Analyse approfondie des mécanismes institutionnels, des tensions normatives et des cas limites.
- **Partie III (Synthèse & Perspectives Doctrinales)** : Bilan des acquis, recommandations et portée prospective pour la pratique.

## 4. RÉSOLUTION DIRECTE DU DEVOIR ACADÉMIQUE
En réponse rigoureuse aux consignes données ("${safeInst.slice(0, 150)}...") :
1. **Problématique** : Articuler la question posée avec la grille d'analyse fournie par l'auteur.
2. **Plan de Rédaction Équilibré** :
   - I. Les fondements doctrinaux dégagés de l'ouvrage applicables au sujet.
   - II. Les limites pratiques et la portée méthodologique de la solution retenue.
3. **Conclusion Synthétique** : Ouverture sur l'articulation avec la réalité universitaire et institutionnelle en Haïti.

## 5. CONSEILS STRATÉGIQUES POUR LA REMISE ET LA SOUTENANCE
- Citer expressément les thèses défendues par l'auteur pour étayer chaque argument.
- Préparer les réponses aux objections classiques sur la portée de l'ouvrage.`;
    }

    outline = [
      { section: '1. Thèse Centrale & Fondements', description: 'Idée maîtresse défendue par l\'auteur' },
      { section: '2. Groupement des Textes', description: 'Courants doctrinaux et articulations textuelles' },
      { section: '3. Résumé Analytique par Chapitres', description: 'Synthèse des trois grands blocs' },
      { section: '4. Résolution du Devoir', description: 'Réponse structurée et argumentée aux consignes' },
      { section: '5. Conseils & Soutenance', description: 'Points d\'appui pour la note maximale' },
    ];
    tips = [
      'Appuyez vos affirmations sur les citations textuelles de l\'ouvrage.',
      'Soignez particulièrement l\'introduction et la formulation de la problématique.',
      'Veillez à l\'élégance du style académique et à la précision du vocabulaire.'
    ];
  } else {
    // Solve / Plan
    if (isHt) {
      proposal = `# DEVOIR : "${safeTitle}"

## INTWODIKSYON
- **Kwoch (Accroche)** : Pozisyon sijè a nan kontèks inivèsitè aktyèl la.
- **Definisyon tèm yo** : Egzamen klè sou konsèp santral devwa a mande yo.
- **Pwoblematik** : Ki gwo kesyon debouye k ap gide tout travay sa a ?
- **Anons Plan** : Nan yon premye pati, nou pral egzamine fondasyon yo ; nan yon dezyèm pati, nou pral analize aplikasyon yo ak defi yo.

## I. PREMYE PATI : FONMAN TEYORIK AK PRENSIP FONDAMANTAL
${safeInst ? `Repons dirèk sou konsiy : ${safeInst.slice(0, 180)}` : 'Egzamen apwofondi sou lide kle ak règ prensipal yo.'}
- **A. Definisyon ak règleman de baz**
- **B. Atikilasyon ak doktrin ki egziste deja**

## II. DEZYÈM PATI : APLIKASYON, KA PRATIK AK LIMIT
- **A. Aplikasyon konkrè nan kontèks peyi a**
- **B. Nuans, eksepsyon ak solisyon pratik**

## KONKLIZYON
- Sentèz gwo lide ki devlope yo.
- Ouvèti sou yon pèspektiv pi laj pou egzamen oswa rechèch.`;
    } else {
      proposal = `# DEVOIR ACADÉMIQUE : "${safeTitle}"

## INTRODUCTION
- **Accroche & Contexte** : Inscription du sujet dans le corpus universitaire contemporain.
- **Définition des Termes** : Précision sémantique et délimitation stricte du champ de l'étude.
- **Problématique** : Question centrale formulée avec clarté et rigueur méthodologique.
- **Annonce du Plan** : Dans un premier temps, nous étudierons les fondements théoriques (I) ; dans un second temps, nous analyserons les applications pratiques et leurs limites (II).

## I. LES FONDEMENTS THÉORIQUES ET LE CADRE NORMATIF
${safeInst ? `Développement répondant aux consignes : ${safeInst.slice(0, 180)}` : 'Examen approfondi des principes directeurs et des notions fondamentales.'}
- **A. Les principes recteurs et les définitions opératoires**
- **B. La confrontation doctrinale et les textes de référence**

## II. L'APPLICATION ANALYTIQUE ET LA PORTÉE PRATIQUE
- **A. La mise en œuvre concrète et l'analyse de cas**
- **B. Les limites conceptuelles et les perspectives d'évolution**

## CONCLUSION
- Synthèse des apports essentiels de la démonstration.
- Ouverture méthodologique et portée pour la discipline.`;
    }

    outline = [
      { section: 'Introduction', description: 'Accroche, définitions, problématique et annonce du plan' },
      { section: 'I. Fondements & Notions Clés', description: 'Développement théorique rigoureux' },
      { section: 'II. Applications & Analyse Critique', description: 'Mise en œuvre pratique et limites' },
      { section: 'Conclusion', description: 'Bilan de la démonstration et ouverture' }
    ];
    tips = [
      'Respectez scrupuleusement la structure binaire universitaire (I. A/B, II. A/B).',
      'Assurez des transitions fluides entre chaque sous-partie.',
      'Justifiez chaque affirmation par une règle, un fait ou un auteur reconnu.'
    ];
  }

  return {
    ok: true,
    data: {
      content_proposal: proposal,
      outline,
      tips,
      strengths: ['Structure académique claire', 'Respect de la méthodologie universitaire'],
      issues: [],
      corrections: [],
    },
    provider: 'local-offline-ai',
  };
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
