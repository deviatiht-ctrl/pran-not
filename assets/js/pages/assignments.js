/* =====================================================================
   PRAN NÒT - pages/assignments.js
   Liste et création des devoirs avec suivi des échéances.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, appUrl } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, formatDate, formatRelative } from '../i18n.js';
import {
  icons, icon, esc, emptyState, openModal, confirmDialog, toast, handleError, setLoading, getParam, animateIn, pageEnter,
} from '../utils.js';
import { cacheSet, cacheGet } from '../offline.js';

const db = window.db;
let userRef = null;
let courses = [];
let assignments = [];
let statusFilter = '';

function statusBadge(s) {
  const cls = s === 'done' || s === 'submitted' ? 'badge-success' : s === 'in_progress' ? 'badge-info' : 'badge-warning';
  return `<span class="badge ${cls}">${esc(t(`assignments.status_${s}`))}</span>`;
}

function renderList() {
  const grid = document.getElementById('assignments-grid');
  const rows = assignments.filter((a) => !statusFilter || a.status === statusFilter);

  if (!rows.length) {
    grid.className = '';
    grid.innerHTML = emptyState({
      icon: 'clipboard-list',
      title: t('assignments.empty_title'),
      text: t('assignments.empty_text'),
      action: `<button type="button" class="btn btn-primary" id="empty-asg-btn">${icon('plus')}<span>${esc(t('assignments.new'))}</span></button>`,
    });
    grid.querySelector('#empty-asg-btn')?.addEventListener('click', openNewModal);
    icons(grid);
    return;
  }

  grid.className = 'grid grid-3';
  grid.innerHTML = rows.map((a) => {
    const c = courses.find((x) => x.id === a.course_id);
    const dueStr = a.due_at ? `${formatDate(a.due_at)} (${formatRelative(a.due_at)})` : '';
    return `<article class="card">
      <div class="card-head">
        ${statusBadge(a.status)}
        <button type="button" class="btn-icon" data-del-asg="${esc(a.id)}" aria-label="${esc(t('common.delete'))}">${icon('trash-2')}</button>
      </div>
      <a href="./assignment.html?id=${esc(a.id)}" style="text-decoration:none;">
        <h2 class="card-title">${esc(a.title)}</h2>
        <p class="text-sm muted line-clamp-2 mb-2">${esc(a.instructions || '')}</p>
      </a>
      <div class="card-meta mb-4">
        ${c ? `<span>${esc(c.name)}</span>` : ''}
        ${dueStr ? `<span>• ${esc(dueStr)}</span>` : ''}
      </div>
      <a class="btn btn-sm btn-primary" href="./assignment.html?id=${esc(a.id)}">${icon('arrow-right')}<span>${esc(t('common.open'))}</span></a>
    </article>`;
  }).join('');

  grid.querySelectorAll('[data-del-asg]').forEach((b) => {
    b.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: t('common.delete'), message: t('common.confirm_title'), danger: true });
      if (!ok) return;
      const { error } = await db.from('pran_not_assignments').delete().eq('id', b.dataset.delAsg);
      if (error) handleError(error);
      else {
        assignments = assignments.filter((x) => x.id !== b.dataset.delAsg);
        toast(t('common.deleted'), 'success');
        renderList();
      }
    });
  });

  icons(grid);
  animateIn('#assignments-grid article');
}

function openNewModal() {
  const preCourse = getParam('course') || '';
  const m = openModal({
    title: t('assignments.new'),
    body: `
      <div class="field"><label>Tit devwa a</label><input class="input" id="asg-title" required placeholder="Ex : Disètasyon sou obligasyon kontra"></div>
      <div class="form-row">
        <div class="field"><label>${esc(t('nav.courses'))}</label>
          <select class="select" id="asg-course">
            <option value="">${esc(t('common.no_course'))}</option>
            ${courses.map((c) => `<option value="${esc(c.id)}" ${c.id === preCourse ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>${esc(t('assignments.due_at'))}</label>
          <input class="input" id="asg-due" type="datetime-local">
        </div>
      </div>
      <div class="field"><label>${esc(t('assignments.instructions'))}</label>
        <textarea class="textarea" id="asg-inst" rows="4" placeholder="Kole sijè a oswa enstriksyon pwofesè a..."></textarea>
      </div>`,
    footer: `<button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
             <button type="button" class="btn btn-primary" id="asg-save">${esc(t('common.save'))}</button>`,
  });

  const saveBtn = m.el.querySelector('#asg-save');
  saveBtn.addEventListener('click', async () => {
    const title = m.el.querySelector('#asg-title').value.trim();
    if (!title) { toast(t('errors.required'), 'warning'); return; }
    setLoading(saveBtn, true);
    try {
      const dueVal = m.el.querySelector('#asg-due').value;
      const { data, error } = await db.from('pran_not_assignments').insert({
        user_id: userRef.id,
        course_id: m.el.querySelector('#asg-course').value || null,
        title,
        instructions: m.el.querySelector('#asg-inst').value.trim() || null,
        due_at: dueVal ? new Date(dueVal).toISOString() : null,
      }).select().single();
      if (error) throw error;
      location.href = appUrl(`pages/assignment.html?id=${data.id}`);
    } catch (err) {
      handleError(err);
      setLoading(saveBtn, false);
    }
  });
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;

  await initAppChrome({ profile, user, active: 'assignments' });
  setTutorContext({ contextType: 'general', contextTitle: t('assignments.title') });
  pageEnter();

  const [cachedCourses, cachedAsgs] = await Promise.all([
    cacheGet('courses_list'),
    cacheGet('assignments_list'),
  ]);
  if (cachedCourses) courses = cachedCourses;
  if (cachedAsgs) {
    assignments = cachedAsgs;
    renderList();
  }

  if (navigator.onLine) {
    try {
      const [cRes, aRes] = await Promise.all([
        db.from('pran_not_courses').select('id, name').eq('archived', false).order('name'),
        db.from('pran_not_assignments').select('*').order('due_at', { ascending: true, nullsFirst: false }),
      ]);
      if (cRes.data) {
        courses = cRes.data;
        await cacheSet('courses_list', courses);
      }
      if (aRes.data) {
        assignments = aRes.data;
        await cacheSet('assignments_list', assignments);
      }
      renderList();
    } catch (err) {
      if (!assignments.length) {
        renderList();
        handleError(err);
      }
    }
  } else if (!assignments.length) {
    renderList();
  }

  document.getElementById('new-assignment-btn').addEventListener('click', openNewModal);
  document.querySelectorAll('#asg-filters button').forEach((b) => {
    b.addEventListener('click', () => {
      statusFilter = b.dataset.status;
      document.querySelectorAll('#asg-filters button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      renderList();
    });
  });
})();
