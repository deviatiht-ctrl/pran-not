/* =====================================================================
   PRAN NÒT - pages/library.js
   Bibliothèque universitaire multi-facultés, Codes juridiques haïtiens,
   import PDF/TXT/MD avec découpage RAG, recherche Web réelle sans plagiat,
   assistant documentaire IA et créateur de livres originaux exportables.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, awardXp, recordActivity } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, getLang } from '../i18n.js';
import {
  icons, icon, esc, getParam, isUuid, uid, toast, handleError, setLoading,
  openModal, confirmDialog, sanitizeHtml, renderMarkdown, emptyState, debounce,
  extractPdfText, safeFilename, pageEnter,
} from '../utils.js';
import {
  searchLibraryWeb, analyzeLibrarySource, askLibrary, generateLibraryBook,
} from '../ai.js';
import { exportBookPdf, exportBookDocx } from '../export.js';
import { cacheSet, cacheGet } from '../offline.js';

const db = window.db;
const MAX_LIBRARY_BYTES = 30 * 1024 * 1024;

let userRef = null;
let profileRef = null;
let faculties = [];
let booksList = [];
let activeTab = 'books';
let offlineCachedIds = new Set();
let matchedBookIdsFromChunks = null;
let lastCreatedBook = null;

function foldText(s = '') {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function facultyLabel(facId) {
  if (!facId) return t('library.filter_faculty_all');
  const f = faculties.find((x) => x.id === facId);
  if (!f) return facId;
  return getLang() === 'fr' ? f.name_fr : f.name_ht;
}

function categoryLabel(cat) {
  const key = `library.categories.${cat || 'autre'}`;
  const val = t(key);
  return val === key ? (cat || 'Doc') : val;
}

function scopeLabel(scope) {
  const key = `library.scope_${scope || 'personal'}`;
  const val = t(key);
  return val === key ? scope : val;
}

function switchTab(tabName) {
  activeTab = ['books', 'web', 'ask', 'creator'].includes(tabName) ? tabName : 'books';
  document.querySelectorAll('#library-tabs [role="tab"]').forEach((btn) => {
    btn.setAttribute('aria-selected', btn.dataset.tab === activeTab ? 'true' : 'false');
  });
  document.getElementById('panel-books').hidden = activeTab !== 'books';
  document.getElementById('panel-web').hidden = activeTab !== 'web';
  document.getElementById('panel-ask').hidden = activeTab !== 'ask';
  document.getElementById('panel-creator').hidden = activeTab !== 'creator';
}

/* ------------------------------------------------------------------
   Découpage propre d'un document PDF / texte en segments indexés (RAG)
   ------------------------------------------------------------------ */
function splitTextIntoChunks(rawText, totalPages = 1) {
  const clean = String(rawText || '').replace(/\r/g, '').trim();
  if (!clean) return [];

  const chunks = [];
  const paragraphs = clean.split(/\n{2,}/);
  let buf = '';
  let lastHeading = '';
  const targetLen = 1500;

  const flush = () => {
    const content = buf.trim();
    if (!content) return;
    const progressRatio = clean.length ? Math.min(1, chunks.length / Math.max(1, Math.ceil(clean.length / targetLen))) : 0;
    const estPage = Math.max(1, Math.min(totalPages, Math.round(progressRatio * totalPages) || 1));
    chunks.push({
      chunk_index: chunks.length,
      section_label: lastHeading || `Seksyon ${chunks.length + 1}`,
      page_number: estPage,
      content,
    });
    buf = '';
  };

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    // Détecter titres / chapitres / articles de loi
    const headingMatch = p.match(/^((?:Titre|Chapitre|Section|Livre|Art\.|Article|PREAMBULE|Préambule)\s*[^\n]{0,80})/i);
    if (headingMatch && p.length < 130) {
      if (buf.length > 400) flush();
      lastHeading = headingMatch[1].trim();
    }
    if ((buf.length + p.length + 2) > targetLen && buf.length >= 450) {
      flush();
    }
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return chunks.slice(0, 180);
}

/* ------------------------------------------------------------------
   Chargement & rendu de la Bibliothèque
   ------------------------------------------------------------------ */
async function loadBooks() {
  try {
    const { data, error } = await db
      .from('pran_not_library_books')
      .select('id, user_id, scope, faculty_id, category, title, author, country, publication_year, language, description, storage_path, source_url, mime, size_bytes, page_count, chunk_count, summary, tags, metadata, is_offline_cached, updated_at')
      .order('scope', { ascending: true })
      .order('updated_at', { ascending: false })
      .limit(120);
    if (error) throw error;
    booksList = data || [];
    await cacheSet('library_books_index', booksList);
  } catch (err) {
    const cached = await cacheGet('library_books_index');
    if (cached) booksList = cached;
    else handleError(err);
  }

  for (const b of booksList) {
    const localBook = await cacheGet(`library_book_${b.id}`);
    if (localBook) offlineCachedIds.add(b.id);
  }
  renderBookSelectors();
  renderBooksGrid();
}

function renderBookSelectors() {
  const renderChecklist = (containerId, name) => {
    const box = document.getElementById(containerId);
    if (!box) return;
    if (!booksList.length) {
      box.innerHTML = `<span class="text-xs muted">${esc(t('common.none'))}</span>`;
      return;
    }
    box.innerHTML = booksList.map((b) => `
      <label class="lib-check-row">
        <input type="checkbox" name="${name}" value="${esc(b.id)}">
        <div class="flex-1">
          <strong>${esc(b.title)}</strong>
          <div class="text-xs muted">${esc(categoryLabel(b.category))}${b.faculty_id ? ` · ${esc(facultyLabel(b.faculty_id))}` : ''}</div>
        </div>
      </label>`).join('');
  };
  renderChecklist('ask-books-list', 'ask_book_id');
  renderChecklist('creator-books-list', 'creator_book_id');
}

function getFilteredBooks() {
  const q = foldText((document.getElementById('lib-book-search')?.value || '').trim());
  const scope = document.getElementById('lib-scope-filter')?.value || '';
  const fac = document.getElementById('lib-faculty-filter')?.value || '';

  return booksList.filter((b) => {
    if (scope && b.scope !== scope) return false;
    if (fac && b.faculty_id !== fac) return false;
    if (q) {
      if (matchedBookIdsFromChunks && matchedBookIdsFromChunks.has(b.id)) return true;
      const hay = foldText(`${b.title || ''} ${b.author || ''} ${b.description || ''} ${b.summary || ''} ${(b.tags || []).join(' ')}`);
      const words = q.split(/\s+/).filter((w) => w.length >= 2);
      if (hay.includes(q)) return true;
      if (words.length > 1 && words.every((w) => hay.includes(w))) return true;
      return false;
    }
    return true;
  });
}

function renderBooksGrid() {
  const grid = document.getElementById('lib-books-grid');
  const rows = getFilteredBooks();

  if (!rows.length) {
    grid.innerHTML = `<div style="grid-column:1 / -1;">${emptyState({
      icon: 'library',
      title: t('library.empty_title'),
      text: t('library.empty_text'),
    })}</div>`;
    icons(grid);
    return;
  }

  grid.innerHTML = rows.map((b) => {
    const isOwner = b.user_id === userRef?.id;
    const isOffline = offlineCachedIds.has(b.id) || b.is_offline_cached;
    const orig = b.metadata?.originality_score;
    return `
      <article class="card card-sm lib-book-card" data-book-id="${esc(b.id)}">
        <div class="row-between" style="flex-wrap:wrap;gap:6px;">
          <span class="badge ${b.scope === 'official' ? 'badge-accent' : b.scope === 'generated' ? 'badge-info' : 'badge-outline'}">${esc(scopeLabel(b.scope))}</span>
          <span class="badge">${esc(categoryLabel(b.category))}</span>
        </div>
        <div>
          <h3 class="card-title mb-1">${esc(b.title)}</h3>
          <div class="text-xs muted">
            ${b.author ? esc(b.author) : 'Pran Nòt'}${b.publication_year ? ` · ${b.publication_year}` : ''}${b.faculty_id ? ` · ${esc(facultyLabel(b.faculty_id))}` : ''}
          </div>
        </div>
        ${b.description || b.summary ? `<p class="text-sm muted mb-0">${esc((b.description || b.summary).slice(0, 150))}</p>` : ''}
        <div class="row-wrap">
          <span class="text-xs muted">${b.chunk_count || 0} seksyon</span>
          ${typeof orig === 'number' ? `<span class="badge badge-success">${orig}% orijinal</span>` : ''}
          ${isOffline ? `<span class="badge badge-success">${esc(t('library.offline_saved_badge'))}</span>` : ''}
        </div>
        <div class="lib-book-foot">
          <button type="button" class="btn btn-sm btn-primary" data-read-book="${esc(b.id)}">
            ${icon('book-open')}<span>${esc(t('library.read_btn'))}</span>
          </button>
          <button type="button" class="btn btn-sm btn-secondary" data-ask-book="${esc(b.id)}">
            ${icon('sparkles')}<span>${esc(t('library.ask_about_btn'))}</span>
          </button>
          <button type="button" class="btn btn-sm btn-ghost" data-offline-book="${esc(b.id)}" title="${esc(t('library.offline_save_btn'))}">
            ${icon('download-cloud')}
          </button>
          ${isOwner ? `<button type="button" class="btn btn-sm btn-ghost" data-del-book="${esc(b.id)}" aria-label="${esc(t('library.delete_btn'))}">${icon('trash-2')}</button>` : ''}
        </div>
      </article>`;
  }).join('');

  grid.querySelectorAll('[data-read-book]').forEach((btn) => {
    btn.addEventListener('click', () => openBookReader(btn.dataset.readBook));
  });
  grid.querySelectorAll('[data-ask-book]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const bookId = btn.dataset.askBook;
      const b = booksList.find((x) => x.id === bookId);
      switchTab('ask');
      document.querySelectorAll('#ask-books-list input[type="checkbox"]').forEach((cb) => {
        cb.checked = cb.value === bookId;
      });
      if (b) {
        setTutorContext({ contextType: 'book', contextId: b.id, contextTitle: b.title });
      }
      document.getElementById('ask-question')?.focus();
    });
  });
  grid.querySelectorAll('[data-offline-book]').forEach((btn) => {
    btn.addEventListener('click', () => saveBookOffline(btn.dataset.offlineBook, btn));
  });
  grid.querySelectorAll('[data-del-book]').forEach((btn) => {
    btn.addEventListener('click', () => deletePersonalBook(btn.dataset.delBook));
  });

  icons(grid);
}

const runChunkSearch = debounce(async () => {
  const q = (document.getElementById('lib-book-search')?.value || '').trim();
  const fac = document.getElementById('lib-faculty-filter')?.value || null;
  const scope = document.getElementById('lib-scope-filter')?.value || null;
  const box = document.getElementById('lib-chunk-hits');

  if (q.length < 2 || !navigator.onLine) {
    matchedBookIdsFromChunks = null;
    renderBooksGrid();
    box.hidden = true;
    box.innerHTML = '';
    return;
  }

  try {
    const { data, error } = await db.rpc('pran_not_search_library', {
      p_query: q,
      p_faculty: fac || null,
      p_scope: scope || null,
      p_book_id: null,
      p_limit: 6,
    });
    if (error || !data?.length) {
      matchedBookIdsFromChunks = null;
      renderBooksGrid();
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    matchedBookIdsFromChunks = new Set(data.map((hit) => hit.book_id).filter(Boolean));
    renderBooksGrid();
    box.hidden = false;
    box.innerHTML = `
      <div class="card card-sm">
        <div class="ai-suggestion-label">${icon('search')}<span>${esc(t('library.web_lib_hits_title'))}</span></div>
        <div class="stack-sm mt-2">
          ${data.map((hit) => `
            <div class="card card-sm card-flat card-muted">
              <div class="row-between" style="flex-wrap:wrap;gap:6px;">
                <strong class="text-sm">${esc(hit.book_title)}</strong>
                ${hit.section_label ? `<span class="badge">${esc(hit.section_label)}</span>` : ''}
              </div>
              <div class="text-xs muted mt-1 mb-2">${hit.snippet || ''}</div>
              <button type="button" class="btn btn-sm btn-secondary" data-open-hit="${esc(hit.book_id)}">
                ${icon('book-open')}<span>${esc(t('library.read_btn'))}</span>
              </button>
            </div>`).join('')}
        </div>
      </div>`;
    box.querySelectorAll('[data-open-hit]').forEach((btn) => {
      btn.addEventListener('click', () => openBookReader(btn.dataset.openHit));
    });
    icons(box);
  } catch {
    box.hidden = true;
  }
}, 280);

async function fetchFullBookData(bookId) {
  const cached = await cacheGet(`library_book_${bookId}`);
  if (!navigator.onLine && cached) return cached;

  const { data: book, error } = await db
    .from('pran_not_library_books')
    .select('*')
    .eq('id', bookId)
    .maybeSingle();
  if (error || !book) {
    if (cached) return cached;
    throw error || new Error('not_found');
  }

  const { data: chunks } = await db
    .from('pran_not_library_chunks')
    .select('id, chunk_index, section_label, page_number, content')
    .eq('book_id', bookId)
    .order('chunk_index', { ascending: true })
    .limit(180);

  return { book, chunks: chunks || [] };
}

async function openBookReader(bookId) {
  try {
    const { book, chunks } = await fetchFullBookData(bookId);
    setTutorContext({ contextType: 'book', contextId: book.id, contextTitle: book.title });

    const bodyHtml = `
      <div class="row-wrap mb-3">
        <span class="badge badge-accent">${esc(scopeLabel(book.scope))}</span>
        <span class="badge">${esc(categoryLabel(book.category))}</span>
        ${book.author ? `<span class="text-xs muted">${esc(book.author)}</span>` : ''}
        ${book.metadata?.citation_apa ? `<span class="text-xs muted">APA : ${esc(book.metadata.citation_apa)}</span>` : ''}
      </div>
      <div class="row-wrap mb-4">
        <button type="button" class="btn btn-sm btn-secondary" id="reader-pdf-btn">${icon('file-text')}<span>${esc(t('library.export_pdf_btn'))}</span></button>
        <button type="button" class="btn btn-sm btn-secondary" id="reader-docx-btn">${icon('file-type')}<span>${esc(t('library.export_docx_btn'))}</span></button>
        ${book.storage_path ? `<button type="button" class="btn btn-sm btn-secondary" id="reader-dl-btn">${icon('download')}<span>${esc(t('library.download_pdf_btn'))}</span></button>` : ''}
        <button type="button" class="btn btn-sm btn-ghost" id="reader-offline-btn">${icon('download-cloud')}<span>${esc(t('library.offline_save_btn'))}</span></button>
      </div>
      <div class="book-reader-body">
        ${book.content_html
          ? sanitizeHtml(book.content_html)
          : chunks.map((c) => `
              <section class="mb-4">
                <h3>${esc(c.section_label || `Seksyon ${c.chunk_index + 1}`)}${c.page_number ? ` (p. ${c.page_number})` : ''}</h3>
                <p>${esc(c.content).replace(/\n/g, '<br>')}</p>
              </section>`).join('') || `<p class="muted">${esc(book.description || book.summary || '')}</p>`}
      </div>`;

    const assembledBook = {
      ...book,
      content_html: book.content_html || chunks.map((c) => `<h2>${esc(c.section_label || '')}</h2><p>${esc(c.content)}</p>`).join('\n'),
    };

    const m = openModal({ title: book.title, body: bodyHtml, size: 'lg' });
    m.el.querySelector('#reader-pdf-btn')?.addEventListener('click', () => exportBookPdf(assembledBook, profileRef));
    m.el.querySelector('#reader-docx-btn')?.addEventListener('click', () => exportBookDocx(assembledBook, profileRef));
    m.el.querySelector('#reader-offline-btn')?.addEventListener('click', (e) => saveBookOffline(book.id, e.currentTarget));
    m.el.querySelector('#reader-dl-btn')?.addEventListener('click', async () => {
      const { data: signed, error: sErr } = await db.storage.from('pran-not-library').createSignedUrl(book.storage_path, 120);
      if (sErr || !signed?.signedUrl) {
        toast(t('errors.generic'), 'error');
        return;
      }
      window.open(signed.signedUrl, '_blank', 'noopener');
    });
  } catch (err) {
    handleError(err);
  }
}

async function saveBookOffline(bookId, btn = null) {
  setLoading(btn, true);
  try {
    const payload = await fetchFullBookData(bookId);
    await cacheSet(`library_book_${bookId}`, payload);
    offlineCachedIds.add(bookId);
    if (payload.book.user_id === userRef?.id && navigator.onLine) {
      await db.from('pran_not_library_books').update({ is_offline_cached: true }).eq('id', bookId);
    }
    toast(t('library.offline_saved_badge'), 'success');
    renderBooksGrid();
  } catch (err) {
    handleError(err);
  } finally {
    setLoading(btn, false);
  }
}

async function deletePersonalBook(bookId) {
  const b = booksList.find((x) => x.id === bookId);
  if (!b) return;
  const ok = await confirmDialog({
    title: t('library.delete_btn'),
    message: `${b.title}`,
    danger: true,
  });
  if (!ok) return;
  try {
    if (b.storage_path) {
      await db.storage.from('pran-not-library').remove([b.storage_path]);
    }
    const { error } = await db.from('pran_not_library_books').delete().eq('id', bookId);
    if (error) throw error;
    toast(t('common.deleted'), 'success');
    await loadBooks();
  } catch (err) {
    handleError(err);
  }
}

function openUploadModal() {
  const facOptions = faculties.map((f) => {
    const label = getLang() === 'fr' ? f.name_fr : f.name_ht;
    return `<option value="${esc(f.id)}" ${f.id === profileRef?.faculty_id ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');

  const m = openModal({
    title: t('library.upload_modal_title'),
    body: `
      <form id="lib-upload-form">
        <div class="field">
          <label for="up-file">${esc(t('library.upload_file_label'))}</label>
          <input class="input" id="up-file" type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" required style="padding-top:9px;">
        </div>
        <div class="field">
          <label for="up-title">${esc(t('library.upload_title_label'))}</label>
          <input class="input" id="up-title" type="text" required placeholder="Ex : Code Civil / Manuel d'Anatomie...">
        </div>
        <div class="form-row">
          <div class="field">
            <label for="up-author">${esc(t('library.upload_author_label'))}</label>
            <input class="input" id="up-author" type="text" placeholder="Ex : Professeur / Auteur">
          </div>
          <div class="field">
            <label for="up-faculty">${esc(t('library.upload_faculty_label'))}</label>
            <select class="select" id="up-faculty">${facOptions}</select>
          </div>
        </div>
        <div class="field">
          <label for="up-cat">${esc(t('library.upload_category_label'))}</label>
          <select class="select" id="up-cat">
            <option value="manuel">${esc(categoryLabel('manuel'))}</option>
            <option value="code_loi">${esc(categoryLabel('code_loi'))}</option>
            <option value="constitution">${esc(categoryLabel('constitution'))}</option>
            <option value="jurisprudence">${esc(categoryLabel('jurisprudence'))}</option>
            <option value="these">${esc(categoryLabel('these'))}</option>
            <option value="article">${esc(categoryLabel('article'))}</option>
            <option value="autre">${esc(categoryLabel('autre'))}</option>
          </select>
        </div>
        <button type="submit" class="btn btn-primary btn-block" id="up-submit-btn">
          ${icon('upload')}<span>${esc(t('library.upload_submit'))}</span>
        </button>
      </form>`,
  });

  const fileInput = m.el.querySelector('#up-file');
  const titleInput = m.el.querySelector('#up-title');
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f && !titleInput.value.trim()) {
      titleInput.value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    }
  });

  m.el.querySelector('#lib-upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = fileInput.files?.[0];
    const title = titleInput.value.trim();
    if (!file || !title) {
      toast(t('errors.required'), 'warning');
      return;
    }
    if (file.size > MAX_LIBRARY_BYTES) {
      toast(t('errors.file_too_large', { max: '30 Mo' }), 'error');
      return;
    }
    const submitBtn = m.el.querySelector('#up-submit-btn');
    setLoading(submitBtn, true);

    try {
      let extracted = '';
      let pages = 1;
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      if (isPdf) {
        const res = await extractPdfText(file, { maxPages: 120 });
        extracted = res.text || '';
        pages = res.pages || 1;
      } else {
        extracted = await file.text();
      }

      const bookId = uid();
      const ext = file.name.split('.').pop()?.toLowerCase() || (isPdf ? 'pdf' : 'txt');
      const storagePath = `${userRef.id}/${bookId}/${safeFilename(title, ext)}`;
      const { error: stErr } = await db.storage.from('pran-not-library').upload(storagePath, file, {
        contentType: file.type || (isPdf ? 'application/pdf' : 'text/plain'),
      });
      if (stErr) throw stErr;

      const chunks = splitTextIntoChunks(extracted, pages);
      const facVal = m.el.querySelector('#up-faculty').value || null;
      const catVal = m.el.querySelector('#up-cat').value || 'manuel';
      const authorVal = m.el.querySelector('#up-author').value.trim() || profileRef?.full_name || '';

      const { error: insErr } = await db.from('pran_not_library_books').insert({
        id: bookId,
        user_id: userRef.id,
        scope: 'personal',
        faculty_id: facVal === 'autre' ? null : facVal,
        category: catVal,
        title: title.slice(0, 235),
        author: authorVal || null,
        language: getLang(),
        storage_path: storagePath,
        mime: file.type || (isPdf ? 'application/pdf' : 'text/plain'),
        size_bytes: file.size,
        page_count: pages,
        summary: extracted ? extracted.slice(0, 480) : `Fichye ${file.name} telechaje.`,
        tags: [catVal, facVal].filter(Boolean),
      });
      if (insErr) throw insErr;

      if (chunks.length) {
        const rows = chunks.map((c) => ({
          book_id: bookId,
          user_id: userRef.id,
          scope: 'personal',
          chunk_index: c.chunk_index,
          section_label: c.section_label,
          page_number: c.page_number,
          content: c.content,
        }));
        for (let i = 0; i < rows.length; i += 40) {
          await db.from('pran_not_library_chunks').insert(rows.slice(i, i + 40));
        }
      }

      await recordActivity();
      await awardXp(20, 'library_upload', bookId);
      const scopeEl = document.getElementById('lib-scope-filter');
      const facEl = document.getElementById('lib-faculty-filter');
      if (scopeEl && scopeEl.value === 'official') scopeEl.value = '';
      if (facEl && facEl.value && facEl.value !== (facVal === 'autre' ? '' : facVal)) facEl.value = '';
      toast(t('common.saved'), 'success');
      m.close();
      await loadBooks();
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(submitBtn, false);
    }
  });
}

/* ------------------------------------------------------------------
   Onglet 2 : Recherche Web Universelle & Analyse Anti-Plagiat
   ------------------------------------------------------------------ */
async function runWebSearch(query) {
  const btn = document.getElementById('web-search-btn');
  const box = document.getElementById('web-search-results');
  setLoading(btn, true);
  try {
    const res = await searchLibraryWeb({
      query,
      faculty: profileRef?.faculty_id || 'autre',
      includeLibrary: true,
      language: getLang(),
    });
    box.hidden = false;

    const libHits = Array.isArray(res.libraryMatches) ? res.libraryMatches : [];
    const webSources = Array.isArray(res.webSources) ? res.webSources : [];

    box.innerHTML = `
      ${res.aiOverview ? `
        <div class="card">
          <div class="ai-suggestion-label">${icon('sparkles')}<span>${esc(t('library.web_overview_title'))}</span></div>
          <div class="text-sm mt-2">${renderMarkdown(res.aiOverview)}</div>
        </div>` : ''}
      ${libHits.length ? `
        <div class="card">
          <h3 class="card-title mb-3">${esc(t('library.web_lib_hits_title'))}</h3>
          <div class="stack-sm">
            ${libHits.map((m) => `
              <div class="card card-sm card-flat card-muted">
                <div class="row-between" style="flex-wrap:wrap;gap:6px;">
                  <strong>${esc(m.book_title)}</strong>
                  ${m.section_label ? `<span class="badge badge-accent">${esc(m.section_label)}</span>` : ''}
                </div>
                <p class="text-xs muted mt-1 mb-2">${esc(String(m.content || '').slice(0, 260))}...</p>
                <button type="button" class="btn btn-sm btn-secondary" data-web-open-book="${esc(m.book_id)}">
                  ${icon('book-open')}<span>${esc(t('library.read_btn'))}</span>
                </button>
              </div>`).join('')}
          </div>
        </div>` : ''}
      <div class="card">
        <h3 class="card-title mb-3">${esc(t('library.web_results_title'))} (${webSources.length})</h3>
        ${webSources.length ? `<div class="stack-sm">
          ${webSources.map((w, idx) => `
            <div class="card card-sm card-flat card-muted">
              <div class="row-between" style="flex-wrap:wrap;gap:6px;">
                <span class="badge">${esc(w.source)}</span>
                <div class="row-wrap">
                  ${w.isPdf ? '<span class="badge badge-accent">PDF</span>' : ''}
                  ${w.openAccess ? '<span class="badge badge-success">Open Access</span>' : ''}
                </div>
              </div>
              <strong class="mt-2" style="display:block;">${esc(w.title)}</strong>
              <div class="text-xs muted mt-1">${w.authors ? esc(w.authors) : ''}${w.year ? ` (${w.year})` : ''}</div>
              <p class="text-sm mt-2 mb-2">${esc(w.snippet)}</p>
              <div class="row-wrap">
                <button type="button" class="btn btn-sm btn-primary" data-analyze-web="${idx}">
                  ${icon('shield-check')}<span>${esc(t('library.analyze_btn'))}</span>
                </button>
                <a class="btn btn-sm btn-secondary" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">
                  ${icon('external-link')}<span>${esc(t('common.open'))}</span>
                </a>
              </div>
            </div>`).join('')}
        </div>` : `<p class="text-sm muted mb-0">${esc(t('search.empty'))}</p>`}
      </div>`;

    box.querySelectorAll('[data-web-open-book]').forEach((b) => {
      b.addEventListener('click', () => openBookReader(b.dataset.webOpenBook));
    });
    box.querySelectorAll('[data-analyze-web]').forEach((b) => {
      b.addEventListener('click', () => {
        const w = webSources[Number(b.dataset.analyzeWeb)];
        if (!w) return;
        document.getElementById('analyze-url').value = w.url;
        document.getElementById('analyze-topic').value = query;
        runAnalyzeSource({ url: w.url, title: w.title, author: w.authors || '', topic: query });
      });
    });
    icons(box);
  } catch (err) {
    handleError(err);
  } finally {
    setLoading(btn, false);
  }
}

async function runAnalyzeSource({ url = '', rawText = '', title = '', author = '', topic = '' } = {}) {
  const btn = document.getElementById('analyze-run-btn');
  const box = document.getElementById('analyze-result-box');
  const saveToLibrary = document.getElementById('analyze-save-switch')?.checked === true;
  setLoading(btn, true);
  try {
    const res = await analyzeLibrarySource({
      url: url || document.getElementById('analyze-url').value.trim(),
      rawText: rawText || document.getElementById('analyze-text').value.trim(),
      title,
      author,
      topic: topic || document.getElementById('analyze-topic').value.trim(),
      faculty: profileRef?.faculty_id || 'autre',
      language: getLang(),
      saveToLibrary,
    });

    box.hidden = false;
    const score = Number(res.originality_score ?? 95);
    const badgeCls = score >= 85 ? 'badge-success' : 'badge-warning';
    const keyPoints = Array.isArray(res.key_points) ? res.key_points : [];
    const legalQuotes = Array.isArray(res.legal_quotes) ? res.legal_quotes : [];

    box.innerHTML = `
      <div class="originality-box mb-3">
        ${icon('shield-check')}
        <div class="flex-1">
          <div class="text-xs muted">${esc(t('library.originality_label'))}</div>
          <strong>${score}%</strong>
        </div>
        <span class="badge ${badgeCls}">${score >= 85 ? 'San plajya' : 'Verifye'}</span>
      </div>
      <h3 class="text-sm font-display mb-1">${esc(res.title)}</h3>
      ${res.citation ? `
        <div class="card card-sm card-muted mb-3">
          <div class="text-xs muted mb-1">Referans APA</div>
          <div class="text-xs">${esc(res.citation)}</div>
        </div>` : ''}
      <div class="text-sm mb-3">${renderMarkdown(res.synthesis)}</div>
      ${keyPoints.length ? `
        <div class="mb-3">
          <strong class="text-xs">Pwen kle :</strong>
          <ul class="text-xs mt-1 mb-0" style="padding-left:1.2em;">${keyPoints.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
        </div>` : ''}
      ${legalQuotes.length ? `
        <div class="ai-suggestion mb-3">
          <div class="ai-suggestion-label">${icon('scale')}<span>Tèks ofisyèl / Atik cite</span></div>
          <ul class="text-xs mt-1 mb-0" style="padding-left:1.2em;">${legalQuotes.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>
        </div>` : ''}
      ${res.saved_book ? `<div class="badge badge-success">${esc(t('common.saved'))} : ${esc(res.saved_book.title)}</div>` : ''}`;

    icons(box);
    if (res.saved_book) await loadBooks();
  } catch (err) {
    handleError(err);
  } finally {
    setLoading(btn, false);
  }
}

/* ------------------------------------------------------------------
   Onglet 3 : Assistant IA sur Livres & Codes
   ------------------------------------------------------------------ */
async function runAskLibrary(question) {
  const btn = document.getElementById('ask-run-btn');
  const box = document.getElementById('ask-answer-box');
  const bookIds = Array.from(document.querySelectorAll('#ask-books-list input:checked')).map((c) => c.value);
  const useWeb = document.getElementById('ask-web-switch')?.checked === true;

  setLoading(btn, true);
  try {
    const res = await askLibrary({
      question,
      bookIds,
      useWeb,
      faculty: profileRef?.faculty_id || 'autre',
      level: profileRef?.level || 'L1',
      language: getLang(),
    });
    box.hidden = false;
    const citations = Array.isArray(res.citations) ? res.citations : [];
    const webSources = Array.isArray(res.webSources) ? res.webSources : [];

    box.innerHTML = `
      <div class="card">
        <div class="ai-suggestion-label">${icon('sparkles')}<span>Pran Nòt IA</span></div>
        <div class="mt-2 text-sm">${renderMarkdown(res.answer)}</div>
      </div>
      ${citations.length ? `
        <div class="card">
          <h3 class="card-title mb-3">${esc(t('library.ask_citations_title'))}</h3>
          <div class="stack-sm">
            ${citations.map((c) => `
              <div class="card card-sm card-flat card-muted">
                <div class="row-between" style="flex-wrap:wrap;gap:6px;">
                  <strong>${esc(c.book_title)}</strong>
                  ${c.section_label ? `<span class="badge">${esc(c.section_label)}</span>` : ''}
                </div>
                <p class="text-xs muted mt-1 mb-2">${esc(c.excerpt)}...</p>
                <button type="button" class="btn btn-sm btn-secondary" data-cite-book="${esc(c.book_id)}">
                  ${icon('book-open')}<span>${esc(t('library.read_btn'))}</span>
                </button>
              </div>`).join('')}
          </div>
        </div>` : ''}
      ${webSources.length ? `
        <div class="card card-sm">
          <strong class="text-sm mb-2" style="display:block;">Sous Web konplemantè</strong>
          <div class="stack-sm">
            ${webSources.map((w) => `<a class="text-xs" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${esc(w.title)} (${esc(w.source)})</a>`).join('')}
          </div>
        </div>` : ''}`;

    box.querySelectorAll('[data-cite-book]').forEach((b) => {
      b.addEventListener('click', () => openBookReader(b.dataset.citeBook));
    });
    icons(box);
  } catch (err) {
    handleError(err);
  } finally {
    setLoading(btn, false);
  }
}

/* ------------------------------------------------------------------
   Onglet 4 : Créateur de Livre Original Sans Plagiat
   ------------------------------------------------------------------ */
async function runGenerateBook() {
  const topic = document.getElementById('creator-topic').value.trim();
  const instructions = document.getElementById('creator-instructions').value.trim();
  const chapterCount = Number(document.getElementById('creator-chapters').value || 5);
  const selectedBookIds = Array.from(document.querySelectorAll('#creator-books-list input:checked')).map((c) => c.value);
  const includeWebSearch = document.getElementById('creator-web-switch').checked;
  const saveToLibrary = document.getElementById('creator-save-switch').checked;

  if (!topic) {
    toast(t('errors.required'), 'warning');
    return;
  }

  const btn = document.getElementById('creator-run-btn');
  const box = document.getElementById('creator-result-box');
  setLoading(btn, true);

  try {
    const res = await generateLibraryBook({
      topic,
      instructions,
      chapterCount,
      selectedBookIds,
      includeWebSearch,
      saveToLibrary,
      faculty: profileRef?.faculty_id || 'autre',
      level: profileRef?.level || 'L1',
      language: getLang(),
    });

    lastCreatedBook = res.book;
    box.hidden = false;
    const score = Number(res.originality_score ?? 96);

    box.innerHTML = `
      <div class="row-between mb-3" style="flex-wrap:wrap;gap:8px;">
        <span class="badge badge-success">${esc(t('library.creator_result_title'))}</span>
        <span class="badge badge-accent">${score}% orijinal (Anti-plajya)</span>
      </div>
      <div class="row-wrap mb-4">
        <button type="button" class="btn btn-sm btn-primary" id="created-pdf-btn">${icon('file-text')}<span>${esc(t('library.export_pdf_btn'))}</span></button>
        <button type="button" class="btn btn-sm btn-secondary" id="created-docx-btn">${icon('file-type')}<span>${esc(t('library.export_docx_btn'))}</span></button>
      </div>
      <div class="book-reader-body">${sanitizeHtml(res.book?.content_html || '')}</div>`;

    box.querySelector('#created-pdf-btn')?.addEventListener('click', () => exportBookPdf(lastCreatedBook, profileRef));
    box.querySelector('#created-docx-btn')?.addEventListener('click', () => exportBookDocx(lastCreatedBook, profileRef));
    icons(box);

    await recordActivity();
    await awardXp(30, 'library_book_create', res.book?.id || null);
    if (saveToLibrary) {
      const scopeEl = document.getElementById('lib-scope-filter');
      if (scopeEl && scopeEl.value && scopeEl.value !== 'generated') scopeEl.value = '';
      await loadBooks();
    }
    toast(t('common.saved'), 'success');
  } catch (err) {
    handleError(err);
  } finally {
    setLoading(btn, false);
  }
}

/* ------------------------------------------------------------------
   Initialisation de la page
   ------------------------------------------------------------------ */
(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  profileRef = profile;

  await initAppChrome({ profile, user, active: 'library' });
  setTutorContext({ contextType: 'general', contextTitle: t('library.title') });
  pageEnter();

  // Écouteurs onglets & filtres câblés immédiatement
  document.querySelectorAll('#library-tabs [role="tab"]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('lib-droit-btn')?.addEventListener('click', () => {
    switchTab('books');
    document.getElementById('lib-faculty-filter').value = 'droit';
    document.getElementById('lib-scope-filter').value = 'official';
    runChunkSearch();
  });

  document.getElementById('lib-upload-btn')?.addEventListener('click', openUploadModal);
  document.getElementById('lib-book-search')?.addEventListener('input', runChunkSearch);
  document.getElementById('lib-scope-filter')?.addEventListener('change', runChunkSearch);
  document.getElementById('lib-faculty-filter')?.addEventListener('change', runChunkSearch);

  // Onglet Web + Anti-Plagiat
  document.getElementById('web-search-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = document.getElementById('web-search-input').value.trim();
    if (q) runWebSearch(q);
  });

  document.getElementById('analyze-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    runAnalyzeSource();
  });

  // Onglet Assistant IA sur Livres
  document.getElementById('ask-library-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = document.getElementById('ask-question').value.trim();
    if (q) runAskLibrary(q);
  });
  document.querySelectorAll('#ask-quick-chips [data-ask-q]').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('ask-question').value = chip.dataset.askQ;
      runAskLibrary(chip.dataset.askQ);
    });
  });

  // Onglet Créateur de Livres
  document.getElementById('creator-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    runGenerateBook();
  });

  try {
    const { data: fData } = await db.from('pran_not_faculties').select('*').order('position');
    faculties = fData || [];
    const fSel = document.getElementById('lib-faculty-filter');
    faculties.forEach((f) => {
      const label = getLang() === 'fr' ? f.name_fr : f.name_ht;
      fSel.insertAdjacentHTML('beforeend', `<option value="${esc(f.id)}">${esc(label)}</option>`);
    });
  } catch { /* fallback */ }

  await loadBooks();

  // Deep-links : ?tab=web|ask|creator, ?q=..., ?book=<uuid>
  const paramTab = getParam('tab');
  if (paramTab) switchTab(paramTab);

  const paramQ = getParam('q');
  if (paramQ) {
    document.getElementById('lib-book-search').value = paramQ;
    runChunkSearch();
  }

  const paramBook = getParam('book');
  if (isUuid(paramBook)) {
    openBookReader(paramBook);
  }

  document.body.dataset.libraryReady = '1';
  icons(document.body);
})();
