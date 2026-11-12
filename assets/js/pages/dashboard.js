/* =====================================================================
   PRAN NÒT - pages/dashboard.js
   Tableau de bord quotidien dynamique : plan du jour, streak, XP,
   objectif quotidien, défis par faculté, échéances et cours à risque.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, recordActivity, awardXp } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, tPick, getLang, formatDate, formatRelative } from '../i18n.js';
import {
  icons, icon, esc, dayOfYear, ringSvg, toast, handleError, animateIn, pageEnter, setLoading,
} from '../utils.js';
import { cacheSet, cacheGet } from '../offline.js';

const db = window.db;

function taskTitle(task) {
  const p = task.params || {};
  return t(`dashboard.plan_tasks.${task.type}`, {
    count: p.count ?? 0,
    unit: p.unit || '',
    title: p.title || '',
    keyword: p.keyword || '',
    course: p.course || '',
    days: p.days ?? 0,
  });
}

function taskIcon(type) {
  return {
    review: 'layers',
    test: 'check-circle-2',
    assignment: 'clipboard-list',
    weak: 'alert-triangle',
    study_unit: 'book-open',
    capture: 'camera',
    exam: 'calendar',
    course_setup: 'plus-circle',
  }[type] || 'circle';
}

function renderPlan(plan) {
  const list = document.getElementById('daily-plan-list');
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const doneCount = tasks.filter((x) => x.done).length;
  const total = tasks.length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  document.getElementById('plan-progress-bar').style.width = `${pct}%`;
  document.getElementById('plan-progress-text').textContent = `${doneCount} / ${total}`;

  if (!tasks.length) {
    list.innerHTML = `<li class="list-item muted text-sm">${esc(t('common.none'))}</li>`;
    return;
  }

  list.innerHTML = tasks.map((task) => `
    <li class="list-item">
      <button type="button" class="btn-icon bordered" data-complete-task="${esc(task.id)}"
        aria-label="${esc(t('dashboard.plan_done'))}" ${task.done ? 'disabled' : ''}>
        ${icon(task.done ? 'check' : 'circle')}
      </button>
      <span class="icon-chip sm ${task.done ? 'success' : 'accent'}">${icon(taskIcon(task.type))}</span>
      <a class="flex-1" href="./${esc(task.link || 'notes.html')}" style="${task.done ? 'text-decoration:line-through;opacity:0.6;' : ''}">
        <div class="list-item-title">${esc(taskTitle(task))}</div>
        <div class="list-item-sub">${esc(task.params?.course || '')}</div>
      </a>
      <span class="badge">${esc(String(task.minutes || 10))} min</span>
    </li>`).join('');

  list.querySelectorAll('[data-complete-task]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const taskId = btn.dataset.completeTask;
      btn.disabled = true;
      try {
        const { data: updated, error } = await db.rpc('pran_not_complete_plan_task', { p_task_id: taskId });
        if (error) throw error;
        renderPlan(updated);
        toast('+15 XP', 'success');
      } catch (err) {
        btn.disabled = false;
        handleError(err);
      }
    });
  });

  icons(list);
}

function renderStats(stats, profile) {
  const box = document.getElementById('dash-stats');
  const streakCur = stats?.streak?.current ?? 0;
  const streakBest = stats?.streak?.longest ?? 0;
  const today = new Date().toISOString().slice(0, 10);
  const activeToday = stats?.streak?.last_active_date === today;
  const due = stats?.due_cards ?? 0;
  const xp = stats?.xp ?? profile?.xp ?? 0;
  const level = stats?.level ?? profile?.xp_level ?? 1;
  const notesTotal = stats?.notes_total ?? 0;

  box.innerHTML = `
    <article class="card card-sm stat">
      <span class="stat-label">${icon('flame')}<span>${esc(t('dashboard.streak_label'))}</span></span>
      <div class="stat-value">${streakCur} j</div>
      <span class="stat-sub">${activeToday ? `Record : ${streakBest} j` : esc(t('dashboard.streak_risk', { days: streakCur }))}</span>
    </article>
    <article class="card card-sm stat">
      <span class="stat-label">${icon('layers')}<span>${esc(t('dashboard.due_label'))}</span></span>
      <div class="stat-value">${due}</div>
      <span class="stat-sub"><a href="./review.html" style="color:var(--c-accent-text);font-weight:600;text-decoration:none;">${esc(t('dashboard.start_review'))}</a></span>
    </article>
    <article class="card card-sm stat">
      <span class="stat-label">${icon('notebook-pen')}<span>${esc(t('nav.notes'))}</span></span>
      <div class="stat-value">${notesTotal}</div>
      <span class="stat-sub"><a href="./notes.html" style="color:var(--c-navy);text-decoration:none;">${esc(t('common.open'))}</a></span>
    </article>
    <article class="card card-sm stat">
      <span class="stat-label">${icon('zap')}<span>${esc(t('dashboard.xp_label', { level }))}</span></span>
      <div class="stat-value">${xp} XP</div>
      <span class="stat-sub">${esc(profile?.faculty?.[getLang() === 'fr' ? 'name_fr' : 'name_ht'] || '')}</span>
    </article>`;

  const mins = stats?.minutes_today ?? 0;
  const goal = profile?.daily_goal_minutes ?? 30;
  const pct = Math.min(100, Math.round((mins / Math.max(1, goal)) * 100));
  document.getElementById('goal-minutes-val').textContent = `${mins} min`;
  document.getElementById('goal-target-sub').textContent = `/ ${goal} min (${pct}%)`;
  document.getElementById('goal-ring-box').innerHTML = ringSvg(pct, { size: 88, stroke: 8 });

  // Échéances
  const deadlines = stats?.upcoming_assignments || [];
  const dBox = document.getElementById('deadlines-box');
  dBox.innerHTML = deadlines.length
    ? `<ul class="list">${deadlines.map((a) => `
        <li class="list-item">
          <div class="flex-1">
            <a class="list-item-title" href="./assignment.html?id=${esc(a.id)}">${esc(a.title)}</a>
            <div class="list-item-sub">${esc(a.course_name || '')}</div>
          </div>
          <span class="badge badge-warning">${esc(formatRelative(a.due_at))}</span>
        </li>`).join('')}</ul>`
    : `<p class="text-sm muted mb-0">${esc(t('dashboard.deadlines_empty'))}</p>`;

  // Cours à risque
  const risks = stats?.at_risk_courses || [];
  const rBox = document.getElementById('risk-courses-box');
  rBox.innerHTML = risks.length
    ? `<div class="stack-sm">${risks.map((c) => `
        <a class="card card-sm card-link" href="./course.html?id=${esc(c.id)}">
          <div class="row-between">
            <div class="row">
              <span class="course-dot" style="background:${esc(c.color || '#F97316')}"></span>
              <strong class="text-sm">${esc(c.name)}</strong>
            </div>
            <span class="badge badge-error">${Math.round(c.mastery || 0)}%</span>
          </div>
        </a>`).join('')}</div>`
    : `<p class="text-sm muted mb-0">${esc(t('dashboard.risk_empty'))}</p>`;

  // Badges récents
  const badges = stats?.badges_recent || [];
  const bBox = document.getElementById('badges-box');
  const lang = getLang();
  bBox.innerHTML = badges.length
    ? `<div class="row-wrap">${badges.map((b) => `
        <span class="badge badge-accent">${icon(b.icon || 'award')}<span>${esc(lang === 'fr' ? b.name_fr : b.name_ht)}</span></span>
      `).join('')}</div>`
    : `<p class="text-sm muted mb-0">${esc(t('common.none'))}</p>`;

  icons(document.body);
  animateIn('#dash-stats .card');
}

(async () => {
  const { user, profile } = await requireAuth();
  const firstName = (profile?.full_name || user?.email || '').split(/\s+/)[0];
  document.getElementById('dash-greeting').textContent = tPick('dashboard.greetings', dayOfYear(), { name: firstName });
  const facName = profile?.faculty?.[getLang() === 'fr' ? 'name_fr' : 'name_ht'];
  document.getElementById('dash-subtitle').textContent = [profile?.university, facName, profile?.level ? t(`onboarding.levels.${profile.level}`) : ''].filter(Boolean).join(' • ');

  // Défi du jour par faculté
  const facKey = ['medecine', 'droit', 'sciences_info', 'genie', 'sciences_eco'].includes(profile?.faculty_id)
    ? profile.faculty_id
    : 'autre';
  document.getElementById('challenge-text').textContent = t(`dashboard.challenges.${facKey}`);

  let stats = null;
  let plan = null;

  try {
    await recordActivity();
    const [sRes, pRes] = await Promise.all([db.rpc('pran_not_get_dashboard_stats'), db.rpc('pran_not_get_daily_plan')]);
    if (sRes.error) throw sRes.error;
    if (pRes.error) throw pRes.error;
    stats = sRes.data;
    plan = pRes.data;
    await cacheSet('dashboard_stats', stats);
    await cacheSet('daily_plan', plan);
  } catch (err) {
    stats = await cacheGet('dashboard_stats');
    plan = await cacheGet('daily_plan');
    if (!stats && !plan) handleError(err);
  }

  await initAppChrome({ profile, user, active: 'dashboard', dueCount: stats?.due_cards || 0 });
  setTutorContext({ contextType: 'general', contextTitle: t('nav.home') });
  pageEnter();

  if (stats) renderStats(stats, profile);
  if (plan) renderPlan(plan);

  document.getElementById('refresh-plan-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const { data, error } = await db.rpc('pran_not_refresh_daily_plan');
      if (error) throw error;
      renderPlan(data);
      toast(t('common.saved'), 'success');
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  const challengeBtn = document.getElementById('challenge-done-btn');
  const chKey = `prannot.challenge.${new Date().toISOString().slice(0, 10)}`;
  if (localStorage.getItem(chKey)) {
    challengeBtn.disabled = true;
    challengeBtn.textContent = t('dashboard.plan_done');
  }
  challengeBtn.addEventListener('click', async () => {
    challengeBtn.disabled = true;
    localStorage.setItem(chKey, '1');
    await awardXp(20, 'daily_challenge');
    toast('+20 XP', 'success');
  });
})();
