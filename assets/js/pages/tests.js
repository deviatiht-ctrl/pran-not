/* =====================================================================
   PRAN NÒT - pages/tests.js
   Tests du jour, difficulté adaptative, points faibles, rattrapage et courbe.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, appUrl } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, getLang, formatRelative } from '../i18n.js';
import {
  icons, icon, esc, emptyState, openModal, toast, handleError,
  setLoading, getParam, loadScript, CDN, pageEnter,
} from '../utils.js';
import { generateTest } from '../ai.js';
import { getThemeChartPalette } from '../theme.js';
import { cacheSet, cacheGet } from '../offline.js';

const db = window.db;
let userRef = null;
let profileRef = null;
let courses = [];
let units = [];
let weakKeywords = [];
let tests = [];
let attempts = [];

function recommendedDifficulty() {
  if (!attempts.length) return 'easy';
  const last = attempts.slice(0, 3);
  const avg = last.reduce((a, b) => a + Number(b.percent || 0), 0) / last.length;
  if (avg >= 80) return 'exam';
  if (avg >= 55) return 'medium';
  return 'easy';
}

async function createAndOpenTest({ courseId = null, unitId = null, difficulty = 'medium', kind = 'standard', title = '', weakList = [] }, btn = null) {
  setLoading(btn, true);
  try {
    let qNotes = db.from('pran_not_notes').select('title, summary, content_text').order('updated_at', { ascending: false }).limit(5);
    if (courseId) qNotes = qNotes.eq('course_id', courseId);
    if (unitId) qNotes = qNotes.eq('unit_id', unitId);
    const { data: nRows } = await qNotes;

    const unitObj = units.find((u) => u.id === unitId);
    const courseObj = courses.find((c) => c.id === courseId);
    const content = (nRows || []).map((n) => `${n.title}\n${n.summary || ''}\n${(n.content_text || '').slice(0, 2000)}`).join('\n\n')
      || (unitObj ? `${unitObj.title}\n${unitObj.description || ''}\n${(unitObj.keywords || []).join(', ')}` : '')
      || (courseObj ? courseObj.name : '')
      || weakList.join(', ');

    if (!content) {
      toast('Ajoute yon nòt oswa yon kou anvan pou jenere yon tès.', 'warning');
      setLoading(btn, false);
      return;
    }

    const res = await generateTest({
      content,
      title: title || unitObj?.title || courseObj?.name || 'Tès etid',
      difficulty,
      kind,
      language: getLang(),
      faculty: profileRef?.faculty_id,
      level: profileRef?.level,
      count: 6,
      weakKeywords: weakList,
    });

    const { data: testRow, error: tErr } = await db.from('pran_not_tests').insert({
      user_id: userRef.id,
      course_id: courseId || null,
      unit_id: unitId || null,
      title: res.title || title || 'Tès Pran Nòt',
      difficulty,
      kind,
      source: 'ai',
    }).select().single();
    if (tErr) throw tErr;

    const qRows = (res.questions || []).map((q, idx) => ({
      test_id: testRow.id,
      user_id: userRef.id,
      unit_id: unitId || null,
      position: idx + 1,
      type: q.type,
      prompt: q.prompt,
      options: q.options || [],
      answer: q.answer,
      explanation: q.explanation || '',
      keyword: q.keyword || '',
      points: q.points || 1,
    }));
    if (qRows.length) await db.from('pran_not_test_questions').insert(qRows);

    location.href = appUrl(`pages/test-session.html?id=${testRow.id}`);
  } catch (err) {
    handleError(err);
    setLoading(btn, false);
  }
}

function openGenerateModal() {
  const rec = recommendedDifficulty();
  const m = openModal({
    title: t('tests.generate'),
    body: `
      <div class="field"><label>${esc(t('nav.courses'))}</label>
        <select class="select" id="gt-course">
          <option value="">${esc(t('common.all'))}</option>
          ${courses.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Chapit / Inite</label>
        <select class="select" id="gt-unit">
          <option value="">${esc(t('common.all'))}</option>
          ${units.map((u) => `<option value="${esc(u.id)}">${esc(u.title)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Nivo difikilte (rekòmande : ${esc(t(`tests.difficulty_${rec}`))})</label>
        <select class="select" id="gt-diff">
          <option value="easy" ${rec === 'easy' ? 'selected' : ''}>${esc(t('tests.difficulty_easy'))}</option>
          <option value="medium" ${rec === 'medium' ? 'selected' : ''}>${esc(t('tests.difficulty_medium'))}</option>
          <option value="exam" ${rec === 'exam' ? 'selected' : ''}>${esc(t('tests.difficulty_exam'))}</option>
        </select>
      </div>`,
    footer: `<button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
             <button type="button" class="btn btn-primary" id="gt-go">${esc(t('tests.start'))}</button>`,
  });
  m.el.querySelector('#gt-go').addEventListener('click', (e) => {
    createAndOpenTest({
      courseId: m.el.querySelector('#gt-course').value || null,
      unitId: m.el.querySelector('#gt-unit').value || null,
      difficulty: m.el.querySelector('#gt-diff').value,
    }, e.currentTarget);
  });
}

async function renderChart() {
  const canvas = document.getElementById('tests-chart');
  if (!canvas || !attempts.length) return;
  try {
    await loadScript(CDN.chart);
    const ordered = [...attempts].reverse();
    const pal = getThemeChartPalette();
    new window.Chart(canvas, {
      type: 'line',
      data: {
        labels: ordered.map((_, i) => `#${i + 1}`),
        datasets: [{
          label: '%',
          data: ordered.map((a) => Math.round(Number(a.percent || 0))),
          borderColor: pal.primary,
          backgroundColor: pal.primarySoft,
          fill: true,
          tension: 0.3,
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
  } catch { /* ignore */ }
}

function renderLists() {
  const tBox = document.getElementById('tests-list');
  if (!tests.length) {
    tBox.innerHTML = emptyState({
      icon: 'check-circle-2',
      title: t('tests.empty_title'),
      text: t('tests.empty_text'),
      action: `<button type="button" class="btn btn-sm btn-primary" id="empty-test-btn">${esc(t('tests.generate'))}</button>`,
    });
    tBox.querySelector('#empty-test-btn')?.addEventListener('click', openGenerateModal);
  } else {
    tBox.innerHTML = `<ul class="list">${tests.map((ts) => {
      const c = courses.find((x) => x.id === ts.course_id);
      return `<li class="list-item">
        <div class="flex-1">
          <div class="list-item-title">${esc(ts.title)}</div>
          <div class="list-item-sub">${c ? esc(c.name) : ''} • ${ts.question_count || 0} kesyon • ${esc(t(`tests.difficulty_${ts.difficulty}`))}</div>
        </div>
        <a class="btn btn-sm btn-primary" href="./test-session.html?id=${esc(ts.id)}">${esc(t('tests.start'))}</a>
      </li>`;
    }).join('')}</ul>`;
  }

  const aBox = document.getElementById('attempts-list');
  aBox.innerHTML = attempts.length
    ? `<ul class="list">${attempts.slice(0, 8).map((a) => `
        <li class="list-item">
          <div class="flex-1">
            <div class="list-item-title">${esc(a.test?.title || 'Tès')}</div>
            <div class="list-item-sub">${esc(formatRelative(a.created_at))}</div>
          </div>
          <span class="badge ${Number(a.percent) >= 70 ? 'badge-success' : 'badge-warning'}">${Math.round(Number(a.percent || 0))}%</span>
        </li>`).join('')}</ul>`
    : `<p class="text-sm muted mb-0">${esc(t('common.none'))}</p>`;

  const wBox = document.getElementById('weak-keywords-box');
  wBox.innerHTML = weakKeywords.length
    ? `<div class="row-wrap">${weakKeywords.map((k) => `<span class="badge badge-error">${esc(k.term)} (${Math.round(k.weakness)}%)</span>`).join('')}</div>`
    : `<p class="text-sm muted mb-0">Okenn pwen fèb kritik detekte.</p>`;

  const rBox = document.getElementById('readiness-box');
  rBox.innerHTML = courses.length
    ? `<div class="stack-sm">${courses.map((c) => {
        const pct = Math.round(Number(c.mastery || 0));
        return `<div>
          <div class="row-between text-xs mb-1"><span>${esc(c.name)}</span><strong>${pct}%</strong></div>
          <div class="progress progress-sm ${pct >= 75 ? 'success' : ''}"><span style="width:${pct}%"></span></div>
        </div>`;
      }).join('')}</div>`
    : `<p class="text-sm muted mb-0">${esc(t('common.none'))}</p>`;

  icons(document.body);
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  profileRef = profile;

  await initAppChrome({ profile, user, active: 'tests' });
  setTutorContext({ contextType: 'general', contextTitle: t('tests.title') });
  pageEnter();

  const cachedTests = await cacheGet('tests_overview');
  const applyTestsState = (st) => {
    courses = st.courses || [];
    units = st.units || [];
    tests = st.tests || [];
    attempts = st.attempts || [];
    weakKeywords = st.weakKeywords || [];
  };
  if (cachedTests) {
    applyTestsState(cachedTests);
    renderLists();
    renderChart();
  }

  if (navigator.onLine) {
    try {
      const [cRes, uRes, tRes, aRes, kRes] = await Promise.all([
        db.from('pran_not_courses').select('id, name, mastery').eq('archived', false).order('name'),
        db.from('pran_not_syllabus_units').select('id, course_id, title, description, keywords').order('position'),
        db.from('pran_not_tests').select('*').order('created_at', { ascending: false }).limit(20),
        db.from('pran_not_test_attempts').select('*, test:pran_not_tests(title)').not('finished_at', 'is', null).order('created_at', { ascending: false }).limit(15),
        db.from('pran_not_keywords').select('term, weakness, course_id').gte('weakness', 35).order('weakness', { ascending: false }).limit(12),
      ]);
      const fresh = {
        courses: cRes.data || [],
        units: uRes.data || [],
        tests: tRes.data || [],
        attempts: aRes.data || [],
        weakKeywords: kRes.data || [],
      };
      applyTestsState(fresh);
      await cacheSet('tests_overview', fresh);
      renderLists();
      renderChart();
    } catch (err) {
      if (!cachedTests) {
        renderLists();
        handleError(err);
      }
    }
  } else if (!cachedTests) {
    renderLists();
  }

  document.getElementById('new-test-btn').addEventListener('click', openGenerateModal);
  document.getElementById('remedial-btn').addEventListener('click', (e) => {
    const kws = weakKeywords.map((k) => k.term);
    if (!kws.length) { toast('Okenn pwen fèb pou ratrape kounye a.', 'info'); return; }
    createAndOpenTest({
      courseId: getParam('course') || weakKeywords[0]?.course_id || null,
      difficulty: 'medium',
      kind: 'remedial',
      title: t('tests.remedial'),
      weakList: kws.slice(0, 6),
    }, e.currentTarget);
  });

  if (getParam('autostart') === '1' && getParam('unit')) {
    const u = units.find((x) => x.id === getParam('unit'));
    if (u) createAndOpenTest({ courseId: u.course_id, unitId: u.id, title: u.title });
  } else if (getParam('remedial') === '1' && weakKeywords.length) {
    createAndOpenTest({
      courseId: getParam('course') || weakKeywords[0]?.course_id || null,
      kind: 'remedial',
      title: t('tests.remedial'),
      weakList: weakKeywords.slice(0, 5).map((k) => k.term),
    });
  }
})();
