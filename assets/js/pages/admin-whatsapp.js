/* =====================================================================
   PRAN NÒT - pages/admin-whatsapp.js
   Panneau admin pou CVISUAL WhatsApp Gateway REST API :
   - Kle API a rete 100 % sou sèvè a (Edge Function whatsapp-gateway)
   - Dual-Lane routing (Fast Lane vs Slow Lane anti-ban Meta)
   - Verifikasyon nimewo, istwa mesaj, webhooks HMAC-SHA256 ak rapèl otomatik
   ===================================================================== */
import '../supabase.js';
import { initAdminPage } from './admin-common.js';
import { t, formatRelative } from '../i18n.js';
import {
  esc, icon, icons, emptyState, errorState, toast, setLoading, confirmDialog, animateIn,
} from '../utils.js';

const db = window.db;
const SLOW_KINDS = new Set(['reminder', 'reminder_7d', 'reminder_2d', 'marketing', 'manual']);
let localLogsCache = [];

async function invokeGateway(payload) {
  const { data: sessionData } = await db.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error('Sesyon ekspire.');

  const res = await db.functions.invoke('whatsapp-gateway', { body: payload });
  if (res.error) {
    let msg = res.error.message || 'Erè sèvè';
    try {
      if (res.error.context && typeof res.error.context.json === 'function') {
        const errJson = await res.error.context.json();
        if (errJson?.message || errJson?.error) {
          msg = `${errJson.code ? `[${errJson.code}] ` : ''}${errJson.message || errJson.error}`;
        }
      }
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.data;
}

function statusBadgeClass(st) {
  const s = String(st || '').toLowerCase();
  if (['sent', 'delivered', 'connected', 'ready', 'ok'].includes(s)) return 'badge-success';
  if (['queued', 'pending', 'processing', 'retrying'].includes(s)) return 'badge-warning';
  if (['failed', 'error', 'cancelled', 'disconnected', 'offline'].includes(s)) return 'badge-error';
  return 'badge-info';
}

function renderKpis(overview) {
  const kpiBox = document.getElementById('wa-kpis');
  const meOk = overview.me?.ok;
  const meData = overview.me?.data || {};
  const tenant = meData.tenant || meData.account || meData;
  const stats = overview.stats || {};

  const statusOk = overview.status?.ok;
  const statusData = overview.status?.data || {};
  const accounts = Array.isArray(statusData.accounts)
    ? statusData.accounts
    : Array.isArray(overview.health?.data?.accounts)
      ? overview.health.data.accounts
      : [];
  const connectedLines = accounts.filter((a) => ['connected', 'ready', 'open'].includes(String(a.status || a.state || '').toLowerCase())).length;

  const dailyUsed = tenant.daily_used ?? tenant.usage?.daily ?? 0;
  const dailyQuota = tenant.daily_quota ?? tenant.quotas?.daily ?? '—';

  kpiBox.innerHTML = `
    <article class="card card-sm stat">
      <span class="stat-label">${icon('key-round')}<span>Kont CVISUAL (/me)</span></span>
      <div class="stat-value text-sm" style="font-size:1.05rem;">${esc(meOk ? (tenant.name || tenant.email || 'Konekte') : (overview.me?.code || 'Erè'))}</div>
      <span class="stat-sub">${esc(meOk ? `${tenant.plan_tier || 'live'} • ${dailyUsed} / ${dailyQuota} jodi a` : (overview.me?.error || 'Verifye kle API a'))}</span>
    </article>
    <article class="card card-sm stat">
      <span class="stat-label">${icon('smartphone')}<span>Liy WhatsApp aktif</span></span>
      <div class="stat-value">${accounts.length ? `${connectedLines} / ${accounts.length}` : (statusOk ? 'OK' : '—')}</div>
      <span class="stat-sub">${esc(overview.health?.ok ? 'Gateway sou entènèt' : 'Gateway ap reveye / HS')}</span>
    </article>
    <article class="card card-sm stat">
      <span class="stat-label">${icon('users')}<span>Etidyan ak WhatsApp</span></span>
      <div class="stat-value">${stats.students_with_whatsapp ?? 0}</div>
      <span class="stat-sub">Opt-in rapèl aktive</span>
    </article>
    <article class="card card-sm stat">
      <span class="stat-label">${icon('clock')}<span>Etidyan inaktif elijib</span></span>
      <div class="stat-value">${stats.inactive_candidates ?? 0}</div>
      <span class="stat-sub">Depase ${overview.settings?.inactivity_days ?? 2} jou inaktivite</span>
    </article>`;
  icons(kpiBox);
  animateIn('#wa-kpis > *');
}

function renderClusterBox(overview) {
  const box = document.getElementById('wa-cluster-box');
  const meOk = overview.me?.ok;
  const meData = overview.me?.data || {};
  const tenant = meData.tenant || meData.account || meData;
  const statusData = overview.status?.data || overview.health?.data || {};
  const accounts = Array.isArray(statusData.accounts) ? statusData.accounts : [];

  box.innerHTML = `
    <div class="row-between mb-3">
      <h2 class="card-title mb-0">Sante Gateway & Liy WhatsApp (/status)</h2>
      <span class="badge ${meOk ? 'badge-success' : 'badge-error'}">${esc(meOk ? 'Otantifye' : (overview.me?.code || 'Dekonekte'))}</span>
    </div>
    ${!meOk ? `
      <div class="alert alert-warning text-sm mb-3">
        ${icon('alert-triangle')}
        <div>${esc(overview.me?.error || 'Koneksyon /api/v1/me echwe.')}</div>
      </div>` : ''}
    ${meOk ? `
      <div class="row-wrap text-xs muted mb-3">
        <span><strong>Imèl kont :</strong> ${esc(tenant.email || '—')}</span>
        <span><strong>Plan :</strong> ${esc(tenant.plan_tier || '—')}</span>
        <span><strong>Kota mwa :</strong> ${esc(String(tenant.monthly_used ?? 0))} / ${esc(String(tenant.monthly_quota ?? '—'))}</span>
      </div>` : ''}
    ${accounts.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Nimewo / Liy</th>
              <th>Eta</th>
              <th>Slow Lane jodi a</th>
            </tr>
          </thead>
          <tbody>
            ${accounts.map((a, idx) => `<tr>
              <td>#${esc(String(a.index ?? idx))}</td>
              <td><code>${esc(a.phone || a.number || a.jid || '—')}</code></td>
              <td><span class="badge ${statusBadgeClass(a.status || a.state || (a.ready ? 'ready' : 'offline'))}">${esc(a.status || a.state || (a.ready ? 'ready' : 'offline'))}</span></td>
              <td class="text-xs">${esc(String(a.slow_sent_today ?? a.daily_slow_used ?? '—'))} / 25</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : `<p class="text-sm muted mb-0">Pa gen detay liy WhatsApp pou kounye a.</p>`}`;
  icons(box);
}

function populateSettingsForm(settings) {
  if (!settings) return;
  document.getElementById('wa-enabled').checked = Boolean(settings.enabled);
  document.getElementById('wa-welcome-enabled').checked = Boolean(settings.welcome_enabled);
  document.getElementById('wa-deadline-enabled').checked = Boolean(settings.deadline_enabled);
  document.getElementById('wa-class-enabled').checked = settings.class_reminder_enabled !== false;
  document.getElementById('wa-base-url').value = settings.base_url || 'https://cvisual-whatsapp-gateway.onrender.com';
  document.getElementById('wa-inactivity-days').value = settings.inactivity_days || 2;
  document.getElementById('wa-cooldown-hours').value = settings.reminder_cooldown_hours || 48;
  document.getElementById('wa-tpl-ht').value = settings.inactive_template_ht || '';
  document.getElementById('wa-tpl-fr').value = settings.inactive_template_fr || '';
  document.getElementById('wa-tpl-dead-ht').value = settings.deadline_template_ht || '';
  document.getElementById('wa-tpl-dead-fr').value = settings.deadline_template_fr || '';
  document.getElementById('wa-tpl-class-ht').value = settings.class_template_ht || '';
  document.getElementById('wa-tpl-class-fr').value = settings.class_template_fr || '';

  document.getElementById('wa-new-key').value = '';
  document.getElementById('wa-clear-db-key').checked = false;
  document.getElementById('wa-new-secret').value = '';

  const badge = document.getElementById('wa-key-badge');
  if (settings.has_api_key) {
    badge.className = 'badge badge-success';
    badge.textContent = `${settings.api_key_masked} (${settings.key_source === 'database' ? 'Baz done' : 'Secrets sèvè'})`;
  } else {
    badge.className = 'badge badge-error';
    badge.textContent = 'Okenn kle API konfigire';
  }

  document.getElementById('wa-secret-status').textContent = settings.has_webhook_secret
    ? 'Yon sekrè webhook HMAC deja anrejistre sou sèvè a.'
    : 'Pa gen sekrè webhook konfigire ankò.';

  const whInput = document.getElementById('wa-webhook-url');
  if (whInput && settings.webhook_url) whInput.value = settings.webhook_url;
}

function renderLocalLogs(logs) {
  const box = document.getElementById('wa-local-logs-box');
  localLogsCache = logs || [];
  if (!localLogsCache.length) {
    box.innerHTML = emptyState({ icon: 'message-square', title: t('common.none') });
    icons(box);
    return;
  }
  box.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Dat</th>
            <th>Telefòn</th>
            <th>Kalite / Lane</th>
            <th>Eta</th>
            <th>Gateway ID</th>
            <th>Erè</th>
          </tr>
        </thead>
        <tbody>
          ${localLogsCache.map((l) => `<tr>
            <td class="text-xs muted">${esc(formatRelative(l.created_at))}</td>
            <td><code>${esc(l.phone)}</code></td>
            <td><code>${esc(l.kind)}</code> <span class="badge badge-outline">${esc(l.lane)} / ${esc(l.mode)}</span></td>
            <td><span class="badge ${statusBadgeClass(l.status)}">${esc(l.status)}</span></td>
            <td class="text-xs muted"><code>${esc(l.gateway_message_id || '—')}</code></td>
            <td class="text-xs muted">${esc(l.error_code ? `${l.error_code}: ${l.error_message || ''}` : '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

async function loadOverview() {
  try {
    const data = await invokeGateway({ action: 'overview' });
    renderKpis(data);
    renderClusterBox(data);
    populateSettingsForm(data.settings);
    renderLocalLogs(data.logs || []);
  } catch (err) {
    const kpiBox = document.getElementById('wa-kpis');
    kpiBox.innerHTML = `<div style="grid-column:1 / -1">${errorState(err.message, loadOverview)}</div>`;
    icons(kpiBox);
  }
}

async function loadStudentsForPicker() {
  const sel = document.getElementById('wa-student-pick');
  if (!sel) return;
  try {
    const { data } = await db
      .from('pran_not_profiles')
      .select('id, full_name, email, whatsapp_phone')
      .not('whatsapp_phone', 'is', null)
      .order('full_name')
      .limit(100);
    (data || []).forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.whatsapp_phone;
      opt.dataset.uid = s.id;
      opt.textContent = `${s.full_name || s.email} (${s.whatsapp_phone})`;
      sel.appendChild(opt);
    });
  } catch { /* facultatif */ }
}

async function loadMessagesTab() {
  const gwBox = document.getElementById('wa-gw-messages-box');
  gwBox.innerHTML = '<div class="skeleton skeleton-line"></div>';
  try {
    const res = await invokeGateway({ action: 'list_messages', limit: 35 });
    renderLocalLogs(res.local_logs || []);

    if (!res.gateway?.ok) {
      gwBox.innerHTML = `<div class="alert alert-warning text-sm">${icon('alert-triangle')}<div>${esc(res.gateway?.error || 'Pa kapab rale lis CVISUAL la.')}</div></div>`;
      icons(gwBox);
      return;
    }

    const list = res.gateway.data?.messages || res.gateway.data?.items || res.gateway.data?.data || [];
    if (!Array.isArray(list) || !list.length) {
      gwBox.innerHTML = emptyState({ icon: 'inbox', title: t('common.none') });
      icons(gwBox);
      return;
    }

    gwBox.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Destinatè</th>
              <th>Kalite</th>
              <th>Eta</th>
              <th>Dat</th>
              <th>Aksyon</th>
            </tr>
          </thead>
          <tbody>
            ${list.map((m) => {
              const id = String(m.id || m.message_id || '');
              const st = String(m.status || '');
              return `<tr>
                <td class="text-xs"><code>${esc(id.slice(0, 12))}</code></td>
                <td><code>${esc(m.to || m.phone || '—')}</code></td>
                <td><code>${esc(m.kind || '—')}</code> <span class="text-xs muted">${esc(m.lane || m.mode || '')}</span></td>
                <td><span class="badge ${statusBadgeClass(st)}">${esc(st)}</span></td>
                <td class="text-xs muted">${m.created_at ? esc(formatRelative(m.created_at)) : '—'}</td>
                <td>
                  <div class="row-wrap">
                    ${['queued', 'pending'].includes(st.toLowerCase()) ? `
                      <button type="button" class="btn btn-sm btn-secondary" data-wa-cancel="${esc(id)}">Anile</button>` : ''}
                    ${['failed', 'error', 'cancelled'].includes(st.toLowerCase()) ? `
                      <button type="button" class="btn btn-sm btn-secondary" data-wa-retry="${esc(id)}">Re-eseye</button>` : ''}
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
    icons(gwBox);

    gwBox.querySelectorAll('[data-wa-cancel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        setLoading(btn, true);
        try {
          await invokeGateway({ action: 'cancel_message', id: btn.dataset.waCancel });
          toast('Mesaj anile', 'success');
          loadMessagesTab();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          setLoading(btn, false);
        }
      });
    });

    gwBox.querySelectorAll('[data-wa-retry]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        setLoading(btn, true);
        try {
          await invokeGateway({ action: 'retry_message', id: btn.dataset.waRetry });
          toast('Mesaj remet nan fil atant', 'success');
          loadMessagesTab();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          setLoading(btn, false);
        }
      });
    });
  } catch (err) {
    gwBox.innerHTML = errorState(err.message, loadMessagesTab);
    icons(gwBox);
  }
}

async function loadWebhooksTab() {
  const box = document.getElementById('wa-webhooks-box');
  box.innerHTML = '<div class="skeleton skeleton-line"></div>';
  try {
    const res = await invokeGateway({ action: 'list_webhooks' });
    const hooks = res.result?.webhooks || res.result?.items || (Array.isArray(res.result) ? res.result : []);
    if (!hooks.length) {
      box.innerHTML = emptyState({ icon: 'webhook', title: t('common.none') });
      icons(box);
      return;
    }

    box.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>URL</th>
              <th>Evènman</th>
              <th>Eta</th>
              <th>Aksyon</th>
            </tr>
          </thead>
          <tbody>
            ${hooks.map((h) => `<tr>
              <td class="text-xs"><code>${esc(h.url || '—')}</code></td>
              <td class="text-xs">${esc(Array.isArray(h.events) ? h.events.join(', ') : String(h.events || '—'))}</td>
              <td><span class="badge ${h.active === false ? 'badge-warning' : 'badge-success'}">${h.active === false ? 'Inaktif' : 'Aktif'}</span></td>
              <td>
                <div class="row-wrap">
                  <button type="button" class="btn btn-sm btn-secondary" data-wh-test="${esc(h.id)}">Teste</button>
                  <button type="button" class="btn btn-sm btn-danger" data-wh-del="${esc(h.id)}">${icon('trash-2')}</button>
                </div>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    icons(box);

    box.querySelectorAll('[data-wh-test]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        setLoading(btn, true);
        try {
          await invokeGateway({ action: 'test_webhook', id: btn.dataset.whTest });
          toast('Evènman tès webhook la voye.', 'success');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          setLoading(btn, false);
        }
      });
    });

    box.querySelectorAll('[data-wh-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: t('common.delete'), confirmLabel: t('common.delete'), danger: true });
        if (!ok) return;
        try {
          await invokeGateway({ action: 'delete_webhook', id: btn.dataset.whDel });
          toast(t('common.deleted'), 'success');
          loadWebhooksTab();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    box.innerHTML = errorState(err.message, loadWebhooksTab);
    icons(box);
  }
}

function updateDualLaneUi() {
  const kind = document.getElementById('wa-kind').value;
  const modeSel = document.getElementById('wa-mode');
  const hint = document.getElementById('wa-lane-hint');
  const syncOpt = modeSel.querySelector('option[value="sync"]');
  const isSlow = SLOW_KINDS.has(kind);

  if (isSlow) {
    modeSel.value = 'async';
    if (syncOpt) syncOpt.disabled = true;
    hint.textContent = 'Slow Lane : mode="async" obligatwa (Anti-Ban Meta, 10-16 min entèval, max 25/jou/SIM).';
  } else {
    if (syncOpt) syncOpt.disabled = false;
    hint.textContent = 'Fast Lane : priyorite 2.5s-6.5s, aksepte mode="async" (202) oswa mode="sync" (200).';
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(new Error('Pa kapab li fichye PDF la.'));
    reader.readAsDataURL(file);
  });
}

(async () => {
  await initAdminPage('whatsapp');

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((el) => el.setAttribute('aria-selected', el === tab ? 'true' : 'false'));
      const key = tab.dataset.tab;
      document.getElementById('panel-config').hidden = key !== 'config';
      document.getElementById('panel-send').hidden = key !== 'send';
      document.getElementById('panel-logs').hidden = key !== 'logs';
      document.getElementById('panel-webhooks').hidden = key !== 'webhooks';
      if (key === 'logs') loadMessagesTab();
      if (key === 'webhooks') loadWebhooksTab();
    });
  });

  document.getElementById('wa-kind')?.addEventListener('change', updateDualLaneUi);
  updateDualLaneUi();

  document.getElementById('wa-student-pick')?.addEventListener('change', (e) => {
    if (e.target.value) document.getElementById('wa-to').value = e.target.value;
  });

  document.getElementById('wa-test-conn-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const res = await invokeGateway({ action: 'test_connection' });
      renderClusterBox(res);
      if (res.me?.ok) {
        toast('Koneksyon CVISUAL /api/v1/me ak /status reyisi.', 'success');
      } else {
        toast(res.me?.error || 'Echèk verifye /api/v1/me', 'warning');
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  const handleRunReminders = async (btn, dryRun) => {
    setLoading(btn, true);
    const outBox = document.getElementById('wa-run-result');
    try {
      const res = await invokeGateway({ action: 'run_reminders', max_per_run: 20, dry_run: dryRun });
      const s = res.summary || {};
      outBox.hidden = false;
      outBox.innerHTML = `
        <div class="alert ${s.errors ? 'alert-warning' : 'alert-info'} text-sm">
          ${icon('info')}
          <div class="flex-1">
            <strong>${dryRun ? 'Previzyalizasyon (Dry run)' : 'Rapèl otomatik lanse'} :</strong>
            ${s.queued || 0} nan fil atant, ${s.skipped || 0} sote, ${s.errors || 0} erè
            ${s.stoppedReason ? ` (${esc(s.stoppedReason)})` : ''}.
          </div>
        </div>`;
      icons(outBox);
      if (!dryRun) await loadOverview();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  };

  document.getElementById('wa-dry-run-btn')?.addEventListener('click', (e) => handleRunReminders(e.currentTarget, true));
  document.getElementById('wa-run-reminders-btn')?.addEventListener('click', (e) => handleRunReminders(e.currentTarget, false));

  document.getElementById('wa-settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('wa-save-settings-btn');
    setLoading(btn, true);
    try {
      const res = await invokeGateway({
        action: 'save_settings',
        enabled: document.getElementById('wa-enabled').checked,
        welcome_enabled: document.getElementById('wa-welcome-enabled').checked,
        deadline_enabled: document.getElementById('wa-deadline-enabled').checked,
        class_reminder_enabled: document.getElementById('wa-class-enabled').checked,
        base_url: document.getElementById('wa-base-url').value.trim(),
        inactivity_days: Number.parseInt(document.getElementById('wa-inactivity-days').value, 10) || 2,
        reminder_cooldown_hours: Number.parseInt(document.getElementById('wa-cooldown-hours').value, 10) || 48,
        inactive_template_ht: document.getElementById('wa-tpl-ht').value.trim(),
        inactive_template_fr: document.getElementById('wa-tpl-fr').value.trim(),
        deadline_template_ht: document.getElementById('wa-tpl-dead-ht').value.trim(),
        deadline_template_fr: document.getElementById('wa-tpl-dead-fr').value.trim(),
        class_template_ht: document.getElementById('wa-tpl-class-ht').value.trim(),
        class_template_fr: document.getElementById('wa-tpl-class-fr').value.trim(),
        new_api_key: document.getElementById('wa-new-key').value.trim() || undefined,
        clear_db_api_key: document.getElementById('wa-clear-db-key').checked,
        new_webhook_secret: document.getElementById('wa-new-secret').value.trim() || undefined,
      });

      populateSettingsForm(res.settings);
      if (res.me?.ok) {
        toast('Paramèt sove ak kle CVISUAL la verifye (/me OK).', 'success');
      } else {
        toast(`Paramèt sove, men verifikasyon /me echwe : ${res.me?.error || 'erè'}`, 'warning');
      }
      await loadOverview();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  document.getElementById('wa-send-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('wa-send-btn');
    const outBox = document.getElementById('wa-send-output');
    setLoading(btn, true);
    try {
      const pdfFile = document.getElementById('wa-pdf-file').files?.[0];
      let pdfBase64;
      let pdfFileName;
      if (pdfFile) {
        if (pdfFile.size > 10 * 1024 * 1024) {
          throw new Error('Fichye PDF la depase limit 10 MB la.');
        }
        pdfBase64 = await fileToBase64(pdfFile);
        pdfFileName = pdfFile.name;
      }

      const pick = document.getElementById('wa-student-pick');
      const selectedUid = pick?.selectedOptions?.[0]?.dataset?.uid || null;

      const res = await invokeGateway({
        action: 'send_message',
        to: document.getElementById('wa-to').value.trim(),
        kind: document.getElementById('wa-kind').value,
        mode: document.getElementById('wa-mode').value,
        message: document.getElementById('wa-msg').value.trim(),
        idempotency_key: document.getElementById('wa-idemp').value.trim() || undefined,
        pdf_base64: pdfBase64,
        pdf_file_name: pdfFileName,
        user_id: selectedUid,
      });

      outBox.innerHTML = `<div class="alert alert-info text-xs"><code>${esc(JSON.stringify(res.result))}</code></div>`;
      toast('Mesaj voye bay CVISUAL Gateway.', 'success');
    } catch (err) {
      outBox.innerHTML = `<div class="alert alert-error text-xs">${esc(err.message)}</div>`;
      toast(err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  document.getElementById('wa-check-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('wa-check-btn');
    const outBox = document.getElementById('wa-check-output');
    const phones = document.getElementById('wa-check-phones').value
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!phones.length) {
      toast(t('errors.required'), 'warning');
      return;
    }

    setLoading(btn, true);
    try {
      const res = await invokeGateway({ action: 'check_numbers', phones });
      const items = res.result?.results || res.result?.numbers || (Array.isArray(res.result) ? res.result : null);
      if (Array.isArray(items)) {
        outBox.innerHTML = `
          <div class="table-wrap mt-2">
            <table class="table">
              <thead><tr><th>Nimewo</th><th>Sou WhatsApp</th></tr></thead>
              <tbody>
                ${items.map((it) => {
                  const exists = Boolean(it.exists ?? it.registered ?? it.onWhatsApp ?? it.valid);
                  return `<tr>
                    <td><code>${esc(it.phone || it.number || it.input || '—')}</code></td>
                    <td><span class="badge ${exists ? 'badge-success' : 'badge-error'}">${exists ? 'Wi' : 'Non'}</span></td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`;
      } else {
        outBox.innerHTML = `<pre class="text-xs muted mt-2">${esc(JSON.stringify(res.result, null, 2))}</pre>`;
      }
    } catch (err) {
      outBox.innerHTML = `<div class="alert alert-error text-xs mt-2">${esc(err.message)}</div>`;
    } finally {
      setLoading(btn, false);
    }
  });

  document.getElementById('wa-refresh-msgs-btn')?.addEventListener('click', loadMessagesTab);
  document.getElementById('wa-refresh-webhooks-btn')?.addEventListener('click', loadWebhooksTab);

  document.getElementById('wa-copy-webhook-btn')?.addEventListener('click', async () => {
    const url = document.getElementById('wa-webhook-url').value;
    if (!url) return;
    await navigator.clipboard.writeText(url);
    toast(t('common.copied'), 'success');
  });

  document.getElementById('wa-register-webhook-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const url = document.getElementById('wa-webhook-url').value.trim();
      const res = await invokeGateway({
        action: 'register_webhook',
        url,
        events: ['message.sent', 'message.failed', 'message.cancelled'],
      });
      toast(res.secret_saved
        ? 'Webhook anrejistre epi sekrè HMAC la sove sou sèvè a.'
        : 'Webhook anrejistre sou CVISUAL.', 'success');
      await Promise.all([loadWebhooksTab(), loadOverview()]);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  await Promise.all([loadOverview(), loadStudentsForPicker()]);
})();
