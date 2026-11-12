/* =====================================================================
   PRAN NÒT - pages/test-session.js
   Passation de test (QCM, Vrai/Faux, Réponse courte, Cas pratique),
   correction IA des réponses ouvertes, détection des points faibles,
   explication simple en créole et proposition de rattrapage.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, recordActivity, awardXp, appUrl } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, getLang } from '../i18n.js';
import {
  icons, icon, esc, getParam, isUuid, toast, handleError, setLoading, openModal, renderMarkdown, pageEnter,
} from '../utils.js';
import { gradeAnswer, explainText } from '../ai.js';
import { cacheSet, cacheGet } from '../offline.js';

const db = window.db;
let userRef = null;
let profileRef = null;
let testRow = null;
let questions = [];
let submitted = false;
let startedAt = new Date().toISOString();

function renderTestForm() {
  const root = document.getElementById('test-session-root');
  root.innerHTML = `
    <div class="page-head">
      <div>
        <a class="btn btn-sm btn-ghost mb-2" href="./tests.html">${icon('arrow-left')}<span>${esc(t('common.back'))}</span></a>
        <h1>${esc(testRow.title)}</h1>
        <p class="muted">${questions.length} kesyon • ${esc(t(`tests.difficulty_${testRow.difficulty}`))}</p>
      </div>
    </div>

    <form id="quiz-form" class="stack">
      ${questions.map((q, idx) => `
        <section class="card" data-q-id="${esc(q.id)}">
          <div class="row-between mb-3">
            <span class="badge">Kesyon ${idx + 1} / ${questions.length}</span>
            ${q.keyword ? `<span class="badge badge-outline">${esc(q.keyword)}</span>` : ''}
          </div>
          <h2 class="card-title mb-4" style="font-size:1.1rem;">${esc(q.prompt)}</h2>

          ${q.type === 'mcq' ? `
            <div class="stack-sm">
              ${(q.options || []).map((opt, oi) => `
                <label class="option">
                  <input type="radio" name="q_${esc(q.id)}" value="${oi}">
                  <span class="text-sm">${esc(opt)}</span>
                </label>`).join('')}
            </div>` : q.type === 'true_false' ? `
            <div class="option-grid">
              <label class="option"><input type="radio" name="q_${esc(q.id)}" value="true"><span>${esc(t('common.yes'))} / Vre</span></label>
              <label class="option"><input type="radio" name="q_${esc(q.id)}" value="false"><span>${esc(t('common.no'))} / Fo</span></label>
            </div>` : `
            <textarea class="textarea" name="q_${esc(q.id)}" rows="4" placeholder="Ekri repons ou isit la..."></textarea>`}
        </section>`).join('')}

      <button type="submit" class="btn btn-primary btn-lg" id="submit-quiz-btn">
        <i data-lucide="check" aria-hidden="true"></i>
        <span>${esc(t('tests.submit'))}</span>
      </button>
    </form>`;

  icons(root);
  document.getElementById('quiz-form').addEventListener('submit', gradeTest);
}

async function gradeTest(e) {
  e.preventDefault();
  if (submitted) return;
  const btn = document.getElementById('submit-quiz-btn');
  setLoading(btn, true);

  const form = e.currentTarget;
  const results = [];
  let totalScore = 0;
  let maxScore = 0;
  const weakSet = new Set();

  try {
    for (const q of questions) {
      const pts = Number(q.points || 1);
      maxScore += pts;
      let given = null;
      let correct = false;
      let earned = 0;
      let feedback = q.explanation || '';

      if (q.type === 'mcq') {
        const checked = form.querySelector(`input[name="q_${q.id}"]:checked`);
        given = checked ? Number(checked.value) : null;
        correct = given === Number(q.answer);
        earned = correct ? pts : 0;
      } else if (q.type === 'true_false') {
        const checked = form.querySelector(`input[name="q_${q.id}"]:checked`);
        given = checked ? checked.value === 'true' : null;
        const expected = q.answer === true || q.answer === 'true';
        correct = given === expected;
        earned = correct ? pts : 0;
      } else {
        const ta = form.querySelector(`[name="q_${q.id}"]`);
        given = ta ? ta.value.trim() : '';
        if (given && navigator.onLine) {
          try {
            const graded = await gradeAnswer({
              question: q.prompt,
              expectedAnswer: String(q.answer),
              studentAnswer: given,
              maxPoints: pts,
              language: getLang(),
              faculty: profileRef?.faculty_id,
              level: profileRef?.level,
            });
            const g = graded?.result || {};
            earned = Math.min(pts, Math.max(0, Number(g.points ?? 0)));
            correct = Boolean(g.correct) || earned >= pts * 0.7;
            if (g.feedback) feedback = g.feedback;
          } catch {
            earned = given.length > 20 ? pts * 0.5 : 0;
          }
        }
      }

      if (!correct && q.keyword) weakSet.add(q.keyword);
      totalScore += earned;
      results.push({ question: q, given, correct, earned, max: pts, feedback });
    }

    const weakKeywords = Array.from(weakSet);
    const { data: attempt, error } = await db.from('pran_not_test_attempts').insert({
      user_id: userRef.id,
      test_id: testRow.id,
      course_id: testRow.course_id,
      unit_id: testRow.unit_id,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      score: totalScore,
      max_score: maxScore,
      answers: results.map((r) => ({
        question_id: r.question.id,
        given: r.given,
        correct: r.correct,
        points: r.earned,
        feedback: r.feedback,
      })),
      weak_keywords: weakKeywords,
    }).select().single();
    if (error) throw error;

    submitted = true;
    await recordActivity();
    await awardXp(25, 'test_completed', attempt.id);
    renderResults(results, Number(attempt.percent || 0), weakKeywords);
  } catch (err) {
    handleError(err);
    setLoading(btn, false);
  }
}

function renderResults(results, percent, weakKeywords) {
  const root = document.getElementById('test-session-root');
  const pct = Math.round(percent);
  root.innerHTML = `
    <div class="card card-accent mb-6">
      <div class="row-between" style="flex-wrap:wrap;gap:12px;">
        <div>
          <span class="eyebrow">${esc(t('tests.score'))}</span>
          <h1 class="mt-1 mb-1">${pct}%</h1>
          <p class="muted mb-0">${esc(testRow.title)}</p>
        </div>
        <div class="row-wrap">
          ${pct < 75 && weakKeywords.length ? `<a class="btn btn-primary" href="./tests.html?remedial=1${testRow.course_id ? `&course=${esc(testRow.course_id)}` : ''}">${icon('target')}<span>${esc(t('tests.remedial'))}</span></a>` : ''}
          <a class="btn btn-secondary" href="./tests.html">${esc(t('common.back'))}</a>
        </div>
      </div>
      ${weakKeywords.length ? `<div class="row-wrap mt-4"><span class="text-xs muted">${esc(t('tests.weak_points'))} :</span>${weakKeywords.map((w) => `<span class="badge badge-error">${esc(w)}</span>`).join('')}</div>` : ''}
    </div>

    <div class="stack">
      ${results.map((r, i) => `
        <article class="card">
          <div class="row-between mb-2">
            <strong>Kesyon ${i + 1}</strong>
            <span class="badge ${r.correct ? 'badge-success' : 'badge-error'}">${r.earned} / ${r.max}</span>
          </div>
          <p class="mb-2">${esc(r.question.prompt)}</p>
          <p class="text-sm muted mb-2"><strong>Repons ou :</strong> ${esc(r.given === null || r.given === '' ? '(vid)' : r.question.type === 'mcq' ? (r.question.options?.[r.given] ?? r.given) : String(r.given))}</p>
          <div class="alert ${r.correct ? 'alert-success' : 'alert-info'} mb-3">
            ${icon(r.correct ? 'check-circle-2' : 'info')}
            <div class="flex-1 text-sm">${esc(r.feedback || r.question.explanation || String(r.question.answer))}</div>
          </div>
          <button type="button" class="btn btn-sm btn-secondary" data-explain-idx="${i}">
            ${icon('sparkles')}<span>${esc(t('tests.explain_ht'))}</span>
          </button>
        </article>`).join('')}
    </div>`;

  icons(root);
  root.querySelectorAll('[data-explain-idx]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const r = results[Number(btn.dataset.explainIdx)];
      setLoading(btn, true);
      try {
        const res = await explainText({
          text: `Kesyon: ${r.question.prompt}\nRepons kòrèk: ${r.question.type === 'mcq' ? r.question.options?.[r.question.answer] : r.question.answer}\nEksplikasyon: ${r.feedback}`,
          mode: 'simple',
          language: 'ht',
          faculty: profileRef?.faculty_id,
          level: profileRef?.level,
        });
        openModal({
          title: t('tests.explain_ht'),
          body: `<div class="prose">${renderMarkdown(res?.result?.text || '')}</div>`,
        });
      } catch (err) {
        handleError(err);
      } finally {
        setLoading(btn, false);
      }
    });
  });
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  profileRef = profile;

  const id = getParam('id');
  await initAppChrome({ profile, user, active: 'tests' });
  pageEnter();

  if (!isUuid(id)) {
    document.getElementById('test-session-root').innerHTML = `<div class="alert alert-error">${esc(t('errors.not_found'))}</div>`;
    return;
  }

  const cachedSession = await cacheGet(`test_session_${id}`);
  if (cachedSession?.testRow && !navigator.onLine) {
    testRow = cachedSession.testRow;
    questions = cachedSession.questions || [];
  } else {
    try {
      const [tRes, qRes] = await Promise.all([
        db.from('pran_not_tests').select('*').eq('id', id).maybeSingle(),
        db.from('pran_not_test_questions').select('*').eq('test_id', id).order('position'),
      ]);
      if (tRes.error || !tRes.data) throw tRes.error || new Error('not_found');
      testRow = tRes.data;
      questions = qRes.data || [];
      await cacheSet(`test_session_${id}`, { testRow, questions });
    } catch {
      if (cachedSession?.testRow) {
        testRow = cachedSession.testRow;
        questions = cachedSession.questions || [];
      } else {
        document.getElementById('test-session-root').innerHTML = `<div class="alert alert-error">${esc(t('errors.not_found'))}</div>`;
        return;
      }
    }
  }

  setTutorContext({
    contextType: 'test',
    contextId: testRow.id,
    contextTitle: testRow.title,
    contextText: `Tès: ${testRow.title}`,
    courseId: testRow.course_id,
  });

  renderTestForm();
})();
