/* =====================================================================
   PRAN NÒT - pages/notes.js
   Liste des notes avec filtres, recherche, pagination et cache hors-ligne.
   ===================================================================== */
import '../supabase.js';
import { requireAuth } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, formatRelative } from '../i18n.js';
import {
  icons, icon, esc, emptyState, debounce, animateIn, pageEnter, handleError, confirmDialog, toast,
} from '../utils.js';
import { cacheSet, cacheGet } from '../offline.js';

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

  const filtered = allNotes.filter((n) => {
    if (cFilter && n.course_id !== cFilter) return false;
    if (mFilter && n.capture_mode !== mFilter) return false;
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
      action: `<a class="btn btn-primary" href="./note-capture.html">${icon('plus')}<span>${esc(t('notes.new'))}</span></a>`,
    });
    icons(grid);
    return;
  }

  grid.className = 'grid grid-3';
  const html = filtered.map((n) => {
    const course = coursesMap.get(n.course_id);
    const ic = modeIcons[n.capture_mode] || 'file-text';
    return `<article class="card card-sm" style="display:flex;flex-direction:column;gap:10px;">
      <div class="row-between">
        <span class="badge">${icon(ic)}<span>${esc(t(`capture.mode_${n.capture_mode}`) || n.capture_mode)}</span></span>
        <div class="row" style="gap:4px;">
          <button type="button" class="btn-icon" data-pin="${esc(n.id)}" aria-label="Pin" title="Pin">
            ${icon(n.is_pinned ? 'bookmark-check' : 'bookmark')}
          </button>
          <button type="button" class="btn-icon" data-del="${esc(n.id)}" aria-label="${esc(t('common.delete'))}">
            ${icon('trash-2')}
          </button>
        </div>
      </div>
      <a href="./note-view.html?id=${esc(n.id)}" style="text-decoration:none;flex:1;">
        <h3 class="card-title line-clamp-2">${esc(n.title || t('notes.untitled'))}</h3>
        <p class="text-sm muted line-clamp-3 mb-0">${esc(n.summary || n.content_text || '')}</p>
      </a>
      <div class="row-between card-meta pt-2" style="border-top:1px solid var(--c-border);">
        <span class="row" style="gap:6px;">
          ${course ? `<span class="course-dot" style="background:${esc(course.color || '#F97316')}"></span><span>${esc(course.name)}</span>` : `<span>${esc(t('common.no_course'))}</span>`}
        </span>
        <span>${esc(formatRelative(n.updated_at || n.created_at))}</span>
      </div>
    </article>`;
  }).join('');

  if (append) grid.insertAdjacentHTML('beforeend', html);
  else grid.innerHTML = html;

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

async function fetchNotes(reset = true) {
  if (reset) { page = 0; allNotes = []; }
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  try {
    const { data, error } = await db
      .from('pran_not_notes')
      .select('id, title, summary, content_text, course_id, capture_mode, is_pinned, status, created_at, updated_at')
      .order('is_pinned', { ascending: false })
      .order('updated_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    hasMore = (data || []).length === PAGE_SIZE;
    allNotes = reset ? (data || []) : [...allNotes, ...(data || [])];
    await cacheSet('notes_list', allNotes);
  } catch (err) {
    if (reset) {
      allNotes = (await cacheGet('notes_list')) || [];
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

  try {
    const { data: cData } = await db.from('pran_not_courses').select('id, name, color').eq('archived', false).order('name');
    const cSel = document.getElementById('notes-course-filter');
    (cData || []).forEach((c) => {
      coursesMap.set(c.id, c);
      cSel.insertAdjacentHTML('beforeend', `<option value="${esc(c.id)}">${esc(c.name)}</option>`);
    });
  } catch { /* hors-ligne */ }

  await fetchNotes(true);

  document.getElementById('notes-search').addEventListener('input', debounce(() => renderList(), 200));
  document.getElementById('notes-course-filter').addEventListener('change', () => renderList());
  document.getElementById('notes-mode-filter').addEventListener('change', () => renderList());
  document.getElementById('load-more-btn').addEventListener('click', () => {
    page++;
    fetchNotes(false);
  });
})();
