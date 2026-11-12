/* =====================================================================
   PRAN NÒT - pages/course.js
   Page d'un cours : unités du syllabus, notes liées, mots-clés,
   flashcards, tests, devoirs, courbe Chart.js et mode veille d'examen.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, appUrl } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, formatDate, getLang } from '../i18n.js';
import {
  icons, icon, esc, getParam, isUuid, toast, handleError, loadScript, CDN, pageEnter, emptyState, setLoading,
} from '../utils.js';
import { generateTest } from '../ai.js';
import { getThemeChartPalette } from '../theme.js';
import { cacheSet, cacheGet } from '../offline.js';
import { mergeCourseSchedules, formatCourseScheduleBadge, getCourseLiveStatus } from '../notifications.js';

const db = window.db;
let course = null;
let units = [];
let notes = [];
let keywords = [];
let decks = [];
let hardCards = [];
let attempts = [];
let assignments = [];
let profileRef = null;
let userRef = null;
let examMode = false;

async function renderMasteryChart() {
  const canvas = document.getElementById('course-chart');
  if (!canvas) return;
  try {
    await loadScript(CDN.chart);
    const labels = units.length
      ? units.map((u, i) => `U${i + 1}`)
      : attempts.map((_, i) => `T${i + 1}`);
    const values = units.length
      ? units.map((u) => Math.round(Number(u.mastery || 0)))
      : attempts.map((a) => Math.round(Number(a.percent || 0)));

    if (!labels.length) return;
    const pal = getThemeChartPalette();
    new window.Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: t('courses.mastery'),
          data: values,
          borderColor: pal.accent,
          backgroundColor: pal.accentSoft,
          fill: true,
          tension: 0.35,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: pal.muted }, grid: { color: pal.grid } },
          y: { min: 0, max: 100, ticks: { color: pal.muted }, grid: { color: pal.grid } },
        },
        plugins: { legend: { display: false } },
      },
    });
  } catch (e) {
    console.warn('[chart]', e);
  }
}

function renderExamMode() {
  const root = document.getElementById('course-root');
  root.innerHTML = `
    <div class="page-head">
      <div>
        <span class="eyebrow"><i data-lucide="zap" aria-hidden="true"></i><span>${esc(t('courses.exam_eve_mode'))}</span></span>
        <h1>${esc(course.name)}</h1>
        <p class="muted">Rezime ultra konsantre, kat ki pi difisil yo ak tès eklè pou lavèy egzamen an.</p>
      </div>
      <div class="page-head-actions">
        <button type="button" class="btn btn-secondary" id="exit-exam-btn">${icon('arrow-left')}<span>${esc(t('common.back'))}</span></button>
        <button type="button" class="btn btn-primary" id="exam-flash-test-btn">${icon('check-circle-2')}<span>Tès eklè (5 min)</span></button>
      </div>
    </div>

    <div class="grid grid-2">
      <section class="card">
        <h2 class="card-title mb-3">Rezime kle tout nòt kou a</h2>
        ${notes.length ? notes.map((n) => `
          <div class="mb-4 pb-3" style="border-bottom:1px solid var(--c-border);">
            <strong class="text-sm">${esc(n.title)}</strong>
            <p class="text-sm muted mt-1 mb-0">${esc(n.summary || n.content_text?.slice(0, 220) || '')}</p>
          </div>`).join('') : `<p class="muted text-sm">${esc(t('notes.empty_title'))}</p>`}
      </section>

      <section class="card">
        <h2 class="card-title mb-3">Kat difisil pou revize touswit</h2>
        ${hardCards.length ? `<ul class="list">${hardCards.map((c) => `
          <li class="list-item" style="flex-direction:column;align-items:flex-start;">
            <strong class="text-sm">${esc(c.front)}</strong>
            <span class="text-sm muted">${esc(c.back)}</span>
          </li>`).join('')}</ul>` : `<p class="muted text-sm">Okenn kat difisil detekte.</p>`}
      </section>
    </div>`;

  icons(root);
  document.getElementById('exit-exam-btn').addEventListener('click', () => { examMode = false; renderCourse(); });
  document.getElementById('exam-flash-test-btn').addEventListener('click', launchFlashTest);
}

async function launchFlashTest(e) {
  const btn = e.currentTarget;
  setLoading(btn, true);
  try {
    const content = notes.map((n) => `${n.title}: ${n.summary || n.content_text || ''}`).join('\n').slice(0, 12000)
      || units.map((u) => `${u.title}: ${u.description || ''}`).join('\n');
    const weakKws = keywords.filter((k) => k.weakness >= 40).map((k) => k.term);
    const res = await generateTest({
      content: content || course.name,
      title: `Tès eklè — ${course.name}`,
      difficulty: 'exam',
      kind: 'flash',
      language: getLang(),
      faculty: profileRef?.faculty_id,
      level: profileRef?.level,
      count: 5,
      weakKeywords: weakKws,
    });
    const { data: testRow, error } = await db.from('pran_not_tests').insert({
      user_id: userRef.id,
      course_id: course.id,
      title: res.title || `Tès eklè — ${course.name}`,
      difficulty: 'exam',
      kind: 'flash',
      source: 'ai',
    }).select().single();
    if (error) throw error;

    await db.from('pran_not_test_questions').insert((res.questions || []).map((q, idx) => ({
      test_id: testRow.id, user_id: userRef.id, position: idx + 1, type: q.type,
      prompt: q.prompt, options: q.options || [], answer: q.answer,
      explanation: q.explanation || '', keyword: q.keyword || '', points: q.points || 1,
    })));
    location.href = appUrl(`pages/test-session.html?id=${testRow.id}`);
  } catch (err) {
    handleError(err);
    setLoading(btn, false);
  }
}

async function renderCourse() {
  if (examMode) { renderExamMode(); return; }
  const root = document.getElementById('course-root');
  const mergedCourse = mergeCourseSchedules([course])[0] || course;
  const mastery = Math.round(Number(mergedCourse.mastery || 0));
  const schedTime = formatCourseScheduleBadge(mergedCourse);
  const liveStatus = getCourseLiveStatus(mergedCourse);

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="row-wrap mb-2">
          <a class="btn btn-sm btn-ghost" href="./courses.html">${icon('arrow-left')}<span>${esc(t('common.back'))}</span></a>
          <span class="badge"><span class="course-dot" style="background:${esc(mergedCourse.color || '#F97316')}"></span><span>${mastery}% ${esc(t('courses.mastery'))}</span></span>
          ${schedTime ? `<span class="badge badge-outline">${icon('clock')}<span>${esc(schedTime)}</span></span>` : ''}
          ${liveStatus.state === 'live' ? `<span class="badge badge-error">${icon('radio')}<span>${esc(t('live.badge_live'))}</span></span>` : ''}
          ${mergedCourse.exam_date ? `<span class="badge badge-warning">${icon('calendar')}<span>${esc(formatDate(mergedCourse.exam_date))}</span></span>` : ''}
        </div>
        <h1>${esc(mergedCourse.name)}</h1>
        <p>${esc([mergedCourse.professor, mergedCourse.semester].filter(Boolean).join(' • '))}</p>
      </div>
      <div class="page-head-actions">
        <a class="btn btn-primary" href="./live-class.html?course=${esc(mergedCourse.id)}">${icon('radio')}<span>${esc(t('live.enter_btn'))}</span></a>
        <a class="btn btn-secondary" href="./syllabus.html?course=${esc(mergedCourse.id)}">${icon('file-up')}<span>${esc(t('courses.import_syllabus'))}</span></a>
        <a class="btn btn-secondary" href="./note-capture.html?course=${esc(mergedCourse.id)}">${icon('plus')}<span>${esc(t('notes.new'))}</span></a>
        <button type="button" class="btn btn-dark" id="btn-exam-mode">${icon('zap')}<span>${esc(t('courses.exam_eve_mode'))}</span></button>
      </div>
    </div>

    <div class="grid grid-main-side">
      <div class="stack">
        <!-- Unités d'apprentissage (syllabus) -->
        <section class="card">
          <div class="card-head">
            <h2 class="card-title">${esc(t('courses.units_title'))}</h2>
            <a class="btn btn-sm btn-secondary" href="./syllabus.html?course=${esc(course.id)}">${icon('sparkles')}<span>Silabis</span></a>
          </div>
          ${units.length ? `<ul class="list" id="units-list">${units.map((u, idx) => `
            <li class="list-item" id="unit-${esc(u.id)}" style="align-items:flex-start;flex-direction:column;gap:8px;">
              <div class="row-between" style="width:100%;">
                <strong class="text-sm">${idx + 1}. ${esc(u.title)}</strong>
                <div class="row" style="gap:8px;">
                  <span class="badge">${Math.round(Number(u.mastery || 0))}%</span>
                  <select class="select" data-unit-status="${esc(u.id)}" style="min-height:34px;padding:4px 32px 4px 10px;font-size:12px;width:auto;">
                    <option value="todo" ${u.status === 'todo' ? 'selected' : ''}>${esc(t('courses.status_todo'))}</option>
                    <option value="in_progress" ${u.status === 'in_progress' ? 'selected' : ''}>${esc(t('courses.status_in_progress'))}</option>
                    <option value="mastered" ${u.status === 'mastered' ? 'selected' : ''}>${esc(t('courses.status_mastered'))}</option>
                  </select>
                </div>
              </div>
              ${u.description ? `<p class="text-xs muted mb-0">${esc(u.description)}</p>` : ''}
              <div class="row-wrap">
                ${(u.keywords || []).slice(0, 5).map((k) => `<span class="badge">${esc(k)}</span>`).join('')}
              </div>
            </li>`).join('')}</ul>` : emptyState({
              icon: 'list-checks',
              title: 'Okenn chapit silabis poko ajoute',
              text: 'Enpòte silabis kou a pou dekoupe l an chapit etid otomatikman.',
              action: `<a class="btn btn-sm btn-primary" href="./syllabus.html?course=${esc(course.id)}">${esc(t('courses.import_syllabus'))}</a>`,
            })}
        </section>

        <!-- Notes liées -->
        <section class="card">
          <div class="section-head mb-3">
            <h2 class="card-title">${esc(t('nav.notes'))} (${notes.length})</h2>
            <a href="./note-capture.html?course=${esc(course.id)}">${esc(t('notes.new'))}</a>
          </div>
          ${notes.length ? `<ul class="list">${notes.map((n) => `
            <li class="list-item">
              <div class="flex-1">
                <a class="list-item-title" href="./note-view.html?id=${esc(n.id)}">${esc(n.title)}</a>
                <div class="list-item-sub line-clamp-2">${esc(n.summary || '')}</div>
              </div>
              <span class="badge">${esc(formatDate(n.updated_at || n.created_at))}</span>
            </li>`).join('')}</ul>` : `<p class="text-sm muted mb-0">${esc(t('notes.empty_title'))}</p>`}
        </section>
      </div>

      <aside class="stack">
        <!-- Courbe de maîtrise -->
        <section class="card">
          <h2 class="card-title mb-3">${esc(t('courses.mastery'))}</h2>
          <div class="chart-box sm"><canvas id="course-chart"></canvas></div>
        </section>

        <!-- Mots-clés -->
        <section class="card">
          <h2 class="card-title mb-3">${esc(t('notes.keywords'))}</h2>
          ${keywords.length ? `<div class="row-wrap">${keywords.map((k) => `
            <span class="badge ${k.weakness >= 40 ? 'badge-error' : ''}">${esc(k.term)}</span>
          `).join('')}</div>` : `<p class="text-sm muted mb-0">${esc(t('common.none'))}</p>`}
        </section>

        <!-- Flashcards, Tests, Devoirs -->
        <section class="card">
          <h2 class="card-title mb-3">Zouti kou a</h2>
          <div class="stack-sm">
            <a class="btn btn-secondary btn-block" href="./flashcards.html?course=${esc(course.id)}">${icon('layers')}<span>${esc(t('nav.review'))} (${decks.length} pake)</span></a>
            <a class="btn btn-secondary btn-block" href="./tests.html?course=${esc(course.id)}">${icon('check-circle-2')}<span>${esc(t('nav.tests'))} (${attempts.length})</span></a>
            <a class="btn btn-secondary btn-block" href="./assignments.html?course=${esc(course.id)}">${icon('clipboard-list')}<span>${esc(t('nav.assignments'))} (${assignments.length})</span></a>
          </div>
        </section>
      </aside>
    </div>`;

  icons(root);
  document.getElementById('btn-exam-mode').addEventListener('click', () => { examMode = true; renderCourse(); });

  root.querySelectorAll('[data-unit-status]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const uid = sel.dataset.unitStatus;
      const status = sel.value;
      const patch = { status, studied_at: status === 'in_progress' || status === 'mastered' ? new Date().toISOString() : null };
      const { error } = await db.from('pran_not_syllabus_units').update(patch).eq('id', uid);
      if (error) handleError(error);
      else toast(t('common.saved'), 'success');
    });
  });

  await renderMasteryChart();
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  profileRef = profile;
  const id = getParam('id');
  examMode = getParam('mode') === 'exam';

  await initAppChrome({ profile, user, active: 'courses' });
  pageEnter();

  if (!isUuid(id)) {
    document.getElementById('course-root').innerHTML = `<div class="alert alert-error">${esc(t('errors.not_found'))}</div>`;
    return;
  }

  const cachedDetail = await cacheGet(`course_detail_${id}`);
  const applyDetail = (d) => {
    course = d.course;
    units = d.units || [];
    notes = d.notes || [];
    keywords = d.keywords || [];
    decks = d.decks || [];
    hardCards = d.hardCards || [];
    attempts = d.attempts || [];
    assignments = d.assignments || [];
  };

  if (cachedDetail?.course && !navigator.onLine) {
    applyDetail(cachedDetail);
  } else {
    try {
      const [cRes, uRes, nRes, kRes, dRes, fRes, aRes, asgRes] = await Promise.all([
        db.from('pran_not_courses').select('*').eq('id', id).maybeSingle(),
        db.from('pran_not_syllabus_units').select('*').eq('course_id', id).order('position'),
        db.from('pran_not_notes').select('id, title, summary, content_text, updated_at, created_at').eq('course_id', id).order('updated_at', { ascending: false }),
        db.from('pran_not_keywords').select('*').eq('course_id', id).order('weakness', { ascending: false }).limit(20),
        db.from('pran_not_flashcard_decks').select('id, title').eq('course_id', id),
        db.from('pran_not_flashcards').select('front, back, lapses, ease').eq('course_id', id).order('lapses', { ascending: false }).limit(8),
        db.from('pran_not_test_attempts').select('percent, created_at').eq('course_id', id).not('finished_at', 'is', null).order('created_at'),
        db.from('pran_not_assignments').select('id, title, status').eq('course_id', id),
      ]);
      if (cRes.error || !cRes.data) throw new Error('not_found');
      const fresh = {
        course: cRes.data,
        units: uRes.data || [],
        notes: nRes.data || [],
        keywords: kRes.data || [],
        decks: dRes.data || [],
        hardCards: fRes.data || [],
        attempts: aRes.data || [],
        assignments: asgRes.data || [],
      };
      applyDetail(fresh);
      await cacheSet(`course_detail_${id}`, fresh);
    } catch (err) {
      if (cachedDetail?.course) {
        applyDetail(cachedDetail);
      } else {
        document.getElementById('course-root').innerHTML = `<div class="alert alert-error">${esc(t('errors.not_found'))}</div>`;
        return;
      }
    }
  }

  setTutorContext({
    contextType: 'course',
    contextId: course.id,
    contextTitle: course.name,
    contextText: `Kou: ${course.name}\nChapit: ${units.map((u) => u.title).join(', ')}`,
    courseId: course.id,
  });

  await renderCourse();
})();
