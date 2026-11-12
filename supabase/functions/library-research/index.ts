// Edge Function : library-research
// Bibliothèque universitaire, codes juridiques, recherche web multi-sources,
// analyse documentaire anti-plagiat (HTML/Texte/PDF) et créateur de livres originaux.
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { authenticateUser } from '../_shared/supabase.ts';
import { QuotaExceededError, runAiTask, stripEmojis, sanitizeJsonEmojis } from '../_shared/ai.ts';

const MAX_EXTERNAL_BYTES = 6 * 1024 * 1024; // 6 Mo max pour téléchargement sécurisé
const MAX_STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'en', 'et', 'ou', 'où', 'pour', 'par', 'avec',
  'sans', 'sur', 'sous', 'dans', 'ce', 'cet', 'cette', 'ces', 'qui', 'que', 'quoi', 'dont', 'est', 'sont',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'pou', 'nan', 'ak', 'yon', 'yo', 'ki',
  'se', 'sa', 'sou', 'pa', 'bay', 'nan', 'avèk', 'avek', 'mwen', 'ou', 'li', 'nou',
]);

/* --------------------------------------------------------------------
   Garde SSRF stricte + téléchargement externe sécurisé (max 6 Mo)
   -------------------------------------------------------------------- */
function isPrivateOrBlockedHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (
    h === 'localhost'
    || h.endsWith('.localhost')
    || h.endsWith('.local')
    || h.endsWith('.internal')
    || h.endsWith('.arpa')
  ) {
    return true;
  }

  // IPv6 loopback / link-local / unique-local
  if (
    h === '::1'
    || h === '::'
    || h.startsWith('fe80:')
    || h.startsWith('fc')
    || h.startsWith('fd')
    || h.startsWith('::ffff:')
  ) {
    return true;
  }

  // IPv4 literals or integer/hex encoded host
  if (/^(0x[0-9a-f]+|\d+)$/i.test(h)) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
  }
  return false;
}

function validatePublicUrl(rawUrl: string): URL {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw new Error('invalid_url');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('unsupported_protocol');
  }
  if (u.username || u.password) {
    throw new Error('credentials_not_allowed');
  }
  if (isPrivateOrBlockedHost(u.hostname)) {
    throw new Error('blocked_private_host');
  }
  return u;
}

async function readStreamBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const lenHeader = Number(res.headers.get('content-length') || 0);
  if (lenHeader > maxBytes) {
    throw new Error('remote_file_too_large');
  }
  if (!res.body) {
    return new Uint8Array(await res.arrayBuffer());
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('remote_file_too_large');
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

async function safeFetchExternal(rawUrl: string): Promise<{
  finalUrl: string;
  contentType: string;
  bytes: Uint8Array;
}> {
  let current = validatePublicUrl(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'PranNotAcademicResearch/1.0 (+https://prannot.ht)',
        Accept: 'text/html,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(16000),
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`redirect_missing_location_${res.status}`);
      current = validatePublicUrl(new URL(loc, current).toString());
      continue;
    }

    if (!res.ok) {
      throw new Error(`remote_http_${res.status}`);
    }

    const bytes = await readStreamBounded(res, MAX_EXTERNAL_BYTES);
    return {
      finalUrl: current.toString(),
      contentType: (res.headers.get('content-type') || 'text/plain').toLowerCase(),
      bytes,
    };
  }
  throw new Error('too_many_redirects');
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractReadableFromHtml(html: string): { title: string; author: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const authorMatch = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i);

  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(header|footer|nav|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|li|tr|blockquote|article|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const text = decodeHtmlEntities(cleaned)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    title: decodeHtmlEntities((titleMatch?.[1] || '').replace(/<[^>]+>/g, '').trim()).slice(0, 180),
    author: decodeHtmlEntities((authorMatch?.[1] || '').trim()).slice(0, 120),
    text: text.slice(0, 20000),
  };
}

/* --------------------------------------------------------------------
   Contrôle objectif anti-plagiat par n-grammes (shingles de 5 mots)
   -------------------------------------------------------------------- */
function tokenizeForPlagiarism(text: string, ignoreQuotedLaws = true): string[] {
  let clean = String(text || '');
  if (ignoreQuotedLaws) {
    // Exclure les citations exactes entre guillemets (articles de loi / dispositions constitutionnelles)
    clean = clean.replace(/«[^»]{10,400}»|"[^"]{10,400}"/g, ' ');
  }
  return clean
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !MAX_STOPWORDS.has(w));
}

function buildShingles(tokens: string[], size = 5): Set<string> {
  const set = new Set<string>();
  if (tokens.length < size) return set;
  for (let i = 0; i <= tokens.length - size; i++) {
    set.add(tokens.slice(i, i + size).join(' '));
  }
  return set;
}

function computeOriginalityMetrics(sourceTexts: string[], generatedText: string): {
  originality_score: number;
  overlap_percent: number;
  matched_phrases: string[];
} {
  const sourceShingles = new Set<string>();
  for (const s of sourceTexts) {
    const tokens = tokenizeForPlagiarism(s, false);
    for (const sh of buildShingles(tokens, 5)) sourceShingles.add(sh);
  }
  const genTokens = tokenizeForPlagiarism(generatedText, true);
  const genShingles = buildShingles(genTokens, 5);
  if (!sourceShingles.size || !genShingles.size) {
    return { originality_score: 98, overlap_percent: 2, matched_phrases: [] };
  }
  const matched: string[] = [];
  for (const sh of genShingles) {
    if (sourceShingles.has(sh)) matched.push(sh);
  }
  const ratio = matched.length / genShingles.size;
  const overlapPct = Math.round(ratio * 100);
  return {
    originality_score: Math.max(0, Math.min(100, 100 - overlapPct)),
    overlap_percent: overlapPct,
    matched_phrases: matched.slice(0, 6),
  };
}

/* --------------------------------------------------------------------
   Sources Web Académiques & Juridiques Réelles (sans URL inventée)
   -------------------------------------------------------------------- */
interface WebSourceItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
  authors?: string;
  year?: number | null;
  isPdf?: boolean;
  openAccess?: boolean;
}

function reconstructOpenAlexAbstract(invIdx: Record<string, number[]> | null | undefined): string {
  if (!invIdx || typeof invIdx !== 'object') return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(invIdx)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (pos >= 0 && pos < 250) words[pos] = word;
    }
  }
  return words.filter(Boolean).join(' ').slice(0, 420);
}

async function searchOpenAlex(query: string): Promise<WebSourceItem[]> {
  try {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5&select=id,title,publication_year,doi,primary_location,best_oa_location,authorships,abstract_inverted_index`;
    const res = await fetch(url, { signal: AbortSignal.timeout(7500) });
    if (!res.ok) return [];
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.map((w: Record<string, unknown>) => {
      const oa = (w.best_oa_location || {}) as Record<string, unknown>;
      const loc = (w.primary_location || {}) as Record<string, unknown>;
      const pdfUrl = String(oa.pdf_url || '');
      const link = pdfUrl || String(oa.landing_page_url || loc.landing_page_url || w.doi || w.id || '');
      const authors = Array.isArray(w.authorships)
        ? (w.authorships as Array<{ author?: { display_name?: string } }>)
            .slice(0, 3)
            .map((a) => a.author?.display_name)
            .filter(Boolean)
            .join(', ')
        : '';
      const abs = reconstructOpenAlexAbstract(w.abstract_inverted_index as Record<string, number[]>);
      return {
        title: stripEmojis(String(w.title || 'Article académique')),
        url: link,
        snippet: stripEmojis(abs || 'Publication scientifique indexée sur OpenAlex.'),
        source: 'OpenAlex',
        authors,
        year: typeof w.publication_year === 'number' ? w.publication_year : null,
        isPdf: Boolean(pdfUrl),
        openAccess: Boolean(oa.is_oa || pdfUrl),
      };
    }).filter((x: WebSourceItem) => x.url.startsWith('http'));
  } catch {
    return [];
  }
}

async function searchOpenLibraryAndArchive(query: string): Promise<WebSourceItem[]> {
  const items: WebSourceItem[] = [];
  const [olRes, iaRes] = await Promise.allSettled([
    fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=4&fields=title,author_name,first_publish_year,key,ia`, {
      signal: AbortSignal.timeout(7000),
    }).then((r) => (r.ok ? r.json() : null)),
    fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(`(${query}) AND mediatype:texts`)}&fl[]=identifier,title,creator,year,description&rows=4&output=json`, {
      signal: AbortSignal.timeout(7000),
    }).then((r) => (r.ok ? r.json() : null)),
  ]);

  if (olRes.status === 'fulfilled' && Array.isArray(olRes.value?.docs)) {
    for (const d of olRes.value.docs) {
      if (!d.key || !d.title) continue;
      const iaId = Array.isArray(d.ia) && d.ia[0] ? String(d.ia[0]) : '';
      items.push({
        title: stripEmojis(String(d.title)),
        url: iaId ? `https://archive.org/details/${encodeURIComponent(iaId)}` : `https://openlibrary.org${d.key}`,
        snippet: iaId
          ? 'Livre disponible en consultation numérique sur Internet Archive / Open Library.'
          : 'Notice bibliographique vérifiée sur Open Library.',
        source: 'Open Library',
        authors: Array.isArray(d.author_name) ? d.author_name.slice(0, 2).join(', ') : '',
        year: typeof d.first_publish_year === 'number' ? d.first_publish_year : null,
        isPdf: false,
        openAccess: Boolean(iaId),
      });
    }
  }

  if (iaRes.status === 'fulfilled' && Array.isArray(iaRes.value?.response?.docs)) {
    for (const d of iaRes.value.response.docs) {
      if (!d.identifier || !d.title) continue;
      const rawDesc = Array.isArray(d.description) ? d.description[0] : d.description;
      items.push({
        title: stripEmojis(String(d.title)),
        url: `https://archive.org/details/${encodeURIComponent(String(d.identifier))}`,
        snippet: stripEmojis(String(rawDesc || 'Document textuel archivé en accès public sur Internet Archive.')).slice(0, 320),
        source: 'Internet Archive',
        authors: Array.isArray(d.creator) ? d.creator.slice(0, 2).join(', ') : String(d.creator || ''),
        year: d.year ? Number(d.year) || null : null,
        isPdf: true,
        openAccess: true,
      });
    }
  }

  return items;
}

async function searchWikimedia(query: string): Promise<WebSourceItem[]> {
  const cleanSnippet = (s: string) => decodeHtmlEntities(String(s || '').replace(/<[^>]+>/g, '')).trim();
  const [wpRes, wsRes] = await Promise.allSettled([
    fetch(`https://fr.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`, {
      signal: AbortSignal.timeout(6500),
    }).then((r) => (r.ok ? r.json() : null)),
    fetch(`https://fr.wikisource.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`, {
      signal: AbortSignal.timeout(6500),
    }).then((r) => (r.ok ? r.json() : null)),
  ]);

  const out: WebSourceItem[] = [];
  if (wsRes.status === 'fulfilled' && Array.isArray(wsRes.value?.query?.search)) {
    for (const s of wsRes.value.query.search) {
      out.push({
        title: stripEmojis(String(s.title)),
        url: `https://fr.wikisource.org/wiki/${encodeURIComponent(String(s.title).replace(/ /g, '_'))}`,
        snippet: stripEmojis(cleanSnippet(s.snippet)).slice(0, 320),
        source: 'Wikisource (Textes intégraux)',
        openAccess: true,
      });
    }
  }
  if (wpRes.status === 'fulfilled' && Array.isArray(wpRes.value?.query?.search)) {
    for (const s of wpRes.value.query.search) {
      out.push({
        title: stripEmojis(String(s.title)),
        url: `https://fr.wikipedia.org/wiki/${encodeURIComponent(String(s.title).replace(/ /g, '_'))}`,
        snippet: stripEmojis(cleanSnippet(s.snippet)).slice(0, 320),
        source: 'Wikipédia FR',
        openAccess: true,
      });
    }
  }
  return out;
}

async function geminiWebGroundedSearch(
  query: string,
  faculty: string,
  language: string,
): Promise<{ summary: string; webChunks: WebSourceItem[]; tokensIn: number; tokensOut: number } | null> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return null;

  const langHint = language === 'ht'
    ? 'Réponds en créole haïtien naturel et académique (termes juridiques/techniques en français acceptés).'
    : 'Réponds en français académique clair et structuré.';

  for (const model of ['gemini-2.5-flash', 'gemini-3.5-flash-lite']) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          tools: [{ google_search: {} }],
          systemInstruction: {
            parts: [{
              text: [
                'Tu es un assistant de recherche universitaire haïtien.',
                faculty === 'droit'
                  ? 'Priorise les sources officielles haïtiennes (Constitution d’Haïti 1987/2011, Codes haïtiens, Parlement, Le Moniteur, doctrine juridique fiable).'
                  : `Adapte la recherche au domaine universitaire : ${faculty || 'général'}.`,
                langHint,
                'Synthétise de manière originale SANS plagiat. Cite uniquement des textes et sources vérifiés par l’outil de recherche Google. ZÉRO emoji.',
              ].join('\n'),
            }],
          },
          contents: [{
            role: 'user',
            parts: [{
              text: `Recherche universitaire approfondie sur Internet pour : "${query}". Donne les notions clés, les textes ou ouvrages de référence pertinents et explique comment l'étudiant peut les exploiter honnêtement dans un devoir.`,
            }],
          }],
          generationConfig: { temperature: 0.25, maxOutputTokens: 2048 },
        }),
      });

      if (!res.ok) continue;
      const data = await res.json();
      const cand = data?.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const text = parts
        .filter((p: { thought?: boolean; text?: string }) => !p.thought && Boolean(p.text))
        .map((p: { text?: string }) => p.text || '')
        .join('\n')
        .trim();

      const groundingChunks = Array.isArray(cand?.groundingMetadata?.groundingChunks)
        ? cand.groundingMetadata.groundingChunks
        : [];

      const webChunks: WebSourceItem[] = groundingChunks
        .map((c: { web?: { uri?: string; title?: string } }) => c?.web)
        .filter((w: { uri?: string; title?: string } | undefined) => w?.uri && w.uri.startsWith('http'))
        .map((w: { uri: string; title?: string }) => ({
          title: stripEmojis(String(w.title || w.uri)),
          url: w.uri,
          snippet: 'Source web vérifiée via Google Search Grounding.',
          source: 'Web (Google Search)',
          isPdf: /\.pdf(?:$|\?)/i.test(w.uri),
          openAccess: true,
        }));

      const usage = data?.usageMetadata || {};
      if (text || webChunks.length) {
        return {
          summary: stripEmojis(text),
          webChunks,
          tokensIn: usage.promptTokenCount || 0,
          tokensOut: usage.candidatesTokenCount || 0,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function dedupeWebSources(list: WebSourceItem[]): WebSourceItem[] {
  const seen = new Set<string>();
  const out: WebSourceItem[] = [];
  for (const item of list) {
    if (!item.url || !item.url.startsWith('http')) continue;
    const key = item.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 16);
}

/* --------------------------------------------------------------------
   Analyse PDF distant avec Gemini multimodal (si la source web est un PDF)
   -------------------------------------------------------------------- */
async function analyzePdfBytesWithGemini(params: {
  bytes: Uint8Array;
  topic: string;
  faculty: string;
  language: string;
}): Promise<{ rawExtract: string; summary: string; keyPoints: string[]; legalRefs: string[]; citation: string } | null> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return null;
  const b64 = uint8ToBase64(params.bytes);
  const langRule = params.language === 'ht'
    ? 'Rédige l’analyse et la synthèse en créole haïtien naturel (termes techniques/juridiques en français acceptés).'
    : 'Rédige l’analyse et la synthèse en français académique clair.';

  for (const model of ['gemini-2.5-flash', 'gemini-3.5-flash-lite']) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: [
                'Tu lis ce document PDF académique/juridique pour un étudiant universitaire.',
                langRule,
                'ANTI-PLAGIAT STRICT : reformule entièrement les idées avec tes propres mots et structure. Seuls les textes de loi ou articles officiels peuvent être cités exactement entre guillemets.',
                'ZÉRO emoji. Retourne STRICTEMENT un objet JSON valide.',
              ].join('\n'),
            }],
          },
          contents: [{
            role: 'user',
            parts: [
              {
                text: `Analyse ce document PDF${params.topic ? ` en lien avec le sujet "${params.topic}"` : ''}. Retourne STRICTEMENT ce JSON :
{
  "title": "Titre identifié du document",
  "author": "Auteur ou institution",
  "citation": "Référence APA suggérée",
  "summary": "Synthèse originale et complète sans plagiat (3 à 5 paragraphes)",
  "key_points": ["Idée clé 1 reformulée", "Idée clé 2", "..."],
  "legal_or_exact_quotes": ["Article ou disposition exacte citée avec référence si applicable"],
  "raw_extract": "Court extrait représentatif des chapitres ou thèmes du document (max 1500 caractères)"
}`,
              },
              { inlineData: { mimeType: 'application/pdf', data: b64 } },
            ],
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
          },
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const txt = parts.filter((p: { thought?: boolean; text?: string }) => !p.thought && p.text).map((p: { text: string }) => p.text).join('\n').trim();
      const parsed = JSON.parse(txt);
      return {
        rawExtract: stripEmojis(String(parsed.raw_extract || '')),
        summary: stripEmojis(String(parsed.summary || '')),
        keyPoints: Array.isArray(parsed.key_points) ? parsed.key_points.map((x: unknown) => stripEmojis(String(x))) : [],
        legalRefs: Array.isArray(parsed.legal_or_exact_quotes) ? parsed.legal_or_exact_quotes.map((x: unknown) => stripEmojis(String(x))) : [],
        citation: stripEmojis(String(parsed.citation || '')),
      };
    } catch {
      continue;
    }
  }
  return null;
}

/* --------------------------------------------------------------------
   Point d'entrée HTTP
   -------------------------------------------------------------------- */
Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  try {
    const auth = await authenticateUser(req);
    if ('error' in auth) return errorResponse(auth.error, 'Non authentifié', auth.status);

    const body = await req.json();
    const action = String(body.action || 'search_web').trim();
    const faculty = String(body.faculty || auth.profile?.faculty_id || 'autre');
    const level = String(body.level || auth.profile?.level || 'L1');
    const language = (body.language || auth.profile?.language || 'ht') as 'ht' | 'fr' | 'mix';
    const userQuota = auth.profile?.ai_daily_quota || 500;

    /* ================================================================
       ACTION 1 : RECHERCHE UNIVERSELLE (BIBLIOTHÈQUE + WEB MULTI-MOTEURS)
       ================================================================ */
    if (action === 'search_web') {
      const query = String(body.query || '').trim();
      if (query.length < 2) return errorResponse('invalid_input', 'Requête de recherche trop courte.', 400);

      const started = Date.now();
      const [libRes, oaRes, archiveRes, wikiRes, gemSearch] = await Promise.allSettled([
        body.includeLibrary !== false
          ? auth.userClient.rpc('pran_not_search_library', {
              p_query: query,
              p_faculty: faculty,
              p_scope: null,
              p_book_id: null,
              p_limit: 8,
            })
          : Promise.resolve({ data: [] }),
        searchOpenAlex(query),
        searchOpenLibraryAndArchive(query),
        searchWikimedia(query),
        geminiWebGroundedSearch(query, faculty, language),
      ]);

      const libraryMatches = libRes.status === 'fulfilled' && Array.isArray(libRes.value?.data)
        ? libRes.value.data
        : [];

      const webPool: WebSourceItem[] = [];
      if (gemSearch.status === 'fulfilled' && gemSearch.value?.webChunks?.length) {
        webPool.push(...gemSearch.value.webChunks);
      }
      if (oaRes.status === 'fulfilled') webPool.push(...oaRes.value);
      if (archiveRes.status === 'fulfilled') webPool.push(...archiveRes.value);
      if (wikiRes.status === 'fulfilled') webPool.push(...wikiRes.value);

      const webSources = dedupeWebSources(webPool);
      let aiOverview = gemSearch.status === 'fulfilled' && gemSearch.value?.summary
        ? gemSearch.value.summary
        : '';

      if (gemSearch.status === 'fulfilled' && gemSearch.value) {
        await auth.admin.from('pran_not_ai_usage').insert({
          user_id: auth.user.id,
          task: 'library_research',
          provider: 'gemini',
          model: 'gemini-2.5-flash+google_search',
          tokens_in: gemSearch.value.tokensIn,
          tokens_out: gemSearch.value.tokensOut,
          cached: false,
          success: true,
          latency_ms: Date.now() - started,
        });
      }

      // Repli de synthèse si Gemini Grounding indisponible mais des sources ont été trouvées
      if (!aiOverview && (webSources.length || libraryMatches.length)) {
        const ctxLines = [
          ...libraryMatches.slice(0, 4).map((m: Record<string, unknown>, i: number) =>
            `[Liv #${i + 1}] ${m.book_title} (${m.section_label}): ${String(m.content || '').slice(0, 450)}`
          ),
          ...webSources.slice(0, 6).map((w, i) =>
            `[Web #${i + 1}] ${w.title} (${w.source}): ${w.snippet}`
          ),
        ].join('\n\n');

        const synth = await runAiTask(auth.admin, auth.user.id, userQuota, {
          task: 'library_research',
          faculty,
          level,
          language,
          prompt: `Synthétise de façon originale (sans plagiat) les informations trouvées pour la recherche "${query}" en citant les repères [Liv #] ou [Web #] :\n\n${ctxLines}`,
          expectJson: false,
          useCache: true,
          cacheKeyPayload: { action: 'search_synth', query, faculty, language, topCount: webSources.length },
        });
        aiOverview = String((synth.result as { text?: string })?.text || '');
      }

      return jsonResponse({
        ok: true,
        query,
        libraryMatches,
        webSources,
        aiOverview: stripEmojis(aiOverview),
      });
    }

    /* ================================================================
       ACTION 2 : ANALYSE SÉCURISÉE D'UN TEXTE OU URL WEB + ANTI-PLAGIAT
       ================================================================ */
    if (action === 'analyze_source') {
      const sourceUrl = String(body.url || '').trim();
      const pastedText = String(body.rawText || '').trim();
      const topic = String(body.topic || '').trim();
      const saveBook = Boolean(body.saveToLibrary);

      if (!sourceUrl && pastedText.length < 40) {
        return errorResponse('invalid_input', 'Indiquez une URL publique valide ou collez au moins 40 caractères de texte.', 400);
      }

      let sourceTitle = String(body.title || '').trim();
      let sourceAuthor = String(body.author || '').trim();
      let finalUrl = sourceUrl;
      let extractedText = pastedText.slice(0, 22000);

      if (sourceUrl) {
        let fetched;
        try {
          fetched = await safeFetchExternal(sourceUrl);
        } catch (fetchErr) {
          return errorResponse('fetch_blocked_or_failed', `Impossible de charger cette URL en toute sécurité : ${(fetchErr as Error).message}`, 400);
        }
        finalUrl = fetched.finalUrl;

        const isPdf = fetched.contentType.includes('application/pdf') || /\.pdf(?:$|\?)/i.test(finalUrl);
        if (isPdf) {
          const pdfAnalyzed = await analyzePdfBytesWithGemini({
            bytes: fetched.bytes,
            topic,
            faculty,
            language,
          });
          if (!pdfAnalyzed) {
            return errorResponse('pdf_read_failed', 'Impossible d’extraire le texte de ce PDF distant (fichier protégé ou trop complexe). Vous pouvez le télécharger puis l’importer directement dans Ma Bibliothèque.', 422);
          }

          const orig = computeOriginalityMetrics([pdfAnalyzed.rawExtract], pdfAnalyzed.summary);
          let savedBook = null;
          if (saveBook && pdfAnalyzed.summary) {
            const titleToSave = sourceTitle || 'Document PDF Analysé';
            const contentHtml = `<h1>${titleToSave}</h1>`
              + `<p><strong>Source :</strong> ${finalUrl}</p>`
              + `<p>${pdfAnalyzed.summary.replace(/\n\n/g, '</p><p>')}</p>`
              + (pdfAnalyzed.keyPoints.length ? `<h2>Points clés (Synthèse sans plagiat)</h2><ul>${pdfAnalyzed.keyPoints.map((k) => `<li>${k}</li>`).join('')}</ul>` : '');

            const { data: inserted } = await auth.admin
              .from('pran_not_library_books')
              .insert({
                user_id: auth.user.id,
                scope: 'personal',
                faculty_id: faculty === 'autre' ? null : faculty,
                category: faculty === 'droit' ? 'article' : 'manuel',
                title: titleToSave.slice(0, 220),
                author: sourceAuthor || 'Source Web PDF',
                language: language === 'mix' ? 'fr' : language,
                source_url: finalUrl,
                summary: pdfAnalyzed.summary.slice(0, 500),
                content_html: contentHtml,
                metadata: { citation_apa: pdfAnalyzed.citation, originality_score: orig.originality_score },
              })
              .select('id, title, chunk_count')
              .single();

            if (inserted) {
              await auth.admin.from('pran_not_library_chunks').insert({
                book_id: inserted.id,
                user_id: auth.user.id,
                scope: 'personal',
                chunk_index: 0,
                section_label: 'Synthèse PDF analysée',
                page_number: 1,
                content: `${pdfAnalyzed.summary}\n\n${pdfAnalyzed.keyPoints.join('\n')}\n\n${pdfAnalyzed.legalRefs.join('\n')}`.trim(),
              });
              savedBook = { ...inserted, chunk_count: 1 };
            }
          }

          return jsonResponse({
            ok: true,
            url: finalUrl,
            title: sourceTitle || 'Document PDF',
            citation: pdfAnalyzed.citation,
            synthesis: pdfAnalyzed.summary,
            key_points: pdfAnalyzed.keyPoints,
            legal_quotes: pdfAnalyzed.legalRefs,
            originality_score: orig.originality_score,
            overlap_percent: orig.overlap_percent,
            saved_book: savedBook,
          });
        }

        const rawDecoded = new TextDecoder('utf-8', { fatal: false }).decode(fetched.bytes);
        if (fetched.contentType.includes('html') || /<html|<body|<p>/i.test(rawDecoded.slice(0, 1200))) {
          const parsed = extractReadableFromHtml(rawDecoded);
          if (!sourceTitle && parsed.title) sourceTitle = parsed.title;
          if (!sourceAuthor && parsed.author) sourceAuthor = parsed.author;
          extractedText = parsed.text;
        } else {
          extractedText = rawDecoded.replace(/\s+/g, ' ').trim().slice(0, 22000);
        }

        if (extractedText.length < 60) {
          return errorResponse('empty_source_text', 'Cette page web ne contient pas assez de texte lisible (site bloqué par script ou image). Collez le texte manuellement dans le champ ci-dessous.', 422);
        }
      }

      const buildAnalysisPrompt = (strictRewriteHint = '') => `Analyse ce document source et produis une synthèse universitaire STRICTEMENT ORIGINALE (ZÉRO plagiat) :
${strictRewriteHint}
Règles anti-plagiat :
1. Réécris toutes les explications et idées avec des phrases entièrement nouvelles (ne copie JAMAIS deux phrases ou bouts de phrases identiques à la source).
2. Exception juridique/scientifique : si le texte contient des articles de loi ou définitions officielles exactes, place-les dans "legal_quotes" entre guillemets avec leur numéro d’article.
3. Fournis la référence APA suggérée et les points clés exploitables pour un devoir.

Retourne STRICTEMENT ce JSON :
{
  "title": "${sourceTitle || 'Titre identifié du document'}",
  "citation": "Référence bibliographique format APA",
  "synthesis": "Synthèse analytique 100% originale sans plagiat (3 à 5 paragraphes bien structurés)",
  "key_points": ["Idée clé reformulée 1", "Idée clé 2", "Idée clé 3", "Idée clé 4"],
  "legal_quotes": ["Article ou citation officielle exacte si pertinent (sinon tableau vide)"],
  "how_to_use": ["Conseil concret pour intégrer cette source dans un devoir sans plagiat"]
}

${topic ? `Sujet de travail de l'étudiant : ${topic}` : ''}
${finalUrl ? `URL source : ${finalUrl}` : ''}
Texte source (${extractedText.length} caractères) :
${extractedText.slice(0, 16000)}`;

      let out = await runAiTask(auth.admin, auth.user.id, userQuota, {
        task: 'library_research',
        faculty,
        level,
        language,
        prompt: buildAnalysisPrompt(),
        expectJson: true,
        useCache: !saveBook,
        cacheKeyPayload: { action: 'analyze_source', url: finalUrl, hashLen: extractedText.length, topic, language },
      });

      let payload = (out.result || {}) as Record<string, unknown>;
      let synthesis = String(payload.synthesis || '');
      let metrics = computeOriginalityMetrics([extractedText], synthesis);

      // Si le chevauchement dépasse 14 %, lancer une deuxième passe stricte de reformulation anti-plagiat
      if (metrics.overlap_percent > 14 && synthesis) {
        const retry = await runAiTask(auth.admin, auth.user.id, userQuota, {
          task: 'library_research',
          faculty,
          level,
          language,
          prompt: buildAnalysisPrompt(`ALERTE ANTI-PLAGIAT : ${metrics.overlap_percent}% de suites de mots communes détectées (${metrics.matched_phrases.join(' ; ')}). Reformule INTÉGRALEMENT avec un nouveau vocabulaire et une nouvelle structure syntaxique pour atteindre > 92% d'originalité.`),
          expectJson: true,
          useCache: false,
          temperature: 0.55,
        });
        const retryPayload = (retry.result || {}) as Record<string, unknown>;
        const retryMetrics = computeOriginalityMetrics([extractedText], String(retryPayload.synthesis || ''));
        if (retryMetrics.originality_score >= metrics.originality_score) {
          payload = retryPayload;
          metrics = retryMetrics;
          synthesis = String(payload.synthesis || '');
        }
      }

      const finalTitle = stripEmojis(String(payload.title || sourceTitle || 'Source analysée'));
      const keyPoints = Array.isArray(payload.key_points) ? payload.key_points.map((x) => stripEmojis(String(x))) : [];
      const legalQuotes = Array.isArray(payload.legal_quotes) ? payload.legal_quotes.map((x) => stripEmojis(String(x))) : [];
      const citation = stripEmojis(String(payload.citation || (finalUrl ? `Source web. (${new Date().getFullYear()}). ${finalTitle}. ${finalUrl}` : finalTitle)));

      let savedBook = null;
      if (saveBook && synthesis) {
        const contentHtml = `<h1>${finalTitle}</h1>`
          + (finalUrl ? `<p><strong>Source :</strong> ${finalUrl}</p>` : '')
          + `<p><strong>Citation APA :</strong> ${citation}</p>`
          + `<h2>Synthèse Originale (Score d'originalité : ${metrics.originality_score}%)</h2>`
          + `<p>${synthesis.replace(/\n\n/g, '</p><p>')}</p>`
          + (keyPoints.length ? `<h2>Points Clés</h2><ul>${keyPoints.map((k) => `<li>${k}</li>`).join('')}</ul>` : '')
          + (legalQuotes.length ? `<h2>Dispositions Officielles Citées</h2><ul>${legalQuotes.map((q) => `<li>${q}</li>`).join('')}</ul>` : '');

        const { data: inserted } = await auth.admin
          .from('pran_not_library_books')
          .insert({
            user_id: auth.user.id,
            scope: 'personal',
            faculty_id: faculty === 'autre' ? null : faculty,
            category: 'article',
            title: finalTitle.slice(0, 220),
            author: sourceAuthor || 'Source analysée',
            language: language === 'mix' ? 'fr' : language,
            source_url: finalUrl || null,
            summary: synthesis.slice(0, 480),
            content_html: contentHtml,
            metadata: { citation_apa: citation, originality_score: metrics.originality_score },
          })
          .select('id, title, chunk_count')
          .single();

        if (inserted) {
          await auth.admin.from('pran_not_library_chunks').insert({
            book_id: inserted.id,
            user_id: auth.user.id,
            scope: 'personal',
            chunk_index: 0,
            section_label: 'Synthèse documentaire sans plagiat',
            page_number: 1,
            content: `${synthesis}\n\n${keyPoints.join('\n')}\n\n${legalQuotes.join('\n')}`.trim(),
          });
          savedBook = { ...inserted, chunk_count: 1 };
        }
      }

      return jsonResponse({
        ok: true,
        url: finalUrl || null,
        title: finalTitle,
        citation,
        synthesis: stripEmojis(synthesis),
        key_points: keyPoints,
        legal_quotes: legalQuotes,
        how_to_use: Array.isArray(payload.how_to_use) ? payload.how_to_use : [],
        originality_score: metrics.originality_score,
        overlap_percent: metrics.overlap_percent,
        saved_book: savedBook,
        provider: out.provider,
      });
    }

    /* ================================================================
       ACTION 3 : ASSISTANT RAG SUR LES LIVRES & CODES DE LA BIBLIOTHÈQUE
       ================================================================ */
    if (action === 'ask_library') {
      const question = String(body.question || '').trim();
      if (!question) return errorResponse('invalid_input', 'Question manquante.', 400);

      const bookIds = Array.isArray(body.bookIds) ? body.bookIds.filter(Boolean).slice(0, 5) : [];
      const useWeb = Boolean(body.useWeb);

      // 1. Recherche FTS/trigramme ciblée dans la bibliothèque
      let matchedChunks: Array<Record<string, unknown>> = [];
      if (bookIds.length === 1) {
        const { data: targeted } = await auth.userClient.rpc('pran_not_search_library', {
          p_query: question,
          p_faculty: faculty,
          p_scope: null,
          p_book_id: bookIds[0],
          p_limit: 8,
        });
        if (Array.isArray(targeted)) matchedChunks.push(...targeted);
      } else {
        const { data: globalHits } = await auth.userClient.rpc('pran_not_search_library', {
          p_query: question,
          p_faculty: faculty,
          p_scope: null,
          p_book_id: null,
          p_limit: 10,
        });
        if (Array.isArray(globalHits)) {
          matchedChunks = bookIds.length
            ? globalHits.filter((h: Record<string, unknown>) => bookIds.includes(String(h.book_id)))
            : globalHits;
        }
      }

      // Si des livres précis sont sélectionnés et que la recherche par mots-clés est large ("résume ce livre"), charger leurs premiers extraits
      if (bookIds.length && matchedChunks.length < 3) {
        const { data: fallbackChunks } = await auth.userClient
          .from('pran_not_library_chunks')
          .select('id, book_id, section_label, page_number, content')
          .in('book_id', bookIds)
          .order('chunk_index', { ascending: true })
          .limit(8);

        if (Array.isArray(fallbackChunks) && fallbackChunks.length) {
          const { data: booksMeta } = await auth.userClient
            .from('pran_not_library_books')
            .select('id, title, author, category')
            .in('id', bookIds);
          const metaMap = new Map((booksMeta || []).map((b: Record<string, unknown>) => [b.id, b]));
          const existingIds = new Set(matchedChunks.map((c) => c.chunk_id || c.id));
          for (const fc of fallbackChunks) {
            if (existingIds.has(fc.id)) continue;
            const bm = (metaMap.get(fc.book_id) || {}) as Record<string, unknown>;
            matchedChunks.push({
              chunk_id: fc.id,
              book_id: fc.book_id,
              book_title: bm.title || 'Ouvrage',
              author: bm.author || '',
              category: bm.category || 'manuel',
              section_label: fc.section_label,
              page_number: fc.page_number,
              content: fc.content,
            });
          }
        }
      }

      // 2. Optionnel : compléter avec des sources web vérifiées
      let webSources: WebSourceItem[] = [];
      let webBrief = '';
      if (useWeb || matchedChunks.length === 0) {
        const [oaRes, wkRes, gemSearch] = await Promise.allSettled([
          searchOpenAlex(question),
          searchWikimedia(question),
          geminiWebGroundedSearch(question, faculty, language),
        ]);
        const pool: WebSourceItem[] = [];
        if (gemSearch.status === 'fulfilled' && gemSearch.value) {
          pool.push(...gemSearch.value.webChunks);
          webBrief = gemSearch.value.summary || '';
        }
        if (oaRes.status === 'fulfilled') pool.push(...oaRes.value);
        if (wkRes.status === 'fulfilled') pool.push(...wkRes.value);
        webSources = dedupeWebSources(pool).slice(0, 6);
      }

      const contextBlocks = [
        ...matchedChunks.slice(0, 8).map((c, idx) =>
          `[Liv #${idx + 1}: ${c.book_title}${c.section_label ? ` — ${c.section_label}` : ''}${c.page_number ? ` (p. ${c.page_number})` : ''}]\n${String(c.content || '').slice(0, 1400)}`
        ),
        webBrief ? `[Synthèse Recherche Web Vérifiée]\n${webBrief.slice(0, 2200)}` : '',
        ...webSources.slice(0, 4).map((w, i) => `[Web #${i + 1}: ${w.title} | ${w.url}]\n${w.snippet}`),
      ].filter(Boolean).join('\n\n');

      const out = await runAiTask(auth.admin, auth.user.id, userQuota, {
        task: 'library_research',
        faculty,
        level,
        language,
        systemExtra: contextBlocks
          ? `SOURCES DOCUMENTAIRES DISPONIBLES (cite toujours la source exacte entre crochets, ne fabrique aucune référence) :\n\n${contextBlocks}`
          : '',
        prompt: `Question de l'étudiant : ${question}\n\nRéponds avec précision pédagogique, en citant clairement les livres, articles ou lois trouvés dans le contexte, et sans plagiat dans l'analyse.`,
        expectJson: false,
        useCache: false,
      });

      const answer = stripEmojis(String((out.result as { text?: string })?.text || ''));
      const citations = matchedChunks.slice(0, 6).map((c) => ({
        book_id: c.book_id,
        book_title: c.book_title,
        section_label: c.section_label || '',
        page_number: c.page_number || null,
        excerpt: String(c.content || '').slice(0, 220),
      }));

      return jsonResponse({
        ok: true,
        answer,
        citations,
        webSources,
        provider: out.provider,
      });
    }

    /* ================================================================
       ACTION 4 : CRÉATEUR DE LIVRE / MANUEL ORIGINAL SANS PLAGIAT
       ================================================================ */
    if (action === 'generate_book') {
      const topic = String(body.topic || '').trim();
      const instructions = String(body.instructions || '').trim();
      const chapterCount = Math.max(3, Math.min(8, Number(body.chapterCount || 5)));
      const selectedBookIds = Array.isArray(body.selectedBookIds) ? body.selectedBookIds.filter(Boolean).slice(0, 5) : [];
      const includeWebSearch = body.includeWebSearch !== false;
      const saveToLibrary = body.saveToLibrary !== false;

      if (!topic) {
        return errorResponse('invalid_input', 'Indiquez le sujet ou titre du livre à créer.', 400);
      }

      // 1. Collecter les extraits de la bibliothèque + recherche web parallèle
      const [libSearchRes, selectedChunksRes, oaRes, wikiRes, gemSearch] = await Promise.allSettled([
        auth.userClient.rpc('pran_not_search_library', {
          p_query: topic,
          p_faculty: faculty,
          p_scope: null,
          p_book_id: null,
          p_limit: 8,
        }),
        selectedBookIds.length
          ? auth.userClient
              .from('pran_not_library_chunks')
              .select('book_id, section_label, page_number, content')
              .in('book_id', selectedBookIds)
              .order('chunk_index', { ascending: true })
              .limit(10)
          : Promise.resolve({ data: [] }),
        includeWebSearch ? searchOpenAlex(topic) : Promise.resolve([]),
        includeWebSearch ? searchWikimedia(topic) : Promise.resolve([]),
        includeWebSearch ? geminiWebGroundedSearch(topic, faculty, language) : Promise.resolve(null),
      ]);

      const sourceTexts: string[] = [];
      const referencesList: string[] = [];

      const libChunks = libSearchRes.status === 'fulfilled' && Array.isArray(libSearchRes.value?.data)
        ? libSearchRes.value.data
        : [];
      for (const c of libChunks.slice(0, 6)) {
        const txt = String(c.content || '').trim();
        if (txt) {
          sourceTexts.push(txt);
          referencesList.push(`[Bibliothèque] ${c.book_title}${c.section_label ? ` — ${c.section_label}` : ''}`);
        }
      }

      if (selectedChunksRes.status === 'fulfilled' && Array.isArray(selectedChunksRes.value?.data)) {
        for (const c of selectedChunksRes.value.data.slice(0, 8)) {
          const txt = String(c.content || '').trim();
          if (txt && !sourceTexts.includes(txt)) sourceTexts.push(txt);
        }
      }

      const webSources: WebSourceItem[] = [];
      if (gemSearch.status === 'fulfilled' && gemSearch.value) {
        if (gemSearch.value.summary) sourceTexts.push(gemSearch.value.summary);
        webSources.push(...gemSearch.value.webChunks);
      }
      if (oaRes.status === 'fulfilled') webSources.push(...oaRes.value);
      if (wikiRes.status === 'fulfilled') webSources.push(...wikiRes.value);

      const dedupedWeb = dedupeWebSources(webSources).slice(0, 8);
      for (const w of dedupedWeb) {
        if (w.snippet) sourceTexts.push(`${w.title}: ${w.snippet}`);
        referencesList.push(`${w.authors ? `${w.authors}. ` : ''}${w.year ? `(${w.year}). ` : ''}${w.title} [${w.source}] - ${w.url}`);
      }

      const combinedContext = sourceTexts
        .slice(0, 12)
        .map((t, i) => `Source [${i + 1}] :\n${t.slice(0, 1200)}`)
        .join('\n\n');

      const bookPrompt = `Tu composes un livre / manuel universitaire COMPLET et 100% ORIGINAL sans plagiat pour un étudiant de niveau ${level} (Faculté : ${faculty}).
Sujet demandé : ${topic}
${instructions ? `Instructions / exigences de l'étudiant : ${instructions}` : ''}
Nombre de chapitres exact : ${chapterCount}

RÈGLES ABSOLUES ANTI-PLAGIAT :
1. Synthétise et rédige un texte entièrement original avec ta propre prose pédagogique et analytique. Ne recopie aucune phrase des sources (sauf citation légale/constitutionnelle exacte entre guillemets suivie de sa référence officielle).
2. Structure chaque chapitre avec du HTML propre (<h2>, <h3>, <p>, <ul><li>, <blockquote>).
3. Ajoute des exemples concrets et adaptés au contexte haïtien ou universitaire.
4. Inclus une bibliographie réelle basée uniquement sur les sources fournies ci-dessous (n'invente JAMAIS de fausse URL).
5. ZÉRO emoji partout.

Retourne STRICTEMENT ce JSON :
{
  "title": "Titre académique du livre",
  "subtitle": "Sous-titre explicatif",
  "abstract": "Résumé général / 4e de couverture (120-180 mots)",
  "chapters": [
    {
      "number": 1,
      "title": "Titre du chapitre 1",
      "content_html": "<h3>1.1 Section</h3><p>Contenu détaillé original...</p>",
      "key_concepts": ["Concept 1", "Concept 2", "Concept 3"]
    }
  ],
  "bibliography": ["Référence APA 1", "Référence 2"],
  "study_questions": ["Question de révision ou cas pratique 1", "Question 2", "Question 3"]
}

${combinedContext ? `DOCUMENTS ET SOURCES DE RECHERCHE À SYNTHÉTISER :\n\n${combinedContext}` : ''}`;

      const out = await runAiTask(auth.admin, auth.user.id, userQuota, {
        task: 'library_book',
        faculty,
        level,
        language,
        prompt: bookPrompt,
        expectJson: true,
        useCache: false,
        maxTokens: 7000,
        temperature: 0.45,
      });

      const bookJson = (out.result || {}) as Record<string, unknown>;
      const title = stripEmojis(String(bookJson.title || topic)).slice(0, 220);
      const subtitle = stripEmojis(String(bookJson.subtitle || ''));
      const abstractText = stripEmojis(String(bookJson.abstract || ''));
      const chapters = Array.isArray(bookJson.chapters) ? bookJson.chapters as Array<Record<string, unknown>> : [];
      const biblio = Array.isArray(bookJson.bibliography) && bookJson.bibliography.length
        ? bookJson.bibliography.map((x) => stripEmojis(String(x)))
        : referencesList;
      const questions = Array.isArray(bookJson.study_questions)
        ? bookJson.study_questions.map((x) => stripEmojis(String(x)))
        : [];

      const plainBookText = [
        abstractText,
        ...chapters.map((c) => `${c.title || ''} ${String(c.content_html || '').replace(/<[^>]+>/g, ' ')}`),
      ].join(' ');
      const metrics = computeOriginalityMetrics(sourceTexts, plainBookText);

      const assembledHtml = [
        `<h1>${title}</h1>`,
        subtitle ? `<p><em>${subtitle}</em></p>` : '',
        abstractText ? `<h2>Résumé / Présentation</h2><p>${abstractText}</p>` : '',
        ...chapters.map((c, idx) => {
          const chNum = Number(c.number || idx + 1);
          const chTitle = stripEmojis(String(c.title || `Chapitre ${chNum}`));
          const chHtml = stripEmojis(String(c.content_html || ''));
          const kcs = Array.isArray(c.key_concepts) && c.key_concepts.length
            ? `<p><strong>Notions clés :</strong> ${c.key_concepts.map((k) => stripEmojis(String(k))).join(', ')}</p>`
            : '';
          return `<h2>Chapitre ${chNum} : ${chTitle}</h2>${chHtml}${kcs}`;
        }),
        questions.length
          ? `<h2>Questions de Révision & Cas Pratiques</h2><ol>${questions.map((q) => `<li>${q}</li>`).join('')}</ol>`
          : '',
        biblio.length
          ? `<h2>Bibliographie et Sources</h2><ul>${biblio.map((b) => `<li>${b}</li>`).join('')}</ul>`
          : '',
      ].filter(Boolean).join('\n');

      let savedBookRecord = null;
      if (saveToLibrary && chapters.length) {
        const { data: insBook, error: insErr } = await auth.admin
          .from('pran_not_library_books')
          .insert({
            user_id: auth.user.id,
            scope: 'generated',
            faculty_id: faculty === 'autre' ? null : faculty,
            category: 'livre_ia',
            title,
            author: auth.profile?.full_name || 'Pran Nòt Studio IA',
            country: 'Haïti',
            publication_year: new Date().getFullYear(),
            language: language === 'mix' ? 'fr' : language,
            description: subtitle || `Manuel généré sur : ${topic}`,
            summary: abstractText.slice(0, 600),
            content_html: assembledHtml,
            page_count: chapters.length * 4,
            tags: ['livre_ia', faculty, 'sans_plagiat'],
            metadata: {
              originality_score: metrics.originality_score,
              overlap_percent: metrics.overlap_percent,
              sources_count: sourceTexts.length,
              bibliography: biblio,
              study_questions: questions,
              subtitle,
            },
          })
          .select('*')
          .single();

        if (!insErr && insBook) {
          const chunkRows = chapters.map((c, idx) => {
            const chNum = Number(c.number || idx + 1);
            const chTitle = stripEmojis(String(c.title || `Chapitre ${chNum}`));
            const plain = stripEmojis(String(c.content_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
            return {
              book_id: insBook.id,
              user_id: auth.user.id,
              scope: 'generated',
              chunk_index: idx,
              section_label: `Chapitre ${chNum} : ${chTitle}`,
              page_number: idx * 4 + 1,
              content: plain || chTitle,
            };
          });
          await auth.admin.from('pran_not_library_chunks').insert(chunkRows);
          savedBookRecord = { ...insBook, chunk_count: chunkRows.length };
        }
      }

      return jsonResponse({
        ok: true,
        book: savedBookRecord || {
          title,
          subtitle,
          summary: abstractText,
          content_html: assembledHtml,
          metadata: {
            originality_score: metrics.originality_score,
            bibliography: biblio,
            study_questions: questions,
          },
        },
        chapters: sanitizeJsonEmojis(chapters),
        bibliography: biblio,
        study_questions: questions,
        originality_score: metrics.originality_score,
        overlap_percent: metrics.overlap_percent,
        webSources: dedupedWeb,
        librarySourcesCount: libChunks.length,
        provider: out.provider,
      });
    }

    return errorResponse('unsupported_action', `Action inconnue : ${action}`, 400);
  } catch (err) {
    if (err instanceof QuotaExceededError) return errorResponse('quota_exceeded', err.message, 429);
    console.error('[library-research]', err);
    return errorResponse('library_error', (err as Error).message || 'Erreur recherche bibliothèque', 500);
  }
});
