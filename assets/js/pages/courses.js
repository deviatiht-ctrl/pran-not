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
let activeSemFilter = 'all'; // 'all' or a semester string
let activeDayFilter = 'all'; // 'all' | 'today' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' | 'none'

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

function getTodayDayId() {
  const dayIndex = new Date().getDay();
  const map = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return map[dayIndex] || 'mon';
}

function renderCourses() {
  const grid = document.getElementById('courses-grid');
  const todayId = getTodayDayId();

  // 1. Filtre pa semès aktif
  let visible = activeSemFilter === 'all'
    ? courses.slice()
    : courses.filter((c) => (c.semester || '') === activeSemFilter);

  // 2. Filtre pa jou kou
  if (activeDayFilter === 'today') {
    visible = visible.filter((c) => Array.isArray(c.schedule_days) && c.schedule_days.includes(todayId));
  } else if (activeDayFilter === 'none') {
    visible = visible.filter((c) => !Array.isArray(c.schedule_days) || c.schedule_days.length === 0);
  } else if (activeDayFilter !== 'all') {
    visible = visible.filter((c) => Array.isArray(c.schedule_days) && c.schedule_days.includes(activeDayFilter));
  }

  // 3. Òdonans entèlijan (an dirèk an premye, ap kòmanse talè an dezyèm, jou jodi a, orè kwonolojik, alfabetik)
  visible.sort((a, b) => {
    const liveA = getCourseLiveStatus(a);
    const liveB = getCourseLiveStatus(b);
    const scoreA = liveA.state === 'live' ? 0 : (liveA.state === 'soon' ? 1 : 2);
    const scoreB = liveB.state === 'live' ? 0 : (liveB.state === 'soon' ? 1 : 2);
    if (scoreA !== scoreB) return scoreA - scoreB;

    const hasTodayA = Array.isArray(a.schedule_days) && a.schedule_days.includes(todayId) ? 0 : 1;
    const hasTodayB = Array.isArray(b.schedule_days) && b.schedule_days.includes(todayId) ? 0 : 1;
    if (hasTodayA !== hasTodayB) return hasTodayA - hasTodayB;

    const timeA = a.schedule_time_start || '99:99';
    const timeB = b.schedule_time_start || '99:99';
    if (timeA !== timeB) return timeA.localeCompare(timeB);

    return (a.name || '').localeCompare(b.name || '');
  });

  if (!visible.length) {
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
  grid.innerHTML = visible.map((c) => {
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
        ${c.credits && Number(c.credits) > 0 ? `<span class="badge">${c.credits} ${esc(t('courses.credits'))}</span>` : ''}
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

/* ------------------------------------------------------------------
   Rann baton filtre semès nan #sem-filter-bar
   ------------------------------------------------------------------ */
function renderSemesterFilterBar(courseList) {
  const bar = document.getElementById('sem-filter-bar');
  if (!bar) return;

  // Retire ansyen bouton semès (kenbe "Tout" ak lyen istorik)
  bar.querySelectorAll('[data-sem-btn]').forEach((b) => b.remove());

  // Ekstrè semès inik (non vid)
  const sems = [...new Set(courseList.map((c) => (c.semester || '').trim()).filter(Boolean))];

  // Pwen referans: bouton "Tout" (premye bouton)
  const allBtn = bar.querySelector('#sem-filter-all');

  for (const sem of sems) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-outline';
    btn.dataset.semBtn = sem;
    btn.textContent = sem;
    btn.addEventListener('click', () => {
      activeSemFilter = sem;
      updateSemFilterActive();
      renderCourses();
    });
    // Ensere apre bouton "Tout", anvan lyen istorik
    allBtn.insertAdjacentElement('afterend', btn);
  }

  // Bouton "Tout" ecoutè
  allBtn.onclick = () => {
    activeSemFilter = 'all';
    updateSemFilterActive();
    renderCourses();
  };

  updateSemFilterActive();
}

/* Mete ajou klas aktif sou bouton filtre semès */
function updateSemFilterActive() {
  const bar = document.getElementById('sem-filter-bar');
  if (!bar) return;
  bar.querySelectorAll('button').forEach((b) => {
    const sem = b.dataset.semBtn;
    const isActive = sem ? activeSemFilter === sem : activeSemFilter === 'all';
    b.className = isActive ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline';
  });
}

/* ------------------------------------------------------------------
   Rann baton filtre jou kou nan #day-filter-bar
   ------------------------------------------------------------------ */
function renderDayFilterBar() {
  const bar = document.getElementById('day-filter-bar');
  if (!bar) return;

  const dayOptions = [
    { id: 'all', label: t('courses.day_all') || 'Tout' },
    { id: 'today', label: t('courses.day_today') || 'Jodi a' },
    { id: 'mon', label: t('courses.day_mon') || 'Lendi' },
    { id: 'tue', label: t('courses.day_tue') || 'Madi' },
    { id: 'wed', label: t('courses.day_wed') || 'Mèkredi' },
    { id: 'thu', label: t('courses.day_thu') || 'Jedi' },
    { id: 'fri', label: t('courses.day_fri') || 'Vandredi' },
    { id: 'sat', label: t('courses.day_sat') || 'Samdi' },
    { id: 'sun', label: t('courses.day_sun') || 'Dimanch' },
    { id: 'none', label: t('courses.no_schedule') || 'San orè' },
  ];

  bar.innerHTML = `
    <span class="text-xs muted font-bold" style="text-transform:uppercase;margin-right:2px;">${esc(t('courses.filter_days_title') || 'Jou :')}</span>
    ${dayOptions.map((opt) => `
      <button type="button" class="btn btn-xs ${activeDayFilter === opt.id ? 'btn-primary' : 'btn-outline'}" data-day-filter="${esc(opt.id)}">
        ${opt.id === 'today' ? icon('clock') : ''}
        <span>${esc(opt.label)}</span>
      </button>
    `).join('')}
  `;

  bar.querySelectorAll('[data-day-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeDayFilter = btn.dataset.dayFilter;
      renderDayFilterBar();
      renderCourses();
    });
  });

  icons(bar);
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
            <label for="c-cred">${esc(t('courses.credits_optional'))}</label>
            <input class="input" id="c-cred" type="number" min="0" max="30" value="${esc(existing?.credits !== undefined && existing?.credits !== null ? existing.credits : '')}" placeholder="${esc(t('courses.credits_placeholder'))}">
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
      if (!userRef?.id) {
        const authRes = await requireAuth();
        userRef = authRes.user;
      }

      const startTime = normalizeTimeHHMM(m.el.querySelector('#c-start').value) || null;
      const endTime = normalizeTimeHHMM(m.el.querySelector('#c-end').value) || null;
      const notifyBefore = Number(m.el.querySelector('#c-notify-before').value || 15);
      const scheduleDays = Array.from(m.el.querySelectorAll('input[name="days"]:checked')).map((x) => x.value);

      const rawCred = m.el.querySelector('#c-cred').value.trim();
      const numCred = rawCred !== '' ? Number(rawCred) : null;
      const credits = numCred !== null && !isNaN(numCred) ? Math.min(30, Math.max(0, numCred)) : null;

      const semVal = m.el.querySelector('#c-sem').value.trim() || null;
      const examVal = m.el.querySelector('#c-exam').value || null;
      const colorVal = m.el.querySelector('input[name="color"]:checked')?.value || '#F97316';
      const profVal = m.el.querySelector('#c-prof').value.trim() || null;

      const basePayload = {
        user_id: userRef.id,
        name,
        professor: profVal,
        semester: semVal,
        credits,
        exam_date: examVal,
        schedule_days: scheduleDays,
        color: colorVal,
      };
      const fullPayload = {
        ...basePayload,
        schedule_start_time: startTime,
        schedule_end_time: endTime,
        notify_before_minutes: notifyBefore,
      };

      const saveRow = async (payload) => (existing
        ? db.from('pran_not_courses').update(payload).eq('id', existing.id).select().maybeSingle()
        : db.from('pran_not_courses').insert(payload).select().maybeSingle());

      let data = null;
      let error = null;

      // 1. Eseye ak tout chan orè yo
      let res = await saveRow(fullPayload);
      data = res?.data;
      error = res?.error;

      // 2. Si gen erè kolòn orè (schema cache ou kolòn ki pa la), re-eseye ak basePayload
      if (error && /column|schema cache|42703|PGRST204/i.test(`${error.message || ''} ${error.code || ''}`)) {
        console.warn('[courses] Retrying save with basePayload:', error);
        res = await saveRow(basePayload);
        data = res?.data;
        error = res?.error;
      }

      // 3. Si sa toujou bay erè kolòn, re-eseye ak minPayload
      if (error && /column|schema cache|42703|PGRST204/i.test(`${error.message || ''} ${error.code || ''}`)) {
        const minPayload = {
          user_id: userRef.id,
          name,
          color: colorVal,
          professor: profVal,
          semester: semVal,
        };
        console.warn('[courses] Retrying save with minPayload:', error);
        res = await saveRow(minPayload);
        data = res?.data;
        error = res?.error;
      }

      if (error) {
        console.error('[courses] saveRow remote error:', error);
        if (!navigator.onLine || error.code === '42501' || error.message?.includes('network')) {
          data = {
            id: existing ? existing.id : `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            ...fullPayload,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            mastery: existing?.mastery || 0,
            archived: false,
          };
          error = null;
        } else {
          throw error;
        }
      }

      if (!data) {
        data = {
          id: existing ? existing.id : `client_${Date.now()}`,
          ...fullPayload,
        };
      }

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

      const userCoursesKey = `courses_list_${userRef.id}`;
      await cacheSet(userCoursesKey, courses);
      await cacheSet('courses_list', courses);

      toast(t('common.saved'), 'success');
      m.close();
      renderSemesterFilterBar(courses);
      renderDayFilterBar();
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

  const userCoursesKey = `courses_list_${user.id}`;
  const cached = (await cacheGet(userCoursesKey)) || (await cacheGet('courses_list'));
  if (cached?.length) {
    const userOnly = cached.filter((c) => !c.user_id || c.user_id === user.id);
    courses = mergeCourseSchedules(userOnly);
    renderSemesterFilterBar(courses);
    renderDayFilterBar();
    renderCourses();
  }

  if (navigator.onLine) {
    try {
      const { data, error } = await db
        .from('pran_not_courses')
        .select('*')
        .eq('user_id', user.id)
        .eq('archived', false)
        .order('created_at', { ascending: false });
      if (error) throw error;
      courses = mergeCourseSchedules(data || []);
      await cacheSet(userCoursesKey, courses);
      await cacheSet('courses_list', courses);
      renderSemesterFilterBar(courses);
      renderDayFilterBar();
      renderCourses();
    } catch (err) {
      if (!courses.length) {
        renderDayFilterBar();
        renderCourses();
        handleError(err);
      }
    }
  } else if (!courses.length) {
    renderDayFilterBar();
    renderCourses();
  }

  document.getElementById('new-course-btn').addEventListener('click', () => openCourseModal());
  if (getParam('new') === '1') openCourseModal();
})();
