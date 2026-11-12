/* =====================================================================
   PRAN NÒT - pages/admin-dashboard.js
   Vue d'ensemble administrateur : statistiques RPC, courbes Chart.js
   et état des fournisseurs IA.
   ===================================================================== */
import '../supabase.js';
import { initAdminPage } from './admin-common.js';
import { t, getLang, formatRelative } from '../i18n.js';
import {
  esc, icon, icons, errorState, loadScript, CDN, animateIn, handleError,
} from '../utils.js';
import { getThemeChartPalette } from '../theme.js';

const db = window.db;
let signupsChart = null;
let facultyChart = null;

async function loadOverview() {
  const kpiBox = document.getElementById('admin-kpis');
  const provBox = document.getElementById('admin-providers-box');

  try {
    const [statsRes, facRes, provRes] = await Promise.all([
      db.rpc('pran_not_admin_stats'),
      db.from('pran_not_faculties').select('id, name_fr, name_ht'),
      db.from('pran_not_ai_providers').select('*').order('priority', { ascending: true }),
    ]);

    if (statsRes.error) throw statsRes.error;
    const stats = statsRes.data || {};
    const faculties = facRes.data || [];
    const providers = provRes.data || [];
    const lang = getLang();

    const facMap = new Map(faculties.map((f) => [f.id, lang === 'ht' ? f.name_ht : f.name_fr]));

    kpiBox.innerHTML = `
      <article class="card card-sm stat">
        <span class="stat-label">${icon('users')}<span>${esc(t('admin.kpi_users'))}</span></span>
        <div class="stat-value">${stats.users_total || 0}</div>
        <span class="stat-sub">${esc(t('admin.kpi_active_7d', { count: stats.users_active_7d || 0 }))}</span>
      </article>
      <article class="card card-sm stat">
        <span class="stat-label">${icon('user-plus')}<span>${esc(t('admin.kpi_new_7d'))}</span></span>
        <div class="stat-value">${stats.users_new_7d || 0}</div>
        <span class="stat-sub">7 dènye jou / 7 derniers j.</span>
      </article>
      <article class="card card-sm stat">
        <span class="stat-label">${icon('notebook-pen')}<span>${esc(t('admin.kpi_notes'))}</span></span>
        <div class="stat-value">${stats.notes_total || 0}</div>
        <span class="stat-sub">Pran Nòt</span>
      </article>
      <article class="card card-sm stat">
        <span class="stat-label">${icon('layers')}<span>${esc(t('admin.kpi_cards'))}</span></span>
        <div class="stat-value">${stats.cards_total || 0}</div>
        <span class="stat-sub">${esc(t('admin.kpi_reviews_7d', { count: stats.reviews_7d || 0 }))}</span>
      </article>
      <article class="card card-sm stat">
        <span class="stat-label">${icon('check-circle-2')}<span>${esc(t('admin.kpi_tests_7d'))}</span></span>
        <div class="stat-value">${stats.tests_7d || 0}</div>
        <span class="stat-sub">7 j</span>
      </article>
      <article class="card card-sm stat">
        <span class="stat-label">${icon('cpu')}<span>${esc(t('admin.kpi_ai_today'))}</span></span>
        <div class="stat-value">${stats.ai_calls_today || 0}</div>
        <span class="stat-sub">${esc(t('admin.kpi_ai_errors', { count: stats.ai_errors_today || 0 }))}</span>
      </article>
      <a class="card card-sm card-link stat ${stats.reports_open > 0 ? 'card-accent' : ''}" href="./content.html">
        <span class="stat-label">${icon('flag')}<span>${esc(t('admin.kpi_reports'))}</span></span>
        <div class="stat-value">${stats.reports_open || 0}</div>
        <span class="stat-sub">${esc(t('common.open'))}</span>
      </a>
      <a class="card card-sm card-link stat" href="./users.html">
        <span class="stat-label">${icon('shield')}<span>${esc(t('admin.nav_users'))}</span></span>
        <div class="stat-value">${esc(t('common.open'))}</div>
        <span class="stat-sub">${esc(t('admin.quota_label'))}</span>
      </a>`;
    icons(kpiBox);
    animateIn('#admin-kpis > *');

    // Fournisseurs IA
    if (!providers.length) {
      provBox.innerHTML = `<p class="muted text-sm mb-0">${esc(t('common.none'))}</p>`;
    } else {
      provBox.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Founisè / Provider</th>
                <th>Statut</th>
                <th>Priorite</th>
                <th>Itilizasyon / Quota</th>
                <th>Dènye erè</th>
              </tr>
            </thead>
            <tbody>
              ${providers.map((p) => {
                const badge = p.status === 'active'
                  ? 'badge-success'
                  : p.status === 'exhausted'
                    ? 'badge-warning'
                    : 'badge-error';
                const pct = p.daily_quota ? Math.min(100, Math.round((p.used_today / p.daily_quota) * 100)) : 0;
                return `<tr>
                  <td><strong>${esc(p.name)}</strong><div class="text-xs muted">${esc(p.model_text || '')}</div></td>
                  <td><span class="badge ${badge}">${esc(p.status)}</span></td>
                  <td>#${p.priority}</td>
                  <td>
                    <div class="text-xs mb-1">${p.used_today} / ${p.daily_quota} (${pct}%)</div>
                    <div class="progress progress-sm" style="max-width:160px"><span style="width:${pct}%"></span></div>
                  </td>
                  <td class="text-xs muted">${p.last_error ? `${esc(p.last_error.slice(0, 90))}${p.last_error_at ? ` (${esc(formatRelative(p.last_error_at))})` : ''}` : '—'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    }

    // Graphiques Chart.js
    await loadScript(CDN.chart);

    const signupRows = stats.signups_30d || [];
    const byDayMap = new Map(signupRows.map((r) => [String(r.day).slice(0, 10), Number(r.total || 0)]));
    const dayLabels = [];
    const dayValues = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const iso = d.toISOString().slice(0, 10);
      dayLabels.push(d.toLocaleDateString(lang === 'ht' ? 'fr-HT' : 'fr-FR', { day: 'numeric', month: 'short' }));
      dayValues.push(byDayMap.get(iso) || 0);
    }

    const pal = getThemeChartPalette();
    if (signupsChart) signupsChart.destroy();
    signupsChart = new window.Chart(document.getElementById('admin-chart-signups'), {
      type: 'line',
      data: {
        labels: dayLabels,
        datasets: [{
          label: t('admin.kpi_users'),
          data: dayValues,
          borderColor: pal.accent,
          backgroundColor: pal.accentSoft,
          fill: true,
          tension: 0.3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: pal.muted }, grid: { color: pal.grid } },
          y: { beginAtZero: true, ticks: { precision: 0, color: pal.muted }, grid: { color: pal.grid } },
        },
        plugins: { legend: { display: false } },
      },
    });

    const facRows = stats.by_faculty || [];
    if (facultyChart) facultyChart.destroy();
    facultyChart = new window.Chart(document.getElementById('admin-chart-faculty'), {
      type: 'bar',
      data: {
        labels: facRows.map((r) => facMap.get(r.faculty) || r.faculty || '—'),
        datasets: [{
          data: facRows.map((r) => Number(r.total || 0)),
          backgroundColor: pal.primary,
          borderRadius: 6,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0, color: pal.muted }, grid: { color: pal.grid } },
          y: { ticks: { color: pal.muted }, grid: { color: pal.grid } },
        },
        plugins: { legend: { display: false } },
      },
    });
  } catch (err) {
    kpiBox.innerHTML = `<div style="grid-column:1 / -1">${errorState(handleError(err), loadOverview)}</div>`;
    icons(kpiBox);
  }
}

(async () => {
  await initAdminPage('overview');
  document.getElementById('admin-refresh-btn')?.addEventListener('click', loadOverview);
  await loadOverview();
})();
