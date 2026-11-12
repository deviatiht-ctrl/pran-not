/* =====================================================================
   PRAN NÒT - pages/courses.js
   Gestion des cours : création, édition, archivage et accès aux syllabus.
   ===================================================================== */
import '../supabase.js';
import { requireAuth } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, formatDate } from '../i18n.js';
import {
  icons, icon, esc, emptyState, openModal, toast, handleError, setLoading,
  getParam, animateIn, pageEnter, confirmDialog,
} from '../utils.js';
import { cacheSet, cacheGet } from '../offline.js';
import {
  saveLocalCourseSchedule, mergeCourseSchedules, getCourseLiveStatus,
  formatCourseScheduleBadge, normalizeTimeHHMM,
} from '../notifications.js';

const db = window.db;
let userRef = null;
let courses = [];

const DAYS = [
  { id: 'mon', label: 'Lun' },
  { id: 'tue', label: 'Mar' },
  { id: 'wed', label: 'Mer' },
  { id: 'thu', label: 'Jeu' },
  { id: 'fri', label: 'Ven' },
  { id: 'sat', label: 'Sam' },
  { id: 'sun', label: 'Dim' },
];
const COLORS = ['#F97316', '#1B2A4A', '#15803D', '#1D4ED8', '#A16207', '#B91C1C'];

function renderCourses() {
  const grid = document.getElementById('courses-grid');
  if (!courses.length) {
    grid.className = '';
    grid.innerHTML = emptyState({
      icon: 'book-open',
      title: t('courses.empty_title'),
      text: t('courses.empty_text'),
      action: `<button type="button" class="btn btn-primary" id="empty-add-course">${icon('plus')}<span>${esc(t('courses.new'))}</span></button>`,
    });
    grid.querySelector('#empty-add-course')?.addEventListener('click', () => openCourseModal());
    icons(grid);
    return;
  }

  grid.className = 'grid grid-3';
  grid.innerHTML = courses.map((c) => {
    const pct = Math.round(Number(c.mastery || 0));
    const days = (c.schedule_days || []).map((id) => DAYS.find((d) => d.id === id)?.label || id).join(', ');
    const timeBadge = formatCourseScheduleBadge(c);
    const liveStatus = getCourseLiveStatus(c);
    const isLive = liveStatus.state === 'live';
    const isSoon = liveStatus.state === 'soon';
    return `<article class="card">
      <div class="card-head">
        <div class="row">
          <span class="course-dot" style="background:${esc(c.color || '#F97316')}"></span>
          <div>
            <a href="./course.html?id=${esc(c.id)}" style="text-decoration:none;">
              <h2 class="card-title">${esc(c.name)}</h2>
            </a>
            <div class="card-meta">${esc(c.professor || '')}${c.semester ? ` • ${esc(c.semester)}` : ''}</div>
          </div>
        </div>
        <div class="row" style="gap:4px;">
          <button type="button" class="btn-icon" data-edit-course="${esc(c.id)}" aria-label="${esc(t('common.edit'))}" title="${esc(t('common.edit'))}">${icon('edit-3')}</button>
          <button type="button" class="btn-icon" data-del-course="${esc(c.id)}" aria-label="${esc(t('common.delete'))}">${icon('trash-2')}</button>
        </div>
      </div>

      <div class="row-wrap mb-3">
        ${isLive ? `<span class="badge badge-error">${icon('radio')}<span>${esc(t('live.badge_live'))}</span></span>` : ''}
        ${isSoon ? `<span class="badge badge-accent">${icon('clock')}<span>${esc(t('live.badge_soon', { min: liveStatus.minutesToStart }))}</span></span>` : ''}
        ${days ? `<span class="badge">${esc(days)}</span>` : ''}
        ${timeBadge ? `<span class="badge badge-outline">${icon('clock')}<span>${esc(timeBadge)}</span></span>` : ''}
        ${c.credits ? `<span class="badge">${c.credits} ${esc(t('courses.credits'))}</span>` : ''}
        ${c.exam_date ? `<span class="badge badge-warning">${icon('calendar')}<span>${esc(formatDate(c.exam_date))}</span></span>` : ''}
      </div>

      <div class="row-between text-xs muted mb-1">
        <span>${esc(t('courses.mastery'))}</span>
        <strong>${pct}%</strong>
      </div>
      <div class="progress ${pct >= 80 ? 'success' : ''} mb-4"><span style="width:${pct}%"></span></div>

      <div class="row-wrap">
        <a class="btn btn-sm ${isLive || isSoon ? 'btn-primary' : 'btn-secondary'}" href="./live-class.html?course=${esc(c.id)}">${icon('radio')}<span>${esc(t('live.enter_btn'))}</span></a>
        <a class="btn btn-sm btn-primary" href="./course.html?id=${esc(c.id)}">${icon('arrow-right')}<span>${esc(t('common.open'))}</span></a>
        <a class="btn btn-sm btn-secondary" href="./syllabus.html?course=${esc(c.id)}">${icon('file-up')}<span>Silabis</span></a>
      </div>
    </article>`;
  }).join('');

  grid.querySelectorAll('[data-edit-course]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = courses.find((x) => x.id === btn.dataset.editCourse);
      if (target) openCourseModal(target);
    });
  });

  grid.querySelectorAll('[data-del-course]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: t('common.delete'), message: t('common.confirm_title'), danger: true });
      if (!ok) return;
      const { error } = await db.from('pran_not_courses').delete().eq('id', btn.dataset.delCourse);
      if (error) handleError(error);
      else {
        courses = courses.filter((x) => x.id !== btn.dataset.delCourse);
        await cacheSet('courses_list', courses);
        toast(t('common.deleted'), 'success');
        renderCourses();
      }
    });
  });

  icons(grid);
  animateIn('#courses-grid article');
}

function openCourseModal(existing = null) {
  const m = openModal({
    title: existing ? t('common.edit') : t('courses.new'),
    body: `
      <form id="course-form">
        <div class="field">
          <label for="c-name">${esc(t('courses.name'))}</label>
          <input class="input" id="c-name" required value="${esc(existing?.name || '')}" placeholder="Ex : Anatomie 1">
        </div>
        <div class="form-row">
          <div class="field">
            <label for="c-prof">${esc(t('courses.professor'))}</label>
            <input class="input" id="c-prof" value="${esc(existing?.professor || '')}" placeholder="Dr. / Me. ...">
          </div>
          <div class="field">
            <label for="c-sem">${esc(t('courses.semester'))}</label>
            <input class="input" id="c-sem" value="${esc(existing?.semester || 'Semestre 1')}">
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label for="c-cred">${esc(t('courses.credits'))}</label>
            <input class="input" id="c-cred" type="number" min="0" max="30" value="${esc(existing?.credits ?? 3)}">
          </div>
          <div class="field">
            <label for="c-exam">${esc(t('courses.exam_date'))}</label>
            <input class="input" id="c-exam" type="date" value="${esc(existing?.exam_date || '')}">
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label for="c-start">${esc(t('courses.start_time'))}</label>
            <input class="input" id="c-start" type="time" value="${esc(normalizeTimeHHMM(existing?.schedule_start_time) || '')}">
          </div>
          <div class="field">
            <label for="c-end">${esc(t('courses.end_time'))}</label>
            <input class="input" id="c-end" type="time" value="${esc(normalizeTimeHHMM(existing?.schedule_end_time) || '')}">
          </div>
        </div>
        <div class="field">
          <label for="c-notify-before">${esc(t('courses.notify_before'))}</label>
          <select class="select" id="c-notify-before">
            ${[15, 10, 5, 30, 0].map((min) => `
              <option value="${min}" ${Number(existing?.notify_before_minutes ?? 15) === min ? 'selected' : ''}>
                ${esc(min === 0 ? t('courses.notify_at_start') : t('courses.notify_minutes_before', { min }))}
              </option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>${esc(t('courses.days'))}</label>
          <div class="row-wrap">
            ${DAYS.map((d) => `
              <label class="chip">
                <input type="checkbox" name="days" value="${d.id}" ${existing?.schedule_days?.includes(d.id) ? 'checked' : ''} style="margin-right:4px;">
                <span>${d.label}</span>
              </label>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>${esc(t('courses.color'))}</label>
          <div class="row-wrap">
            ${COLORS.map((col, idx) => `
              <label class="chip">
                <input type="radio" name="color" value="${col}" ${(existing?.color || COLORS[0]) === col ? 'checked' : ''} ${idx === 0 && !existing ? 'checked' : ''}>
                <span class="course-dot" style="background:${col}"></span>
              </label>`).join('')}
          </div>
        </div>
      </form>`,
    footer: `<button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
             <button type="button" class="btn btn-primary" id="c-save-btn">${esc(t('common.save'))}</button>`,
  });

  const saveBtn = m.el.querySelector('#c-save-btn');
  saveBtn.addEventListener('click', async () => {
    const name = m.el.querySelector('#c-name').value.trim();
    if (!name) { toast(t('errors.required'), 'warning'); return; }
    setLoading(saveBtn, true);
    try {
      const startTime = normalizeTimeHHMM(m.el.querySelector('#c-start').value) || null;
      const endTime = normalizeTimeHHMM(m.el.querySelector('#c-end').value) || null;
      const notifyBefore = Number(m.el.querySelector('#c-notify-before').value || 15);
      const scheduleDays = Array.from(m.el.querySelectorAll('input[name="days"]:checked')).map((x) => x.value);

      const basePayload = {
        user_id: userRef.id,
        name,
        professor: m.el.querySelector('#c-prof').value.trim() || null,
        semester: m.el.querySelector('#c-sem').value.trim() || null,
        credits: Number(m.el.querySelector('#c-cred').value || 0),
        exam_date: m.el.querySelector('#c-exam').value || null,
        schedule_days: scheduleDays,
        color: m.el.querySelector('input[name="color"]:checked')?.value || '#F97316',
      };
      const fullPayload = {
        ...basePayload,
        schedule_start_time: startTime,
        schedule_end_time: endTime,
        notify_before_minutes: notifyBefore,
      };

      const saveRow = async (payload) => (existing
        ? db.from('pran_not_courses').update(payload).eq('id', existing.id).select().single()
        : db.from('pran_not_courses').insert(payload).select().single());

      let { data, error } = await saveRow(fullPayload);
      if (error && /column|schema cache|42703|PGRST204/i.test(`${error.message || ''} ${error.code || ''}`)) {
        ({ data, error } = await saveRow(basePayload));
      }
      if (error) throw error;

      saveLocalCourseSchedule(data.id, {
        schedule_days: scheduleDays,
        schedule_start_time: startTime,
        schedule_end_time: endTime,
        notify_before_minutes: notifyBefore,
      });

      const mergedRow = mergeCourseSchedules([{
        ...data,
        schedule_days: scheduleDays,
        schedule_start_time: startTime,
        schedule_end_time: endTime,
        notify_before_minutes: notifyBefore,
      }])[0];

      if (existing) courses = courses.map((x) => (x.id === existing.id ? mergedRow : x));
      else courses.unshift(mergedRow);

      await cacheSet('courses_list', courses);
      toast(t('common.saved'), 'success');
      m.close();
      renderCourses();
    } catch (err) {
      handleError(err);
      setLoading(saveBtn, false);
    }
  });
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  await initAppChrome({ profile, user, active: 'courses' });
  setTutorContext({ contextType: 'general', contextTitle: t('courses.title') });
  pageEnter();

  const cached = await cacheGet('courses_list');
  if (cached?.length) {
    courses = mergeCourseSchedules(cached);
    renderCourses();
  }

  if (navigator.onLine) {
    try {
      const { data, error } = await db.from('pran_not_courses').select('*').eq('archived', false).order('created_at', { ascending: false });
      if (error) throw error;
      courses = mergeCourseSchedules(data || []);
      await cacheSet('courses_list', courses);
      renderCourses();
    } catch (err) {
      if (!courses.length) {
        renderCourses();
        handleError(err);
      }
    }
  } else if (!courses.length) {
    renderCourses();
  }

  document.getElementById('new-course-btn').addEventListener('click', () => openCourseModal());
  if (getParam('new') === '1') openCourseModal();
})();
