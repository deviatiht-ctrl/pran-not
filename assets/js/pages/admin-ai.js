/* =====================================================================
   PRAN NÒT - pages/admin-ai.js
   Administration IA : fournisseurs gratuits, priorités/quotas,
   prompts système modifiables à chaud, journaux ai_usage et file ai_jobs.
   ===================================================================== */
import '../supabase.js';
import { initAdminPage } from './admin-common.js';
import { t, getLang, formatRelative } from '../i18n.js';
import {
  esc, icon, icons, emptyState, errorState, openModal, confirmDialog, toast, handleError, setLoading, loadScript, CDN,
} from '../utils.js';
import { getThemeChartPalette } from '../theme.js';

const db = window.db;
let facultiesList = [];
let providerChart = null;

async function loadProviders() {
  const box = document.getElementById('providers-grid');
  try {
    const { data, error } = await db.from('pran_not_ai_providers').select('*').order('priority', { ascending: true });
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) {
      box.innerHTML = emptyState({ icon: 'server', title: t('common.none') });
      icons(box);
      return;
    }

    box.innerHTML = rows.map((p) => {
      const badge = p.status === 'active'
        ? 'badge-success'
        : p.status === 'exhausted'
          ? 'badge-warning'
          : 'badge-error';
      const pct = p.daily_quota ? Math.min(100, Math.round((p.used_today / p.daily_quota) * 100)) : 0;
      return `<article class="card admin-provider-card">
        <div class="row-between">
          <div>
            <h2 class="card-title mb-0">${esc(p.name)}</h2>
            <span class="text-xs muted">ID: ${esc(p.id)} — Priorite #${p.priority}</span>
          </div>
          <span class="badge ${badge}">${esc(p.status)}</span>
        </div>

        <div>
          <div class="row-between text-xs muted mb-1">
            <span>Jodi a (${esc(String(p.quota_date))})</span>
            <strong>${p.used_today} / ${p.daily_quota} (${pct}%)</strong>
          </div>
          <div class="progress"><span style="width:${pct}%"></span></div>
        </div>

        <div class="stack-sm text-xs muted">
          ${p.model_text ? `<div><strong>Tèks :</strong> <code>${esc(p.model_text)}</code></div>` : ''}
          ${p.model_vision ? `<div><strong>Vizyon :</strong> <code>${esc(p.model_vision)}</code></div>` : ''}
          ${p.model_audio ? `<div><strong>Odyo :</strong> <code>${esc(p.model_audio)}</code></div>` : ''}
          <div><strong>Tach :</strong> ${esc((p.tasks || []).join(', '))}</div>
        </div>

        ${p.last_error ? `
          <div class="alert alert-warning text-xs">
            ${icon('alert-triangle')}
            <div class="flex-1">${esc(p.last_error)} ${p.last_error_at ? `(${esc(formatRelative(p.last_error_at))})` : ''}</div>
          </div>` : ''}

        <div class="row-wrap mt-2">
          <button type="button" class="btn btn-sm btn-secondary" data-edit-prov="${esc(p.id)}">
            ${icon('sliders')}<span>${esc(t('common.edit'))}</span>
          </button>
          <button type="button" class="btn btn-sm btn-secondary" data-reset-prov="${esc(p.id)}">
            ${icon('rotate-ccw')}<span>${esc(t('admin.reset_counter'))}</span>
          </button>
        </div>
      </article>`;
    }).join('');
    icons(box);

    const byId = new Map(rows.map((r) => [r.id, r]));
    box.querySelectorAll('[data-edit-prov]').forEach((btn) => {
      btn.addEventListener('click', () => openProviderModal(byId.get(btn.dataset.editProv)));
    });
    box.querySelectorAll('[data-reset-prov]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const { error } = await db
            .from('pran_not_ai_providers')
            .update({ used_today: 0, status: 'active', last_error: null, last_error_at: null })
            .eq('id', btn.dataset.resetProv);
          if (error) throw error;
          toast(t('common.saved'), 'success');
          loadProviders();
        } catch (err) {
          handleError(err);
        }
      });
    });
  } catch (err) {
    box.innerHTML = `<div style="grid-column:1 / -1">${errorState(handleError(err), loadProviders)}</div>`;
    icons(box);
  }
}

function openProviderModal(prov) {
  if (!prov) return;
  const m = openModal({
    title: prov.name,
    body: `
      <form id="prov-form" class="stack-sm">
        <div class="form-row">
          <div class="field">
            <label for="prov-status">Statut</label>
            <select class="select" id="prov-status">
              <option value="active" ${prov.status === 'active' ? 'selected' : ''}>active</option>
              <option value="disabled" ${prov.status === 'disabled' ? 'selected' : ''}>disabled</option>
              <option value="exhausted" ${prov.status === 'exhausted' ? 'selected' : ''}>exhausted</option>
            </select>
          </div>
          <div class="field">
            <label for="prov-priority">Priorite (pi piti = an premye)</label>
            <input type="number" class="input" id="prov-priority" min="1" max="99" value="${prov.priority}">
          </div>
        </div>
        <div class="field">
          <label for="prov-quota">Kota chak jou / Quota quotidien</label>
          <input type="number" class="input" id="prov-quota" min="0" max="100000" value="${prov.daily_quota}">
        </div>
        <div class="field">
          <label for="prov-model-text">Modèl tèks</label>
          <input class="input" id="prov-model-text" value="${esc(prov.model_text || '')}">
        </div>
        <div class="field">
          <label for="prov-model-vision">Modèl vizyon (${esc(t('common.optional'))})</label>
          <input class="input" id="prov-model-vision" value="${esc(prov.model_vision || '')}">
        </div>
        <div class="field">
          <label for="prov-model-audio">Modèl odyo (${esc(t('common.optional'))})</label>
          <input class="input" id="prov-model-audio" value="${esc(prov.model_audio || '')}">
        </div>
      </form>`,
    footer: `
      <button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
      <button type="button" class="btn btn-primary" id="prov-save-btn">${esc(t('common.save'))}</button>`,
  });

  m.el.querySelector('#prov-save-btn')?.addEventListener('click', async () => {
    const btn = m.el.querySelector('#prov-save-btn');
    setLoading(btn, true);
    try {
      const { error } = await db.from('pran_not_ai_providers').update({
        status: m.el.querySelector('#prov-status').value,
        priority: Number.parseInt(m.el.querySelector('#prov-priority').value, 10) || 10,
        daily_quota: Number.parseInt(m.el.querySelector('#prov-quota').value, 10) || 0,
        model_text: m.el.querySelector('#prov-model-text').value.trim() || null,
        model_vision: m.el.querySelector('#prov-model-vision').value.trim() || null,
        model_audio: m.el.querySelector('#prov-model-audio').value.trim() || null,
      }).eq('id', prov.id);
      if (error) throw error;
      toast(t('common.saved'), 'success');
      m.close();
      loadProviders();
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });
}

async function loadPrompts() {
  const box = document.getElementById('prompts-list');
  const taskFilter = document.getElementById('prompt-task-filter')?.value || 'all';
  try {
    let query = db.from('pran_not_ai_prompts').select('*').order('task').order('faculty_id', { nullsFirst: true }).order('version', { ascending: false });
    if (taskFilter !== 'all') query = query.eq('task', taskFilter);
    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    if (!rows.length) {
      box.innerHTML = emptyState({ icon: 'file-code', title: t('common.none') });
      icons(box);
      return;
    }

    const lang = getLang();
    const facMap = new Map(facultiesList.map((f) => [f.id, lang === 'ht' ? f.name_ht : f.name_fr]));

    box.innerHTML = rows.map((pr) => `
      <article class="card">
        <div class="card-head">
          <div class="stack-sm flex-1">
            <div class="row-wrap">
              <code>${esc(pr.task)}</code>
              <span class="badge">${esc(pr.faculty_id ? (facMap.get(pr.faculty_id) || pr.faculty_id) : 'Tout fakilte')}</span>
              <span class="badge badge-outline">v${pr.version}</span>
              <span class="badge ${pr.active ? 'badge-success' : ''}">${pr.active ? 'Aktif' : 'Inaktif'}</span>
            </div>
            <p class="text-sm mb-0" style="white-space:pre-wrap;">${esc(pr.system_prompt)}</p>
          </div>
          <div class="row-wrap">
            <button type="button" class="btn btn-sm btn-secondary" data-edit-prompt="${esc(pr.id)}">
              ${icon('edit-2')}<span>${esc(t('common.edit'))}</span>
            </button>
          </div>
        </div>
      </article>`).join('');
    icons(box);

    const byId = new Map(rows.map((r) => [r.id, r]));
    box.querySelectorAll('[data-edit-prompt]').forEach((btn) => {
      btn.addEventListener('click', () => openPromptModal(byId.get(btn.dataset.editPrompt)));
    });
  } catch (err) {
    box.innerHTML = errorState(handleError(err), loadPrompts);
    icons(box);
  }
}

function openPromptModal(existing = null) {
  const tasks = [
    'ocr_board', 'transcribe', 'process_note', 'process_syllabus',
    'generate_flashcards', 'generate_test', 'grade_answer', 'tutor', 'assignment_assist', 'explain',
  ];
  const lang = getLang();
  const m = openModal({
    title: existing ? `${t('common.edit')} (${existing.task})` : 'Nouvo enstriksyon / Prompt',
    size: 'lg',
    body: `
      <form id="prompt-form" class="stack-sm">
        <div class="form-row">
          <div class="field">
            <label for="pr-task">Tach / Tâche</label>
            <select class="select" id="pr-task" ${existing ? 'disabled' : ''}>
              ${tasks.map((tk) => `<option value="${tk}" ${existing?.task === tk ? 'selected' : ''}>${tk}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="pr-fac">Fakilte (${esc(t('common.optional'))})</label>
            <select class="select" id="pr-fac" ${existing ? 'disabled' : ''}>
              <option value="">Tout fakilte / Toutes</option>
              ${facultiesList.map((f) => `<option value="${esc(f.id)}" ${existing?.faculty_id === f.id ? 'selected' : ''}>${esc(lang === 'ht' ? f.name_ht : f.name_fr)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field">
          <label for="pr-text">System Prompt (ZEWO emoji / ZÉRO emoji)</label>
          <textarea class="textarea" id="pr-text" rows="8" required style="font-family:var(--font-mono);font-size:13px;">${esc(existing?.system_prompt || '')}</textarea>
        </div>
        <label class="switch">
          <input type="checkbox" id="pr-active" ${existing ? (existing.active ? 'checked' : '') : 'checked'}>
          <span class="switch-track"></span>
          <span>Aktif / Activer immédiatement</span>
        </label>
      </form>`,
    footer: `
      <button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
      <button type="button" class="btn btn-primary" id="pr-save-btn">${esc(t('common.save'))}</button>`,
  });

  m.el.querySelector('#pr-save-btn')?.addEventListener('click', async () => {
    const btn = m.el.querySelector('#pr-save-btn');
    const task = m.el.querySelector('#pr-task').value;
    const fac = m.el.querySelector('#pr-fac').value || null;
    const text = m.el.querySelector('#pr-text').value.trim();
    const active = m.el.querySelector('#pr-active').checked;
    if (!text) {
      toast(t('errors.required'), 'warning');
      return;
    }

    setLoading(btn, true);
    try {
      // Un seul prompt actif autorisé par (task, faculty_id) : désactiver l'ancien si nécessaire
      if (active) {
        let deact = db.from('pran_not_ai_prompts').update({ active: false }).eq('task', task).eq('active', true);
        deact = fac ? deact.eq('faculty_id', fac) : deact.is('faculty_id', null);
        if (existing) deact = deact.neq('id', existing.id);
        await deact;
      }

      if (existing) {
        const { error } = await db
          .from('pran_not_ai_prompts')
          .update({
            system_prompt: text,
            active,
            version: (existing.version || 1) + 1,
          })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await db
          .from('pran_not_ai_prompts')
          .insert({
            task,
            faculty_id: fac,
            system_prompt: text,
            version: 1,
            active,
          });
        if (error) throw error;
      }
      toast(t('common.saved'), 'success');
      m.close();
      loadPrompts();
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });
}

async function loadLogsAndJobs() {
  const kpiBox = document.getElementById('ai-logs-kpis');
  const tableBox = document.getElementById('ai-usage-table');
  const jobsBox = document.getElementById('ai-jobs-box');
  const errorsOnly = document.getElementById('logs-errors-only')?.checked;

  try {
    let usageQ = db.from('pran_not_ai_usage').select('*').order('created_at', { ascending: false }).limit(200);
    if (errorsOnly) usageQ = usageQ.eq('success', false);

    const [usageRes, jobsRes] = await Promise.all([
      usageQ,
      db.from('pran_not_ai_jobs').select('*').order('created_at', { ascending: false }).limit(60),
    ]);
    if (usageRes.error) throw usageRes.error;
    if (jobsRes.error) throw jobsRes.error;

    const logs = usageRes.data || [];
    const total = logs.length;
    const cachedCount = logs.filter((l) => l.cached).length;
    const errCount = logs.filter((l) => !l.success).length;
    const latencies = logs.filter((l) => l.latency_ms > 0).map((l) => l.latency_ms);
    const avgLat = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

    kpiBox.innerHTML = `
      <article class="card card-sm stat">
        <span class="stat-label">${icon('activity')}<span>Rele / Appels</span></span>
        <div class="stat-value">${total}</div>
      </article>
      <article class="card card-sm stat">
        <span class="stat-label">${icon('zap')}<span>Cache Hits</span></span>
        <div class="stat-value">${total ? Math.round((cachedCount / total) * 100) : 0}%</div>
      </article>
      <article class="card card-sm stat">
        <span class="stat-label">${icon('alert-circle')}<span>Erè / Échecs</span></span>
        <div class="stat-value">${errCount}</div>
      </article>
      <article class="card card-sm stat">
        <span class="stat-label">${icon('clock')}<span>Latans mwayèn</span></span>
        <div class="stat-value">${avgLat} ms</div>
      </article>`;
    icons(kpiBox);

    // Graphique par fournisseur
    const byProv = new Map();
    logs.forEach((l) => {
      const k = l.provider || (l.cached ? 'cache' : 'unknown');
      byProv.set(k, (byProv.get(k) || 0) + 1);
    });
    await loadScript(CDN.chart);
    const pal = getThemeChartPalette();
    if (providerChart) providerChart.destroy();
    providerChart = new window.Chart(document.getElementById('admin-ai-chart'), {
      type: 'bar',
      data: {
        labels: Array.from(byProv.keys()),
        datasets: [{
          data: Array.from(byProv.values()),
          backgroundColor: pal.accent,
          borderRadius: 6,
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

    if (!logs.length) {
      tableBox.innerHTML = emptyState({ icon: 'activity', title: t('common.none') });
      icons(tableBox);
    } else {
      tableBox.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Dat</th>
                <th>Tach</th>
                <th>Founisè / Modèl</th>
                <th>Tokens (in/out)</th>
                <th>Latans</th>
                <th>Eta</th>
              </tr>
            </thead>
            <tbody>
              ${logs.slice(0, 60).map((l) => `<tr>
                <td class="text-xs muted">${esc(formatRelative(l.created_at))}</td>
                <td><code>${esc(l.task)}</code></td>
                <td>
                  <strong>${esc(l.provider || (l.cached ? 'cache' : '—'))}</strong>
                  <div class="text-xs muted">${esc(l.model || '')}</div>
                </td>
                <td class="text-xs">${l.tokens_in || 0} / ${l.tokens_out || 0}</td>
                <td class="text-xs muted">${l.latency_ms ? `${l.latency_ms} ms` : '—'}</td>
                <td>
                  ${l.cached ? '<span class="badge badge-info">Cache</span>' : ''}
                  ${l.success
                    ? '<span class="badge badge-success">OK</span>'
                    : `<span class="badge badge-error" title="${esc(l.error || '')}">Erè</span>`}
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }

    // File ai_jobs
    const jobs = jobsRes.data || [];
    if (!jobs.length) {
      jobsBox.innerHTML = `<p class="muted text-sm mb-0">${esc(t('common.none'))}</p>`;
    } else {
      jobsBox.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Tach</th>
                <th>Statut</th>
                <th>Esè</th>
                <th>Erè</th>
                <th>Dat</th>
                <th>Aksyon</th>
              </tr>
            </thead>
            <tbody>
              ${jobs.map((j) => {
                const b = j.status === 'done'
                  ? 'badge-success'
                  : j.status === 'error'
                    ? 'badge-error'
                    : j.status === 'running'
                      ? 'badge-info'
                      : 'badge-warning';
                return `<tr>
                  <td><code>${esc(j.task)}</code></td>
                  <td><span class="badge ${b}">${esc(j.status)}</span></td>
                  <td class="text-xs">${j.attempts}</td>
                  <td class="text-xs muted">${esc((j.error || '—').slice(0, 80))}</td>
                  <td class="text-xs muted">${esc(formatRelative(j.created_at))}</td>
                  <td>
                    <div class="row-wrap">
                      ${j.status !== 'done' ? `
                        <button type="button" class="btn btn-sm btn-secondary" data-requeue="${esc(j.id)}">
                          ${icon('rotate-cw')}<span>Relanse</span>
                        </button>` : ''}
                      <button type="button" class="btn btn-sm btn-danger" data-del-job="${esc(j.id)}">
                        ${icon('trash-2')}
                      </button>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
      icons(jobsBox);

      jobsBox.querySelectorAll('[data-requeue]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            const { error } = await db
              .from('pran_not_ai_jobs')
              .update({ status: 'queued', attempts: 0, error: null, run_after: new Date().toISOString() })
              .eq('id', btn.dataset.requeue);
            if (error) throw error;
            toast(t('common.saved'), 'success');
            loadLogsAndJobs();
          } catch (err) {
            handleError(err);
          }
        });
      });
      jobsBox.querySelectorAll('[data-del-job]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: t('common.delete'), confirmLabel: t('common.delete'), danger: true });
          if (!ok) return;
          try {
            const { error } = await db.from('pran_not_ai_jobs').delete().eq('id', btn.dataset.delJob);
            if (error) throw error;
            toast(t('common.deleted'), 'success');
            loadLogsAndJobs();
          } catch (err) {
            handleError(err);
          }
        });
      });
    }
  } catch (err) {
    tableBox.innerHTML = errorState(handleError(err), loadLogsAndJobs);
    icons(tableBox);
  }
}

(async () => {
  await initAdminPage('ai');
  const { data } = await db.from('pran_not_faculties').select('id, name_fr, name_ht').order('position');
  facultiesList = data || [];

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((el) => el.setAttribute('aria-selected', el === tab ? 'true' : 'false'));
      const key = tab.dataset.tab;
      document.getElementById('panel-providers').hidden = key !== 'providers';
      document.getElementById('panel-prompts').hidden = key !== 'prompts';
      document.getElementById('panel-logs').hidden = key !== 'logs';
      if (key === 'prompts') loadPrompts();
      if (key === 'logs') loadLogsAndJobs();
    });
  });

  document.getElementById('prompt-task-filter')?.addEventListener('change', loadPrompts);
  document.getElementById('logs-errors-only')?.addEventListener('change', loadLogsAndJobs);
  document.getElementById('new-prompt-btn')?.addEventListener('click', () => openPromptModal());

  await loadProviders();
})();
