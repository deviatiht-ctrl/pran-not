/* =====================================================================
   PRAN NÒT - pages/notes.js
   Liste des notes avec filtres, recherche, pagination et cache hors-ligne.
   ===================================================================== */
import '../supabase.js';
import { requireAuth } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, formatRelative } from '../i18n.js';
import {
  icons, icon, esc, emptyState, debounce, animateIn, pageEnter, handleError, confirmDialog, openModal, toast, setLoading, htmlToText,
} from '../utils.js';
import { cacheSet, cacheGet, getQueueItems, updateQueuedNotePayload, removeQueueItem, enqueue, isNetworkError } from '../offline.js';
import { mergeCourseSchedules } from '../notifications.js';
import { openReceiveTransferModal, openExamRevisionModal } from '../live-transfer.js';

const db = window.db;
const PAGE_SIZE = 18;
let allNotes = [];
let coursesMap = new Map();
let page = 0;
let hasMore = false;

const modeIcons = { photo: 'camera', audio: 'mic', flash: 'zap', text: 'file-edit', import: 'upload' };

function renderList(append = false) {
  const grid = document.getElementById('notes-grid');
  const q = document.getElementById('notes-search').value.trim().toLowerCase();
  const cFilter = document.getElementById('notes-course-filter').value;
  const mFilter = document.getElementById('notes-mode-filter').value;
  const sFilter = document.getElementById('notes-status-filter')?.value || '';

  const filtered = allNotes.filter((n) => {
    if (cFilter && n.course_id !== cFilter) return false;
    if (mFilter && n.capture_mode !== mFilter) return false;
    if (sFilter) {
      const noteStatus = n.status || (n.is_local_pending || n.is_local_draft ? 'draft' : 'ready');
      if (sFilter === 'ready' && noteStatus === 'draft') return false;
      if (sFilter === 'draft' && noteStatus !== 'draft') return false;
    }
    if (q) {
      const hay = `${n.title || ''} ${n.summary || ''} ${n.content_text || ''}`.toLowerCase();
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
    const linkTarget = n.is_local_draft
      ? esc(n.draft_target || './note-capture.html')
      : `./note-view.html?id=${esc(encodeURIComponent(n.id))}`;

    return `<article class="card card-sm" style="display:flex;flex-direction:column;gap:10px;">
      <div class="row-between">
        <div class="row-wrap" style="gap:6px;">
          <span class="badge">${icon(ic)}<span>${esc(t(`capture.mode_${n.capture_mode}`) || n.capture_mode)}</span></span>
          ${isDraft ? `<span class="badge badge-warning">${icon('file-edit')}<span>${esc(n.is_local_draft ? (t('notes.local_draft') || 'Bwouyon lokal') : 'Bwouyon')}</span></span>` : `<span class="badge badge-success">${icon('check-circle')}<span>Fini</span></span>`}
          ${n.is_local_pending ? `<span class="badge badge-warning">${icon('wifi-off')}<span>Lokal</span></span>` : ''}
        </div>
        <div class="row" style="gap:4px;">
          ${n.is_local_draft ? `
            <button type="button" class="btn-icon text-error" data-del-draft="${esc(n.id)}" aria-label="${esc(t('common.delete'))}" title="Efase bwouyon sa a">
              ${icon('trash-2')}
            </button>
          ` : n.is_local_pending ? `
            <button type="button" class="btn-icon text-error" data-del-pending="${esc(n.id)}" aria-label="${esc(t('common.delete'))}" title="Efase nòt lokal sa a">
              ${icon('trash-2')}
            </button>
          ` : `
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
          ${n.is_local_draft ? `<span class="badge badge-xs badge-outline">Klike pou kontinye</span>` : ''}
          <span>${esc(formatRelative(n.updated_at || n.created_at))}</span>
        </div>
      </div>
    </article>`;
  }).join('');

  if (append) grid.insertAdjacentHTML('beforeend', html);
  else grid.innerHTML = html;

  grid.querySelectorAll('[data-del-draft]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delDraft;
      const ok = await confirmDialog({
        title: t('common.delete'),
        message: t('notes.discard_draft_confirm') || 'Èske ou vle efase bwouyon sa a nèt?',
        danger: true,
      });
      if (!ok) return;
      if (id === 'draft:capture') {
        localStorage.removeItem('prannot_note_capture_draft');
      } else if (id === 'draft:live') {
        localStorage.removeItem('prannot.liveClassDraft');
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
        message: t('notes.delete_pending_confirm') || 'Èske ou vle efase nòt sa a ki nan memwa aparèy la?',
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
  try {
    const rawCapture = localStorage.getItem('prannot_note_capture_draft');
    if (rawCapture) {
      const d = JSON.parse(rawCapture);
      const cleanTitle = (d?.title || '').trim();
      const cleanRaw = (d?.rawText || '').trim();
      const cleanHtml = (d?.quillHtml || '').trim();
      const strippedHtml = cleanHtml ? htmlToText(cleanHtml).trim() : '';
      const hasContent = Boolean(cleanTitle || cleanRaw || strippedHtml || d?.structuredData);
      if (hasContent) {
        drafts.push({
          id: 'draft:capture',
          title: cleanTitle || t('notes.status_draft') || 'Bwouyon nòt ki poko fini',
          summary: cleanRaw ? cleanRaw.slice(0, 200) : (strippedHtml ? strippedHtml.slice(0, 200) : 'Bwouyon nòt an kou nan editè a'),
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
      const cleanTitle = (d?.title || '').trim();
      const cleanBody = (d?.body || '').trim();
      const cleanThoughts = (d?.thoughts || '').trim();
      const hasHw = Array.isArray(d?.homework) && d.homework.length > 0;
      const hasContent = Boolean(cleanTitle || cleanBody || cleanThoughts || hasHw);
      if (hasContent) {
        drafts.push({
          id: 'draft:live',
          title: cleanTitle || 'Bwouyon kou an dirèk',
          summary: cleanBody ? cleanBody.slice(0, 200) : (cleanThoughts ? cleanThoughts.slice(0, 200) : 'Kou an dirèk an kou'),
          content_text: cleanBody || cleanThoughts || '',
          course_id: d.courseId || null,
          capture_mode: 'audio',
          status: 'draft',
          is_pinned: false,
          is_local_draft: true,
          draft_target: './live-class.html',
          created_at: new Date(d.savedAt || Date.now()).toISOString(),
          updated_at: new Date(d.savedAt || Date.now()).toISOString(),
        });
      }
    }
  } catch {}

  return drafts;
}

async function getPendingNotes() {
  const qItems = await getQueueItems();
  return qItems
    .filter((x) => x.kind === 'note' && x.payload)
    .map((x) => ({
      id: `local:${x.id}`,
      title: x.payload.title || t('notes.untitled'),
      summary: (x.payload.content_text || '').slice(0, 200),
      content_text: x.payload.content_text || '',
      course_id: x.payload.course_id || null,
      capture_mode: x.payload.capture_mode || 'text',
      is_pinned: false,
      is_local_pending: true,
      created_at: new Date(x.createdAt).toISOString(),
      updated_at: new Date(x.createdAt).toISOString(),
    }))
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
  const topItems = [...localDrafts, ...pending];
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  if (!navigator.onLine) {
    if (reset) {
      const cached = (await cacheGet('notes_list')) || [];
      allNotes = [...topItems, ...cached];
      hasMore = false;
    }
    renderList();
    return;
  }

  try {
    const { data, error } = await db
      .from('pran_not_notes')
      .select('id, title, summary, content_text, course_id, capture_mode, is_pinned, status, created_at, updated_at')
      .order('is_pinned', { ascending: false })
      .order('updated_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    hasMore = (data || []).length === PAGE_SIZE;
    const remote = reset ? (data || []) : [...allNotes.filter((n) => !n.is_local_pending && !n.is_local_draft), ...(data || [])];
    await cacheSet('notes_list', remote);
    allNotes = reset ? [...topItems, ...remote] : [...allNotes, ...(data || [])];
  } catch (err) {
    if (reset) {
      const cached = (await cacheGet('notes_list')) || [];
      allNotes = [...topItems, ...cached];
    }
    if (!allNotes.length) handleError(err);
  }
  renderList();
}

(async () => {
  const { user, profile } = await requireAuth();
  await initAppChrome({ profile, user, active: 'notes' });
  setTutorContext({ contextType: 'general', contextTitle: t('notes.title') });
  pageEnter();

  // Affichage immédiat depuis le cache local (< 5 ms), puis actualisation si en ligne
  const [cachedCourses, cachedNotes, pendingNotes] = await Promise.all([
    cacheGet('courses_list'),
    cacheGet('notes_list'),
    getPendingNotes(),
  ]);
  const localDrafts = getLocalStorageDrafts();
  if (cachedCourses?.length) populateCoursesFilter(cachedCourses);
  if (localDrafts.length || pendingNotes.length || cachedNotes?.length) {
    allNotes = [...localDrafts, ...pendingNotes, ...(cachedNotes || [])];
    renderList();
  }

  if (navigator.onLine) {
    db.from('pran_not_courses').select('*').eq('archived', false).order('name')
      .then(async ({ data: cData }) => {
        if (cData) {
          const merged = mergeCourseSchedules(cData);
          populateCoursesFilter(merged);
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
  document.getElementById('load-more-btn').addEventListener('click', () => {
    page++;
    fetchNotes(false);
  });
})();
