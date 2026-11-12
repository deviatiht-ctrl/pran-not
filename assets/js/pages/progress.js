/* =====================================================================
   PRAN NÒT - pages/progress.js
   Statistiques d'étude, comparaison semaine après semaine,
   courbes Chart.js et maîtrise par cours.
   ===================================================================== */
import '../supabase.js';
import { requireAuth } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t } from '../i18n.js';
import { icons, icon, esc, formatMinutes, loadScript, CDN, pageEnter } from '../utils.js';
import { getThemeChartPalette } from '../theme.js';

const db = window.db;

(async () => {
  const { user, profile } = await requireAuth();
  await initAppChrome({ profile, user, active: 'profile' });
  setTutorContext({ contextType: 'general', contextTitle: t('progress.title') });
  pageEnter();

  const [sessRes, attRes, cardRes, courseRes] = await Promise.all([
    db.from('pran_not_study_sessions').select('duration_minutes, started_at').order('started_at', { ascending: false }).limit(200),
    db.from('pran_not_test_attempts').select('percent, created_at').not('finished_at', 'is', null).order('created_at', { ascending: true }).limit(40),
    db.from('pran_not_flashcards').select('interval_days').gte('interval_days', 7),
    db.from('pran_not_courses').select('name, mastery, color').eq('archived', false),
  ]);

  const sessions = sessRes.data || [];
  const attempts = attRes.data || [];
  const masteredCards = (cardRes.data || []).length;
  const courses = courseRes.data || [];

  const totalMin = sessions.reduce((a, b) => a + (b.duration_minutes || 0), 0);
  const avgScore = attempts.length
    ? Math.round(attempts.reduce((a, b) => a + Number(b.percent || 0), 0) / attempts.length)
    : 0;

  // Comparaison semaine courante vs semaine précédente
  const now = Date.now();
  const thisWeekAtt = attempts.filter((a) => now - new Date(a.created_at).getTime() <= 7 * 86400000);
  const prevWeekAtt = attempts.filter((a) => {
    const age = now - new Date(a.created_at).getTime();
    return age > 7 * 86400000 && age <= 14 * 86400000;
  });
  const thisAvg = thisWeekAtt.length ? Math.round(thisWeekAtt.reduce((a, b) => a + Number(b.percent), 0) / thisWeekAtt.length) : null;
  const prevAvg = prevWeekAtt.length ? Math.round(prevWeekAtt.reduce((a, b) => a + Number(b.percent), 0) / prevWeekAtt.length) : null;
  const deltaStr = thisAvg !== null && prevAvg !== null ? `${thisAvg - prevAvg >= 0 ? '+' : ''}${thisAvg - prevAvg}% vs semèn pase` : '';

  document.getElementById('prog-kpis').innerHTML = `
    <article class="card card-sm stat">
      <span class="stat-label">${icon('clock')}<span>${esc(t('progress.study_time'))}</span></span>
      <div class="stat-value">${esc(formatMinutes(totalMin))}</div>
      <span class="stat-sub">${sessions.length} sesyon</span>
    </article>
    <article class="card card-sm stat">
      <span class="stat-label">${icon('check-circle-2')}<span>${esc(t('progress.test_avg'))}</span></span>
      <div class="stat-value">${avgScore}%</div>
      <span class="stat-sub">${esc(deltaStr || `${attempts.length} tès`)}</span>
    </article>
    <article class="card card-sm stat">
      <span class="stat-label">${icon('layers')}<span>${esc(t('progress.cards_mastered'))}</span></span>
      <div class="stat-value">${masteredCards}</div>
      <span class="stat-sub">Entèval >= 7 jou</span>
    </article>`;
  icons(document.getElementById('prog-kpis'));

  await loadScript(CDN.chart);
  const pal = getThemeChartPalette();
  const baseScales = {
    x: { ticks: { color: pal.muted }, grid: { color: pal.grid } },
    y: { min: 0, max: 100, ticks: { color: pal.muted }, grid: { color: pal.grid } },
  };

  if (attempts.length) {
    new window.Chart(document.getElementById('chart-weekly'), {
      type: 'line',
      data: {
        labels: attempts.map((a) => new Date(a.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })),
        datasets: [{
          label: '%',
          data: attempts.map((a) => Math.round(Number(a.percent || 0))),
          borderColor: pal.accent,
          backgroundColor: pal.accentSoft,
          fill: true,
          tension: 0.35,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: baseScales, plugins: { legend: { display: false } } },
    });
  }

  if (courses.length) {
    new window.Chart(document.getElementById('chart-courses'), {
      type: 'bar',
      data: {
        labels: courses.map((c) => c.name.slice(0, 18)),
        datasets: [{
          label: '%',
          data: courses.map((c) => Math.round(Number(c.mastery || 0))),
          backgroundColor: pal.primary,
          borderRadius: 6,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: baseScales, plugins: { legend: { display: false } } },
    });
  }
})();
