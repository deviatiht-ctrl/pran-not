/* =====================================================================
   PRAN NÒT - pages/admin-content.js
   Modération des signalements (content_reports) et gestion des
   annonces globales (announcements).
   ===================================================================== */
import '../supabase.js';
import { initAdminPage } from './admin-common.js';
import { t, formatDate, formatRelative } from '../i18n.js';
import {
  esc, icon, icons, emptyState, errorState, openModal, confirmDialog, toast, handleError, setLoading,
} from '../utils.js';

const db = window.db;
let currentUser = null;

function statusBadge(status) {
  if (status === 'open') return 'badge-warning';
  if (status === 'removed') return 'badge-error';
  if (status === 'reviewed') return 'badge-success';
  return '';
}

async function inspectItem(itemType, itemId) {
  let contentHtml = `<p class="muted text-sm">${esc(t('common.none'))}</p>`;
  try {
    if (itemType === 'note') {
      const { data } = await db.from('pran_not_notes').select('id, title, summary, content_text, user_id, created_at').eq('id', itemId).maybeSingle();
      if (data) {
        contentHtml = `
          <div class="stack-sm">
            <strong>${esc(data.title)}</strong>
            <div class="text-xs muted">ID: ${esc(data.id)} — ${esc(formatDate(data.created_at))}</div>
            ${data.summary ? `<div class="card card-sm card-muted text-sm">${esc(data.summary)}</div>` : ''}
            <pre style="white-space:pre-wrap;font-family:var(--font-body);font-size:var(--fs-sm);max-height:280px;overflow:auto;">${esc((data.content_text || '').slice(0, 3000))}</pre>
          </div>`;
      }
    } else if (itemType === 'deck') {
      const { data } = await db.from('pran_not_flashcard_decks').select('id, title, description, created_at').eq('id', itemId).maybeSingle();
      if (data) {
        contentHtml = `<strong>${esc(data.title)}</strong><p class="text-sm mt-2">${esc(data.description || '—')}</p>`;
      }
    } else if (itemType === 'flashcard') {
      const { data } = await db.from('pran_not_flashcards').select('id, type, front, back, created_at').eq('id', itemId).maybeSingle();
      if (data) {
        contentHtml = `<div class="stack-sm">
          <span class="badge">${esc(data.type)}</span>
          <div><strong>Recto :</strong> ${esc(data.front)}</div>
          <div><strong>Verso :</strong> ${esc(data.back)}</div>
        </div>`;
      }
    } else if (itemType === 'group') {
      const { data } = await db.from('pran_not_study_groups').select('id, name, description, invite_code').eq('id', itemId).maybeSingle();
      if (data) {
        contentHtml = `<strong>${esc(data.name)}</strong><p class="text-sm mt-2">${esc(data.description || '—')}</p><div class="text-xs muted">Kòd: ${esc(data.invite_code)}</div>`;
      }
    } else {
      contentHtml = `<p class="text-sm muted">Tip : ${esc(itemType)} (${esc(itemId)})</p>`;
    }
  } catch (err) {
    contentHtml = `<p class="text-error text-sm">${esc(err.message || t('errors.generic'))}</p>`;
  }

  openModal({
    title: `${t('admin.inspect_item')} (${itemType})`,
    body: contentHtml,
  });
}

async function deleteReportedTarget(itemType, itemId) {
  const tableMap = {
    note: 'pran_not_notes',
    deck: 'pran_not_flashcard_decks',
    flashcard: 'pran_not_flashcards',
    group: 'pran_not_study_groups',
  };
  const table = tableMap[itemType];
  if (!table) return;
  const { error } = await db.from(table).delete().eq('id', itemId);
  if (error) throw error;
}

function openTreatReportModal(rep) {
  const deletable = ['note', 'deck', 'flashcard', 'group'].includes(rep.item_type);
  const m = openModal({
    title: t('admin.treat_report'),
    body: `
      <form id="treat-report-form" class="stack-sm">
        <div class="text-xs muted">${esc(rep.item_type)} — ${esc(rep.item_id)}</div>
        <div class="card card-sm card-muted text-sm">${esc(rep.reason)}</div>
        <div class="field">
          <label for="rep-status">Statut</label>
          <select class="select" id="rep-status">
            <option value="open" ${rep.status === 'open' ? 'selected' : ''}>Ouvè / Ouvert</option>
            <option value="reviewed" ${rep.status === 'reviewed' ? 'selected' : ''}>Egzamine / Examiné</option>
            <option value="dismissed" ${rep.status === 'dismissed' ? 'selected' : ''}>Rejte / Classé</option>
            <option value="removed" ${rep.status === 'removed' ? 'selected' : ''}>Efase / Supprimé</option>
          </select>
        </div>
        <div class="field">
          <label for="rep-note">Nòt administratè / Note interne</label>
          <textarea class="textarea" id="rep-note" rows="3" style="min-height:88px;">${esc(rep.admin_note || '')}</textarea>
        </div>
        ${deletable ? `
          <label class="switch">
            <input type="checkbox" id="rep-delete-target">
            <span class="switch-track"></span>
            <span class="text-sm" style="color:var(--c-error);font-weight:600;">Efase kontni ki siyalize a tou / Supprimer aussi le contenu ciblé</span>
          </label>` : ''}
      </form>`,
    footer: `
      <button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
      <button type="button" class="btn btn-primary" id="rep-save-btn">${esc(t('common.save'))}</button>`,
  });

  m.el.querySelector('#rep-save-btn')?.addEventListener('click', async () => {
    const btn = m.el.querySelector('#rep-save-btn');
    const status = m.el.querySelector('#rep-status').value;
    const adminNote = m.el.querySelector('#rep-note').value.trim();
    const deleteTarget = m.el.querySelector('#rep-delete-target')?.checked;
    setLoading(btn, true);
    try {
      if (deleteTarget) {
        await deleteReportedTarget(rep.item_type, rep.item_id);
      }
      const finalStatus = deleteTarget ? 'removed' : status;
      const { error } = await db
        .from('pran_not_content_reports')
        .update({ status: finalStatus, admin_note: adminNote || null })
        .eq('id', rep.id);
      if (error) throw error;
      toast(t('common.saved'), 'success');
      m.close();
      loadReports();
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });
}

async function loadReports() {
  const box = document.getElementById('reports-box');
  const filter = document.getElementById('reports-status-filter')?.value || 'all';
  try {
    let query = db.from('pran_not_content_reports').select('*').order('created_at', { ascending: false }).limit(100);
    if (filter !== 'all') query = query.eq('status', filter);
    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    if (!rows.length) {
      box.innerHTML = emptyState({ icon: 'flag', title: t('common.none') });
      icons(box);
      return;
    }

    box.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Tip / Type</th>
              <th>Rezon / Motif</th>
              <th>Statut</th>
              <th>Dat</th>
              <th>Aksyon</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => `<tr>
              <td>
                <span class="badge">${esc(r.item_type)}</span>
                <div class="text-xs muted mt-1">${esc(String(r.item_id).slice(0, 8))}...</div>
              </td>
              <td>
                <div class="text-sm">${esc(r.reason)}</div>
                ${r.admin_note ? `<div class="text-xs muted mt-1">${esc(r.admin_note)}</div>` : ''}
              </td>
              <td><span class="badge ${statusBadge(r.status)}">${esc(r.status)}</span></td>
              <td class="text-xs muted">${esc(formatRelative(r.created_at))}</td>
              <td>
                <div class="row-wrap">
                  <button type="button" class="btn btn-sm btn-secondary" data-inspect="${esc(r.id)}">
                    ${icon('eye')}<span>${esc(t('admin.inspect_item'))}</span>
                  </button>
                  <button type="button" class="btn btn-sm btn-dark" data-treat="${esc(r.id)}">
                    ${icon('check-square')}<span>${esc(t('admin.treat_report'))}</span>
                  </button>
                </div>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    icons(box);

    const byId = new Map(rows.map((r) => [r.id, r]));
    box.querySelectorAll('[data-inspect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rep = byId.get(btn.dataset.inspect);
        if (rep) inspectItem(rep.item_type, rep.item_id);
      });
    });
    box.querySelectorAll('[data-treat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rep = byId.get(btn.dataset.treat);
        if (rep) openTreatReportModal(rep);
      });
    });
  } catch (err) {
    box.innerHTML = errorState(handleError(err), loadReports);
    icons(box);
  }
}

function openAnnouncementModal(existing = null) {
  const m = openModal({
    title: existing ? t('common.edit') : t('admin.new_announcement'),
    body: `
      <form id="ann-form" class="stack-sm">
        <div class="field">
          <label for="ann-title">Tit / Titre</label>
          <input class="input" id="ann-title" required maxlength="140" value="${esc(existing?.title || '')}">
        </div>
        <div class="field">
          <label for="ann-body">Mesaj / Message</label>
          <textarea class="textarea" id="ann-body" required rows="4">${esc(existing?.body || '')}</textarea>
        </div>
        <div class="form-row">
          <div class="field">
            <label for="ann-level">Nivo / Niveau</label>
            <select class="select" id="ann-level">
              <option value="info" ${(!existing || existing.level === 'info') ? 'selected' : ''}>Info</option>
              <option value="warning" ${existing?.level === 'warning' ? 'selected' : ''}>Warning / Atansyon</option>
              <option value="success" ${existing?.level === 'success' ? 'selected' : ''}>Success / Nouvote</option>
            </select>
          </div>
          <div class="field">
            <label for="ann-ends">Dat fin / Date de fin (${esc(t('common.optional'))})</label>
            <input type="date" class="input" id="ann-ends" value="${existing?.ends_at ? esc(String(existing.ends_at).slice(0, 10)) : ''}">
          </div>
        </div>
        <label class="switch">
          <input type="checkbox" id="ann-active" ${existing ? (existing.active ? 'checked' : '') : 'checked'}>
          <span class="switch-track"></span>
          <span>Aktif / Active</span>
        </label>
      </form>`,
    footer: `
      <button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
      <button type="button" class="btn btn-primary" id="ann-save-btn">${esc(t('common.save'))}</button>`,
  });

  m.el.querySelector('#ann-save-btn')?.addEventListener('click', async () => {
    const btn = m.el.querySelector('#ann-save-btn');
    const title = m.el.querySelector('#ann-title').value.trim();
    const body = m.el.querySelector('#ann-body').value.trim();
    const level = m.el.querySelector('#ann-level').value;
    const endsRaw = m.el.querySelector('#ann-ends').value;
    const active = m.el.querySelector('#ann-active').checked;
    if (!title || !body) {
      toast(t('errors.required'), 'warning');
      return;
    }
    const payload = {
      title,
      body,
      level,
      active,
      ends_at: endsRaw ? new Date(`${endsRaw}T23:59:59Z`).toISOString() : null,
    };
    setLoading(btn, true);
    try {
      if (existing) {
        const { error } = await db.from('pran_not_announcements').update(payload).eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await db.from('pran_not_announcements').insert({ ...payload, created_by: currentUser?.id });
        if (error) throw error;
      }
      toast(t('common.saved'), 'success');
      m.close();
      loadAnnouncementsList();
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });
}

async function loadAnnouncementsList() {
  const box = document.getElementById('announcements-box');
  try {
    const { data, error } = await db.from('pran_not_announcements').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) throw error;

    const rows = data || [];
    if (!rows.length) {
      box.innerHTML = emptyState({
        icon: 'megaphone',
        title: t('common.none'),
        action: `<button type="button" class="btn btn-primary" id="ann-empty-new">${icon('plus')}<span>${esc(t('admin.new_announcement'))}</span></button>`,
      });
      icons(box);
      box.querySelector('#ann-empty-new')?.addEventListener('click', () => openAnnouncementModal());
      return;
    }

    box.innerHTML = rows.map((a) => {
      const cls = a.level === 'warning' ? 'badge-warning' : a.level === 'success' ? 'badge-success' : 'badge-info';
      return `<article class="card">
        <div class="card-head">
          <div class="stack-sm flex-1">
            <div class="row-wrap">
              <span class="badge ${cls}">${esc(a.level)}</span>
              <span class="badge ${a.active ? 'badge-success' : ''}">${esc(a.active ? t('admin.active') : 'Inaktif')}</span>
              <span class="text-xs muted">${esc(formatDate(a.created_at))}${a.ends_at ? ` -> ${esc(formatDate(a.ends_at))}` : ''}</span>
            </div>
            <h2 class="card-title">${esc(a.title)}</h2>
            <p class="text-sm mb-0">${esc(a.body)}</p>
          </div>
          <div class="row-wrap">
            <button type="button" class="btn btn-sm btn-secondary" data-toggle-ann="${esc(a.id)}" data-active="${a.active ? '1' : '0'}">
              ${icon(a.active ? 'pause' : 'play')}
              <span>${a.active ? 'Dezaktive' : 'Aktive'}</span>
            </button>
            <button type="button" class="btn btn-sm btn-secondary" data-edit-ann="${esc(a.id)}">
              ${icon('edit-2')}<span>${esc(t('common.edit'))}</span>
            </button>
            <button type="button" class="btn btn-sm btn-danger" data-del-ann="${esc(a.id)}">
              ${icon('trash-2')}
            </button>
          </div>
        </div>
      </article>`;
    }).join('');
    icons(box);

    const byId = new Map(rows.map((r) => [r.id, r]));
    box.querySelectorAll('[data-toggle-ann]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const next = btn.dataset.active !== '1';
        try {
          const { error } = await db.from('pran_not_announcements').update({ active: next }).eq('id', btn.dataset.toggleAnn);
          if (error) throw error;
          toast(t('common.saved'), 'success');
          loadAnnouncementsList();
        } catch (err) {
          handleError(err);
        }
      });
    });

    box.querySelectorAll('[data-edit-ann]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = byId.get(btn.dataset.editAnn);
        if (item) openAnnouncementModal(item);
      });
    });

    box.querySelectorAll('[data-del-ann]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: t('common.delete'),
          message: byId.get(btn.dataset.delAnn)?.title || '',
          confirmLabel: t('common.delete'),
          danger: true,
        });
        if (!ok) return;
        try {
          const { error } = await db.from('pran_not_announcements').delete().eq('id', btn.dataset.delAnn);
          if (error) throw error;
          toast(t('common.deleted'), 'success');
          loadAnnouncementsList();
        } catch (err) {
          handleError(err);
        }
      });
    });
  } catch (err) {
    box.innerHTML = errorState(handleError(err), loadAnnouncementsList);
    icons(box);
  }
}

(async () => {
  const { user } = await initAdminPage('content');
  currentUser = user;

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((el) => el.setAttribute('aria-selected', el === tab ? 'true' : 'false'));
      const key = tab.dataset.tab;
      document.getElementById('panel-reports').hidden = key !== 'reports';
      document.getElementById('panel-announcements').hidden = key !== 'announcements';
      if (key === 'announcements') loadAnnouncementsList();
    });
  });

  document.getElementById('reports-status-filter')?.addEventListener('change', loadReports);
  document.getElementById('new-announcement-btn')?.addEventListener('click', () => openAnnouncementModal());

  await loadReports();
})();
