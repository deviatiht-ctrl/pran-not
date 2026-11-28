/* =====================================================================
   PRAN NÒT - pages/notes.js
   Liste des notes avec filtres, recherche, pagination et cache hors-ligne.
   ===================================================================== */
import '../supabase.js';
import { requireAuth } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, formatRelative, formatDate, getLang } from '../i18n.js';
import {
  icons, icon, esc, emptyState, debounce, animateIn, pageEnter, handleError, confirmDialog, openModal, toast, setLoading, htmlToText,
} from '../utils.js';
import { cacheSet, cacheGet, cacheEntriesByPrefix, getQueueItems, updateQueuedNotePayload, removeQueueItem, enqueue, isNetworkError } from '../offline.js';
import { mergeCourseSchedules } from '../notifications.js';
import { openReceiveTransferModal, openExamRevisionModal } from '../live-transfer.js';
import { batchPrintNotes } from '../export.js';

const db = window.db;
const PAGE_SIZE = 18;
let allNotes = [];
let coursesMap = new Map();
let page = 0;
let hasMore = false;
let currentUserRef = null;
let currentProfileRef = null;

let isBatchMode = false;
let selectedNoteIds = new Set();

function updateBatchUI() {
  const batchBar = document.getElementById('notes-batch-bar');
  const countBadge = document.getElementById('batch-selected-count');
  const batchBtn = document.getElementById('notes-batch-mode-btn');

  if (batchBar) batchBar.hidden = !isBatchMode;
  if (countBadge) {
    const isFr = getLang() === 'fr';
    const c = selectedNoteIds.size;
    countBadge.textContent = isFr
      ? `${c} ${c > 1 ? 'notes sélectionnées' : 'note sélectionnée'}`
      : `${c} nòt chwazi`;
  }
  if (batchBtn) {
    if (isBatchMode) {
      batchBtn.classList.add('btn-primary');
      batchBtn.classList.remove('btn-outline');
    } else {
      batchBtn.classList.remove('btn-primary');
      batchBtn.classList.add('btn-outline');
    }
  }
}

const modeIcons = { photo: 'camera', audio: 'mic', flash: 'zap', text: 'file-edit', import: 'upload' };

function renderList(append = false) {
  const grid = document.getElementById('notes-grid');
  const q = document.getElementById('notes-search').value.trim().toLowerCase();
  const cFilter = document.getElementById('notes-course-filter').value;
  const mFilter = document.getElementById('notes-mode-filter').value;
  const sFilter = document.getElementById('notes-status-filter')?.value || '';
  const dFilter = document.getElementById('notes-date-filter')?.value || '';
  const customDateVal = document.getElementById('notes-custom-date')?.value || '';

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterdayObj = new Date(Date.now() - 86400000);
  const yesterdayStr = yesterdayObj.toISOString().slice(0, 10);
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  const thirtyDaysAgo = Date.now() - 30 * 86400000;

  const filtered = allNotes.filter((n) => {
    if (cFilter && n.course_id !== cFilter) return false;
    if (mFilter && n.capture_mode !== mFilter) return false;
    if (sFilter) {
      const noteStatus = n.status || (n.is_local_pending || n.is_local_draft ? 'draft' : 'ready');
      const isDraftLike = noteStatus === 'draft' || noteStatus === 'queued' || n.is_local_draft || n.is_local_pending;
      if (sFilter === 'ready' && isDraftLike) return false;
      if (sFilter === 'draft' && !isDraftLike) return false;
    }
    if (dFilter) {
      const noteDate = new Date(n.created_at || n.updated_at || Date.now());
      const noteDateStr = !isNaN(noteDate) ? noteDate.toISOString().slice(0, 10) : '';
      const noteTime = !isNaN(noteDate) ? noteDate.getTime() : 0;
      if (dFilter === 'today' && noteDateStr !== todayStr) return false;
      if (dFilter === 'yesterday' && noteDateStr !== yesterdayStr) return false;
      if (dFilter === 'last7' && noteTime < sevenDaysAgo) return false;
      if (dFilter === 'last30' && noteTime < thirtyDaysAgo) return false;
      if (dFilter === 'custom' && customDateVal && noteDateStr !== customDateVal) return false;
    }
    if (q) {
      const courseName = coursesMap.get(n.course_id)?.name || '';
      const hay = `${n.title || ''} ${n.summary || ''} ${n.content_text || ''} ${n.raw_text || ''} ${courseName}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    grid.className = '';
    grid.innerHTML = emptyState({
      icon: 'notebook-pen',
      title: t('notes.empty_title'),
      text: t('notes.empty_text'),
      action: `<a class="btn btn-primary" href="./note-capture.html?new=1">${icon('plus')}<span>${esc(t('notes.new'))}</span></a>`,
    });
    icons(grid);
    return;
  }

  grid.className = 'grid grid-3';
  const html = filtered.map((n) => {
    const course = coursesMap.get(n.course_id);
    const ic = modeIcons[n.capture_mode] || 'file-text';
    const noteStatus = n.status || (n.is_local_pending || n.is_local_draft ? 'draft' : 'ready');
    const isDraft = noteStatus === 'draft';
    const linkTarget = n.is_local_draft && n.draft_target
      ? n.draft_target
      : `./note-view.html?id=${esc(encodeURIComponent(n.id))}`;

    return `<article class="card card-sm ${isBatchMode && selectedNoteIds.has(n.id) ? 'card-accent' : ''}" style="display:flex;flex-direction:column;gap:10px;">
      <div class="row-between">
        <div class="row-wrap" style="gap:6px;align-items:center;">
          ${isBatchMode ? `
            <input type="checkbox" class="note-batch-cb" data-batch-id="${esc(n.id)}" ${selectedNoteIds.has(n.id) ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer;accent-color:var(--c-primary);">
          ` : ''}
          <span class="badge">${icon(ic)}<span>${esc(t(`capture.mode_${n.capture_mode}`) || n.capture_mode)}</span></span>
          ${isDraft ? `<span class="badge badge-warning">${icon('file-edit')}<span>${esc(n.is_local_draft ? (t('notes.local_draft') || 'Bwouyon lokal') : (t('notes.status_draft') || 'Bwouyon'))}</span></span>` : `<span class="badge badge-success">${icon('check-circle')}<span>${esc(t('notes.status_ready') || (getLang() === 'fr' ? 'Terminée' : 'Fini'))}</span></span>`}
          ${n.is_local_pending ? `<span class="badge badge-warning">${icon('wifi-off')}<span>${getLang() === 'fr' ? 'Local' : 'Lokal'}</span></span>` : ''}
        </div>
        <div class="row" style="gap:4px;">
          ${n.is_local_draft ? `
            <a href="${esc(n.draft_target || './note-capture.html')}" class="btn-icon" aria-label="${esc(t('common.edit'))}" title="${esc(t('common.edit'))}">
              ${icon('edit-3')}
            </a>
            <button type="button" class="btn-icon text-error" data-del-draft="${esc(n.id)}" aria-label="${esc(t('common.delete'))}" title="${esc(t('notes.delete_draft_tooltip'))}">
              ${icon('trash-2')}
            </button>
          ` : n.is_local_pending ? `
            <button type="button" class="btn-icon text-error" data-del-pending="${esc(n.id)}" aria-label="${esc(t('common.delete'))}" title="${esc(t('notes.delete_pending_tooltip'))}">
              ${icon('trash-2')}
            </button>
          ` : `
            <a href="./note-capture.html?id=${esc(encodeURIComponent(n.id))}&edit=1" class="btn-icon" aria-label="${esc(t('common.edit'))}" title="${esc(t('common.edit'))}">
              ${icon('edit-3')}
            </a>
            <button type="button" class="btn-icon" data-print-single="${esc(n.id)}" aria-label="${esc(t('notes.btn_print') || 'Imprimer')}" title="${esc(t('notes.btn_print_title') || 'Imprimer cette note (PDF)')}">
              ${icon('printer')}
            </button>
            <button type="button" class="btn-icon" data-pin="${esc(n.id)}" aria-label="Pin" title="Pin">
              ${icon(n.is_pinned ? 'bookmark-check' : 'bookmark')}
            </button>
            <button type="button" class="btn-icon" data-del="${esc(n.id)}" aria-label="${esc(t('common.delete'))}">
              ${icon('trash-2')}
            </button>
          `}
        </div>
      </div>
      <a href="${linkTarget}" style="text-decoration:none;flex:1;">
        <h3 class="card-title line-clamp-2">${esc(n.title || t('notes.untitled'))}</h3>
        <p class="text-sm muted line-clamp-3 mb-0">${esc(n.summary || n.content_text || '')}</p>
      </a>
      <div class="row-between card-meta pt-2" style="border-top:1px solid var(--c-border);">
        <button type="button" class="btn btn-sm btn-ghost" data-assign-course="${esc(n.id)}" style="padding:2px 8px;min-height:28px;font-size:12px;">
          ${course
            ? `<span class="course-dot" style="background:${esc(course.color || '#F97316')}"></span><span>${esc(course.name)}</span>`
            : `${icon('folder-plus')}<span>${esc(t('notes.assign_course'))}</span>`}
        </button>
        <div class="row" style="gap:6px;">
          ${n.is_local_draft ? `<a href="${esc(n.draft_target || './note-capture.html')}" class="badge badge-xs badge-outline" style="text-decoration:none;">${getLang() === 'fr' ? 'Cliquer pour continuer' : 'Klike pou kontinye'}</a>` : ''}
          <span class="text-xs" title="${esc(new Date(n.created_at || n.updated_at).toLocaleString())}">
            <strong style="color:var(--c-text);">${esc(formatDate(n.created_at || n.updated_at))}</strong> · ${esc(formatRelative(n.updated_at || n.created_at))}
          </span>
        </div>
      </div>
    </article>`;
  }).join('');

  if (append) grid.insertAdjacentHTML('beforeend', html);
  else grid.innerHTML = html;

  grid.querySelectorAll('.note-batch-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.batchId;
      if (cb.checked) selectedNoteIds.add(id);
      else selectedNoteIds.delete(id);
      updateBatchUI();
      cb.closest('article')?.classList.toggle('card-accent', cb.checked);
    });
  });

  grid.querySelectorAll('[data-print-single]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.printSingle;
      const target = allNotes.find((x) => x.id === id);
      if (target) {
        batchPrintNotes([target], coursesMap, currentProfileRef);
      }
    });
  });

  grid.querySelectorAll('[data-del-draft]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delDraft;
      const ok = await confirmDialog({
        title: t('common.delete'),
        message: t('notes.discard_draft_confirm'),
        danger: true,
      });
      if (!ok) return;
      if (id === 'draft:capture') {
        localStorage.removeItem('prannot_note_capture_draft');
      } else if (id === 'draft:live') {
        localStorage.removeItem('prannot.liveClassDraft');
      } else if (id.startsWith('draft:hist:')) {
        const idx = Number(id.replace('draft:hist:', ''));
        try {
          const hist = JSON.parse(localStorage.getItem('prannot.draft_history') || '[]');
          hist.splice(idx, 1);
          localStorage.setItem('prannot.draft_history', JSON.stringify(hist));
        } catch {}
      } else if (id.startsWith('draft:other:')) {
        const k = id.replace('draft:other:', '');
        localStorage.removeItem(k);
      }
      allNotes = allNotes.filter((x) => x.id !== id);
      toast(t('common.deleted'), 'success');
      renderList();
    });
  });

  grid.querySelectorAll('[data-del-pending]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delPending;
      const ok = await confirmDialog({
        title: t('common.delete'),
        message: t('notes.delete_pending_confirm'),
        danger: true,
      });
      if (!ok) return;
      const queueId = id.replace('local:', '');
      await removeQueueItem(queueId);
      allNotes = allNotes.filter((x) => x.id !== id);
      toast(t('common.deleted'), 'success');
      renderList();
    });
  });

  grid.querySelectorAll('[data-pin]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.pin;
      const item = allNotes.find((x) => x.id === id);
      if (!item) return;
      const next = !item.is_pinned;
      item.is_pinned = next;
      const { error } = await db.from('pran_not_notes').update({ is_pinned: next }).eq('id', id);
      if (error) handleError(error);
      else renderList();
    });
  });

  grid.querySelectorAll('[data-assign-course]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = allNotes.find((x) => x.id === btn.dataset.assignCourse);
      if (target) openQuickAssignModal(target);
    });
  });

  grid.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.del;
      const ok = await confirmDialog({ title: t('common.delete'), message: t('common.confirm_title'), danger: true });
      if (!ok) return;
      const { error } = await db.from('pran_not_notes').delete().eq('id', id);
      if (error) handleError(error);
      else {
        allNotes = allNotes.filter((x) => x.id !== id);
        toast(t('common.deleted'), 'success');
        renderList();
      }
    });
  });

  document.getElementById('notes-pagination').hidden = !hasMore;
  icons(grid);
  animateIn('#notes-grid article');
}

function openQuickAssignModal(noteItem) {
  const coursesList = Array.from(coursesMap.values());
  if (!coursesList.length) {
    toast(t('courses.empty_title'), 'info');
    return;
  }
  const m = openModal({
    title: t('notes.assign_course_title'),
    body: `
      <p class="text-sm muted mb-3">${esc(noteItem.title || t('notes.untitled'))}</p>
      <div class="field">
        <label for="quick-assign-sel">${esc(t('capture.course'))}</label>
        <select class="select" id="quick-assign-sel">
          <option value="">${esc(t('common.no_course'))}</option>
          ${coursesList.map((c) => `<option value="${esc(c.id)}" ${noteItem.course_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>`,
    footer: `<button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
             <button type="button" class="btn btn-primary" id="quick-assign-save">${esc(t('common.save'))}</button>`,
  });
  const saveBtn = m.el.querySelector('#quick-assign-save');
  saveBtn.addEventListener('click', async () => {
    const newCourseId = m.el.querySelector('#quick-assign-sel').value || null;
    setLoading(saveBtn, true);
    const updateLocal = async () => {
      noteItem.course_id = newCourseId;
      if (noteItem.is_local_draft) {
        if (noteItem.id === 'draft:capture') {
          try {
            const raw = localStorage.getItem('prannot_note_capture_draft');
            if (raw) {
              const d = JSON.parse(raw);
              d.courseId = newCourseId;
              localStorage.setItem('prannot_note_capture_draft', JSON.stringify(d));
            }
          } catch {}
        } else if (noteItem.id === 'draft:live') {
          try {
            const raw = localStorage.getItem('prannot.liveClassDraft');
            if (raw) {
              const d = JSON.parse(raw);
              d.courseId = newCourseId;
              localStorage.setItem('prannot.liveClassDraft', JSON.stringify(d));
            }
          } catch {}
        }
      } else if (noteItem.is_local_pending) {
        await updateQueuedNotePayload(noteItem.id.slice('local:'.length), { course_id: newCourseId });
      } else {
        await enqueue('note_update', { note_id: noteItem.id, course_id: newCourseId });
        const cachedNote = await cacheGet(`note_${noteItem.id}`);
        if (cachedNote) await cacheSet(`note_${noteItem.id}`, { ...cachedNote, course_id: newCourseId });
      }
      await cacheSet('notes_list', allNotes.filter((n) => !n.is_local_pending && !n.is_local_draft));
      toast(t('offline.saved_locally'), 'info');
      m.close();
      renderList();
    };

    if (noteItem.is_local_draft || noteItem.is_local_pending || !navigator.onLine) {
      await updateLocal();
      return;
    }

    try {
      const { error } = await db.from('pran_not_notes').update({ course_id: newCourseId }).eq('id', noteItem.id);
      if (error) throw error;
      noteItem.course_id = newCourseId;
      const cachedNote = await cacheGet(`note_${noteItem.id}`);
      if (cachedNote) await cacheSet(`note_${noteItem.id}`, { ...cachedNote, course_id: newCourseId });
      await cacheSet('notes_list', allNotes.filter((n) => !n.is_local_pending));
      toast(t('notes.course_assigned'), 'success');
      m.close();
      renderList();
    } catch (err) {
      if (isNetworkError(err)) await updateLocal();
      else {
        handleError(err);
        setLoading(saveBtn, false);
      }
    }
  });
}

function getLocalStorageDrafts() {
  const drafts = [];
  const resolveTitle = (rawTitle, courseId, sampleText = '') => {
    if (rawTitle && rawTitle.trim()) return rawTitle.trim();
    if (courseId && coursesMap.has(courseId)) {
      return `${coursesMap.get(courseId).name} (Bwouyon)`;
    }
    const cleanSample = (sampleText || '').replace(/<[^>]+>/g, '').trim();
    const firstLine = cleanSample.split('\n')[0].trim();
    if (firstLine && firstLine.length > 2 && firstLine.length < 90) {
      return `${firstLine} (Bwouyon)`;
    }
    return t('notes.status_draft_unfinished');
  };

  try {
    const rawCapture = localStorage.getItem('prannot_note_capture_draft');
    if (rawCapture) {
      const d = JSON.parse(rawCapture);
      const cleanRaw = (d?.rawText || '').trim();
      const cleanHtml = (d?.quillHtml || '').trim();
      const strippedHtml = cleanHtml ? htmlToText(cleanHtml).trim() : '';
      const hasContent = Boolean(d?.title?.trim() || cleanRaw || strippedHtml || d?.structuredData);
      if (hasContent) {
        const title = resolveTitle(d?.title, d?.courseId, cleanRaw || strippedHtml);
        drafts.push({
          id: 'draft:capture',
          title,
          summary: cleanRaw ? cleanRaw.slice(0, 200) : (strippedHtml ? strippedHtml.slice(0, 200) : t('notes.local_draft_item')),
          content_text: cleanRaw || strippedHtml || '',
          course_id: d.courseId || null,
          capture_mode: d.currentMode || 'text',
          status: 'draft',
          is_pinned: false,
          is_local_draft: true,
          draft_target: './note-capture.html',
          created_at: new Date(d.savedAt || Date.now()).toISOString(),
          updated_at: new Date(d.savedAt || Date.now()).toISOString(),
        });
      }
    }
  } catch {}

  try {
    const rawLive = localStorage.getItem('prannot.liveClassDraft');
    if (rawLive) {
      const d = JSON.parse(rawLive);
      const cleanBody = (d?.body || '').trim();
      const cleanThoughts = (d?.thoughts || '').trim();
      const hasHw = Array.isArray(d?.homework) && d.homework.length > 0;
      const hasContent = Boolean(d?.title?.trim() || cleanBody || cleanThoughts || hasHw);
      if (hasContent) {
        const fullText = [cleanBody, cleanThoughts ? `Panse: ${cleanThoughts}` : ''].filter(Boolean).join('\n\n');
        const title = resolveTitle(d?.title, d?.courseId, fullText);
        drafts.push({
          id: 'draft:live',
          title,
          summary: fullText ? fullText.slice(0, 200) : (hasHw ? `${d.homework.length} devwa an kou` : 'Kou an dirèk'),
          content_text: fullText || '',
          course_id: d.courseId || null,
          capture_mode: 'audio',
          status: 'draft',
          is_pinned: false,
          is_local_draft: true,
          draft_target: `./live-class.html?course=${encodeURIComponent(d.courseId || '')}&restore=1`,
          created_at: new Date(d.savedAt || Date.now()).toISOString(),
          updated_at: new Date(d.savedAt || Date.now()).toISOString(),
        });
      }
    }
  } catch {}

  // Bwouyon achive ki te sove nan memwa
  try {
    const rawHist = localStorage.getItem('prannot.draft_history');
    if (rawHist) {
      const hist = JSON.parse(rawHist);
      if (Array.isArray(hist)) {
        hist.forEach((d, idx) => {
          const cleanRaw = (d?.rawText || d?.body || '').trim();
          const cleanThoughts = (d?.thoughts || '').trim();
          const fullText = [cleanRaw, cleanThoughts ? `Panse: ${cleanThoughts}` : ''].filter(Boolean).join('\n\n');
          const cleanHtml = (d?.quillHtml || '').trim();
          const strippedHtml = cleanHtml ? htmlToText(cleanHtml).trim() : '';
          const hasContent = Boolean(d?.title?.trim() || fullText || strippedHtml);
          if (hasContent) {
            const isLive = d?.source === 'live' || d?.kind === 'live';
            const title = resolveTitle(d?.title, d?.courseId, fullText || strippedHtml);
            drafts.push({
              id: `draft:hist:${idx}`,
              title,
              summary: fullText ? fullText.slice(0, 200) : (strippedHtml ? strippedHtml.slice(0, 200) : 'Bwouyon achive'),
              content_text: fullText || strippedHtml || '',
              course_id: d.courseId || null,
              capture_mode: isLive ? 'audio' : (d.currentMode || 'text'),
              status: 'draft',
              is_pinned: false,
              is_local_draft: true,
              draft_target: isLive
                ? `./live-class.html?course=${encodeURIComponent(d.courseId || '')}&histIdx=${idx}`
                : `./note-capture.html?restoreDraft=${encodeURIComponent(`draft:hist:${idx}`)}`,
              created_at: new Date(d.archivedAt || d.savedAt || Date.now()).toISOString(),
              updated_at: new Date(d.archivedAt || d.savedAt || Date.now()).toISOString(),
            });
          }
        });
      }
    }
  } catch {}

  // Tcheke nenpòt lòt kle ki gen rapò ak bwouyon
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k === 'prannot_note_capture_draft' || k === 'prannot.liveClassDraft' || k === 'prannot.draft_history') continue;
      if (k.toLowerCase().includes('draft') || k.toLowerCase().includes('brouillon') || k.toLowerCase().includes('not_capture')) {
        const val = localStorage.getItem(k);
        if (val && val.startsWith('{')) {
          try {
            const parsed = JSON.parse(val);
            const text = (parsed.rawText || parsed.body || parsed.quillHtml || parsed.content || '').trim();
            if (text || parsed.title) {
              const title = resolveTitle(parsed.title, parsed.courseId, text);
              drafts.push({
                id: `draft:other:${k}`,
                title,
                summary: text.slice(0, 200),
                content_text: text,
                course_id: parsed.courseId || null,
                capture_mode: 'text',
                status: 'draft',
                is_pinned: false,
                is_local_draft: true,
                draft_target: `./note-capture.html?restoreDraft=${encodeURIComponent(`draft:other:${k}`)}`,
                created_at: new Date(parsed.savedAt || Date.now()).toISOString(),
                updated_at: new Date(parsed.savedAt || Date.now()).toISOString(),
              });
            }
          } catch {}
        }
      }
    }
  } catch {}

  return drafts;
}

async function getCachedIndividualNotes() {
  try {
    const entries = await cacheEntriesByPrefix('note_');
    return (entries || [])
      .map((e) => e.data)
      .filter((n) => n && n.id && (!currentUserRef?.id || !n.user_id || n.user_id === currentUserRef.id));
  } catch {
    return [];
  }
}

function mergeNotesList(lists = []) {
  const map = new Map();
  lists.forEach((list) => {
    (list || []).forEach((n) => {
      if (n && n.id && !map.has(n.id)) {
        map.set(n.id, n);
      }
    });
  });
  return Array.from(map.values());
}

async function getPendingNotes() {
  const qItems = await getQueueItems();
  return qItems
    .filter((x) => x.kind === 'note' && x.payload)
    .map((x) => {
      const pStatus = x.payload.status || 'ready';
      return {
        id: `local:${x.id}`,
        title: x.payload.title || t('notes.untitled'),
        summary: (x.payload.content_text || '').slice(0, 200),
        content_text: x.payload.content_text || '',
        raw_text: x.payload.raw_text || '',
        course_id: x.payload.course_id || null,
        capture_mode: x.payload.capture_mode || 'text',
        status: pStatus === 'draft' ? 'draft' : 'ready',
        is_pinned: false,
        is_local_pending: true,
        created_at: new Date(x.createdAt).toISOString(),
        updated_at: new Date(x.createdAt).toISOString(),
      };
    })
    .reverse();
}

function populateCoursesFilter(cData) {
  const cSel = document.getElementById('notes-course-filter');
  const prev = cSel.value;
  cSel.innerHTML = `<option value="" data-i18n="notes.filter_course">${esc(t('notes.filter_course'))}</option>`;
  coursesMap.clear();
  (cData || []).forEach((c) => {
    coursesMap.set(c.id, c);
    cSel.insertAdjacentHTML('beforeend', `<option value="${esc(c.id)}">${esc(c.name)}</option>`);
  });
  if (prev && coursesMap.has(prev)) cSel.value = prev;
}

async function fetchNotes(reset = true) {
  if (reset) { page = 0; }
  const localDrafts = getLocalStorageDrafts();
  const pending = await getPendingNotes();
  const cachedIndiv = await getCachedIndividualNotes();
  const topItems = [...localDrafts, ...pending];
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  const userNotesCacheKey = currentUserRef ? `notes_list_${currentUserRef.id}` : 'notes_list';

  if (!navigator.onLine) {
    if (reset) {
      const cached = (await cacheGet(userNotesCacheKey)) || [];
      allNotes = mergeNotesList([topItems, cachedIndiv, cached]);
      hasMore = false;
    }
    renderList();
    return;
  }

  try {
    let query = db
      .from('pran_not_notes')
      .select('id, title, summary, content_html, content_text, raw_text, structured, course_id, capture_mode, is_pinned, status, created_at, updated_at');

    // Toujou filtre strikteman pa user_id pou garanti vi prive chak etidyan menm si kont lan ta admin
    if (currentUserRef?.id) {
      query = query.eq('user_id', currentUserRef.id);
    }

    const { data, error } = await query
      .order('is_pinned', { ascending: false })
      .order('updated_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
    hasMore = (data || []).length === PAGE_SIZE;
    const remote = reset ? (data || []) : [...allNotes.filter((n) => !n.is_local_pending && !n.is_local_draft), ...(data || [])];
    await cacheSet(userNotesCacheKey, remote);
    allNotes = mergeNotesList([topItems, cachedIndiv, remote]);
  } catch (err) {
    if (reset) {
      const cached = (await cacheGet(userNotesCacheKey)) || [];
      allNotes = mergeNotesList([topItems, cachedIndiv, cached]);
    }
    if (!allNotes.length) handleError(err);
  }
  renderList();
}

(async () => {
  const { user, profile } = await requireAuth();
  currentUserRef = user;
  currentProfileRef = profile;
  await initAppChrome({ profile, user, active: 'notes' });
  setTutorContext({ contextType: 'general', contextTitle: t('notes.title') });
  pageEnter();

  const userNotesCacheKey = `notes_list_${user.id}`;
  const userCoursesCacheKey = `courses_list_${user.id}`;

  // Affichage immédiat depuis le cache local (< 5 ms), puis actualisation si en ligne
  const [cachedCourses, cachedNotes, pendingNotes, cachedIndiv] = await Promise.all([
    cacheGet(userCoursesCacheKey).then((c) => c || cacheGet('courses_list')),
    cacheGet(userNotesCacheKey),
    getPendingNotes(),
    getCachedIndividualNotes(),
  ]);
  const localDrafts = getLocalStorageDrafts();
  const cleanCourses = (cachedCourses || []).filter((c) => !c.user_id || c.user_id === user.id);
  const cleanNotes = (cachedNotes || []).filter((n) => !n.user_id || n.user_id === user.id);
  const cleanIndiv = (cachedIndiv || []).filter((n) => !n.user_id || n.user_id === user.id);

  if (cleanCourses.length) populateCoursesFilter(cleanCourses);
  allNotes = mergeNotesList([localDrafts, pendingNotes, cleanIndiv, cleanNotes]);
  if (allNotes.length) renderList();

  if (navigator.onLine) {
    db.from('pran_not_courses')
      .select('*')
      .eq('user_id', user.id)
      .eq('archived', false)
      .order('name')
      .then(async ({ data: cData }) => {
        if (cData) {
          const merged = mergeCourseSchedules(cData);
          populateCoursesFilter(merged);
          await cacheSet(userCoursesCacheKey, merged);
          await cacheSet('courses_list', merged);
        }
      })
      .catch(() => {});
  }

  await fetchNotes(true);

  document.getElementById('notes-receive-btn')?.addEventListener('click', () => {
    openReceiveTransferModal(() => fetchNotes(true));
  });

  document.getElementById('notes-exam-btn')?.addEventListener('click', () => {
    openExamRevisionModal({ courses: Array.from(coursesMap.values()) });
  });

  document.getElementById('notes-search').addEventListener('input', debounce(() => renderList(), 200));
  document.getElementById('notes-course-filter').addEventListener('change', () => renderList());
  document.getElementById('notes-mode-filter').addEventListener('change', () => renderList());
  document.getElementById('notes-status-filter')?.addEventListener('change', () => renderList());

  const dateFilter = document.getElementById('notes-date-filter');
  const customDateInput = document.getElementById('notes-custom-date');
  dateFilter?.addEventListener('change', () => {
    if (dateFilter.value === 'custom') {
      if (customDateInput) customDateInput.style.display = 'inline-block';
    } else {
      if (customDateInput) {
        customDateInput.style.display = 'none';
        customDateInput.value = '';
      }
    }
    renderList();
  });
  customDateInput?.addEventListener('change', () => renderList());

  // Boutons mòd seleksyon pou enprime an pakèt
  document.getElementById('notes-batch-mode-btn')?.addEventListener('click', () => {
    isBatchMode = !isBatchMode;
    if (!isBatchMode) selectedNoteIds.clear();
    updateBatchUI();
    renderList();
    if (isBatchMode) {
      toast('Mòd seleksyon aktive : klike sou kaz nòt ou vle enprime yo.', 'info');
    }
  });

  document.getElementById('batch-select-all')?.addEventListener('click', () => {
    allNotes.forEach((n) => selectedNoteIds.add(n.id));
    updateBatchUI();
    renderList();
  });

  document.getElementById('batch-deselect-all')?.addEventListener('click', () => {
    selectedNoteIds.clear();
    updateBatchUI();
    renderList();
  });

  document.getElementById('btn-batch-cancel')?.addEventListener('click', () => {
    isBatchMode = false;
    selectedNoteIds.clear();
    updateBatchUI();
    renderList();
  });

  document.getElementById('btn-batch-print')?.addEventListener('click', () => {
    if (!selectedNoteIds.size) {
      toast('Tanpri chwazi omwen yon nòt pou w ka enprime !', 'warning');
      return;
    }
    const selectedNotes = allNotes.filter((n) => selectedNoteIds.has(n.id));
    toast(`Preparasyon ${selectedNotes.length} nòt pou enpresyon / PDF...`, 'info');
    batchPrintNotes(selectedNotes, coursesMap, currentProfileRef);
  });

  document.getElementById('load-more-btn').addEventListener('click', () => {
    page++;
    fetchNotes(false);
  });
})();
