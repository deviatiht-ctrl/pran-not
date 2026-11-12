/* =====================================================================
   PRAN NÒT - pages/history.js
   Istorik kou yo grupe pa semès — revizyon, statistik, ekspòtasyon.
   ===================================================================== */
import '../supabase.js';
import { requireAuth } from '../auth.js';
import { initAppChrome } from '../navbar.js';
import { t, formatDate } from '../i18n.js';
import { icons, icon, esc, emptyState, toast, handleError, animateIn, pageEnter, confirmDialog } from '../utils.js';
import { cacheGet } from '../offline.js';

const db = window.db;
let userRef = null;

// Tout kous ak nòt chaje
let allCourses = [];
let allNotes   = [];

// Eta filtre aktif
let activeSearch  = '';
let activeYear    = '';

/* ------------------------------------------------------------------
   Utilitè: ekstrè ane nan yon dat ISO
   ------------------------------------------------------------------ */
function yearOf(isoDate) {
  if (!isoDate) return null;
  return new Date(isoDate).getFullYear();
}

/* ------------------------------------------------------------------
   Konpile stat pou yon gwoup kou
   ------------------------------------------------------------------ */
function groupStats(groupCourses, notesMap) {
  const courseCount = groupCourses.length;
  const noteCount   = groupCourses.reduce((acc, c) => acc + (notesMap[c.id] || 0), 0);
  const masteries   = groupCourses.map((c) => Number(c.mastery || 0));
  const masteryAvg  = masteries.length
    ? Math.round(masteries.reduce((a, b) => a + b, 0) / masteries.length)
    : 0;
  return { courseCount, noteCount, masteryAvg };
}

/* ------------------------------------------------------------------
   Konpile kat kou konpa (compact)
   ------------------------------------------------------------------ */
function renderCourseCard(c, noteCount) {
  const pct   = Math.round(Number(c.mastery || 0));
  const color = esc(c.color || '#F97316');
  return `<article class="card card-sm" style="margin-bottom:8px;">
    <div class="row">
      <span class="course-dot" style="background:${color};flex-shrink:0;"></span>
      <div style="flex:1;min-width:0;">
        <a href="./course.html?id=${esc(c.id)}" style="text-decoration:none;">
          <strong class="card-title" style="font-size:.95rem;">${esc(c.name)}</strong>
        </a>
        <div class="card-meta" style="font-size:.8rem;">
          ${c.professor ? esc(c.professor) : ''}
          ${c.professor && noteCount ? ' • ' : ''}
          ${noteCount ? `${noteCount} nòt` : ''}
        </div>
        <div class="progress ${pct >= 80 ? 'success' : ''}" style="margin-top:4px;">
          <span style="width:${pct}%"></span>
        </div>
      </div>
      <span class="text-xs muted" style="flex-shrink:0;margin-left:8px;">${pct}%</span>
    </div>
  </article>`;
}

/* ------------------------------------------------------------------
   Rann blòk semès
   ------------------------------------------------------------------ */
function renderSemesterBlock(semName, groupCourses, notesMap, isActive) {
  const { courseCount, noteCount, masteryAvg } = groupStats(groupCourses, notesMap);

  const statusBadge = isActive
    ? `<span class="badge badge-success">${esc(t('history.active_badge'))}</span>`
    : `<span class="badge">${esc(t('history.closed_badge'))}</span>`;

  const closeBtn = isActive && semName
    ? `<button type="button" class="btn btn-sm btn-outline" data-close-sem="${esc(semName)}" style="margin-left:auto;">
         ${icon('archive')}
         <span>${esc(t('history.close_sem_btn'))}</span>
       </button>`
    : '';

  const courseCards = groupCourses
    .map((c) => renderCourseCard(c, notesMap[c.id] || 0))
    .join('');

  return `<section class="card mb-6">
    <div class="card-head row-wrap" style="align-items:center;gap:8px;">
      <h2 style="font-size:1.1rem;margin:0;">${esc(semName || t('history.no_semester_group'))}</h2>
      ${statusBadge}
      ${closeBtn}
    </div>
    <div class="row-wrap" style="gap:16px;margin-bottom:12px;font-size:.85rem;">
      <span class="muted">${esc(t('history.courses_count'))}: <strong>${courseCount}</strong></span>
      <span class="muted">${esc(t('history.notes_count'))}: <strong>${noteCount}</strong></span>
      <span class="muted">${esc(t('history.mastery_avg'))}: <strong>${masteryAvg}%</strong></span>
    </div>
    <div class="course-cards-list">
      ${courseCards}
    </div>
  </section>`;
}

/* ------------------------------------------------------------------
   Rann timeline konplè
   ------------------------------------------------------------------ */
function renderTimeline() {
  const timeline  = document.getElementById('semesters-timeline');
  const emptyDiv  = document.getElementById('history-empty');
  const search    = activeSearch.toLowerCase();

  // Filtre pa rechèch ak ane
  let filtered = allCourses.filter((c) => {
    const matchSearch = !search
      || (c.name || '').toLowerCase().includes(search)
      || (c.professor || '').toLowerCase().includes(search);
    const matchYear = !activeYear || String(yearOf(c.created_at)) === String(activeYear);
    return matchSearch && matchYear;
  });

  if (!filtered.length) {
    timeline.innerHTML = '';
    emptyDiv.innerHTML = emptyState({
      icon: 'clock',
      title: t('history.title'),
      text:  t('history.no_courses'),
    });
    icons(emptyDiv);
    return;
  }

  emptyDiv.innerHTML = '';

  // Konpile kat nòt pou chak kou
  const notesMap = {};
  for (const n of allNotes) {
    if (n.course_id) notesMap[n.course_id] = (notesMap[n.course_id] || 0) + 1;
  }

  // Gwoup kou pa semès (string field)
  const groups  = new Map();   // semName → { courses, hasActive }
  const noSem   = [];

  for (const c of filtered) {
    const semKey = (c.semester || '').trim();
    if (!semKey) {
      noSem.push(c);
      continue;
    }
    if (!groups.has(semKey)) groups.set(semKey, { courses: [], hasActive: false });
    const g = groups.get(semKey);
    g.courses.push(c);
    if (!c.archived) g.hasActive = true;
  }

  // Rann chak blòk
  const html = [];
  for (const [semName, { courses: gc, hasActive }] of groups) {
    html.push(renderSemesterBlock(semName, gc, notesMap, hasActive));
  }

  // Gwoup "San Semès" anba
  if (noSem.length) {
    html.push(renderSemesterBlock('', noSem, notesMap, noSem.some((c) => !c.archived)));
  }

  timeline.innerHTML = html.join('');

  // Bouton fèmen semès
  timeline.querySelectorAll('[data-close-sem]').forEach((btn) => {
    btn.addEventListener('click', () => closeSemester(btn.dataset.closeSem));
  });

  icons(timeline);
  animateIn('#semesters-timeline section');
}

/* ------------------------------------------------------------------
   Fèmen yon semès (achive tout kou ki gen semès sa a)
   ------------------------------------------------------------------ */
async function closeSemester(semesterText) {
  const ok = await confirmDialog({
    title:   t('history.close_sem_btn'),
    message: t('history.close_sem_confirm'),
    danger:  true,
  });
  if (!ok) return;

  try {
    const { error } = await db
      .from('pran_not_courses')
      .update({ archived: true })
      .eq('semester', semesterText)
      .eq('user_id', userRef.id);
    if (error) throw error;

    // Mete ajou eta lokal san recharge
    allCourses = allCourses.map((c) =>
      (c.semester || '').trim() === semesterText.trim() ? { ...c, archived: true } : c,
    );

    toast(t('common.saved'), 'success');
    renderTimeline();
  } catch (err) {
    handleError(err);
  }
}

/* ------------------------------------------------------------------
   Mete ajou filtre ane nan select
   ------------------------------------------------------------------ */
function buildYearFilter() {
  const sel    = document.getElementById('history-year-filter');
  const years  = [...new Set(allCourses.map((c) => yearOf(c.created_at)).filter(Boolean))].sort((a, b) => b - a);
  const allOpt = sel.querySelector('option[value=""]');

  // Efase ansyen opsyon (sof "Tout")
  Array.from(sel.options).forEach((o) => { if (o.value !== '') o.remove(); });

  // Mete opsyon ane
  for (const y of years) {
    const opt     = document.createElement('option');
    opt.value     = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  }
}

/* ------------------------------------------------------------------
   Init prensipal
   ------------------------------------------------------------------ */
(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  await initAppChrome({ profile, user, active: 'history' });
  pageEnter();

  // --- Chaje done: kache an premye si offline ---
  const cached = await cacheGet('courses_list');
  if (cached?.length && !navigator.onLine) {
    allCourses = cached;
    buildYearFilter();
    renderTimeline();
  }

  if (navigator.onLine) {
    try {
      // Tout kou (aktif + achive)
      const { data: coursesData, error: cErr } = await db
        .from('pran_not_courses')
        .select('*')
        .or('archived.eq.true,archived.eq.false')
        .order('created_at', { ascending: false });
      if (cErr) throw cErr;
      allCourses = coursesData || [];

      // Tout nòt (sèlman id ak course_id ase)
      const { data: notesData, error: nErr } = await db
        .from('pran_not_notes')
        .select('id, course_id');
      if (nErr) throw nErr;
      allNotes = notesData || [];

      buildYearFilter();
      renderTimeline();
    } catch (err) {
      if (!allCourses.length) {
        renderTimeline();
        handleError(err);
      }
    }
  } else if (!allCourses.length) {
    renderTimeline();
  }

  // --- Ecoutè rechèch ---
  document.getElementById('history-search').addEventListener('input', (e) => {
    activeSearch = e.target.value.trim();
    renderTimeline();
  });

  // --- Ecoutè filtre ane ---
  document.getElementById('history-year-filter').addEventListener('change', (e) => {
    activeYear = e.target.value;
    renderTimeline();
  });
})();
