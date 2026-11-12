/* =====================================================================
   PRAN NÒT - pages/admin-users.js
   Gestion des utilisateurs : recherche, filtres, quota IA quotidien,
   suspension (ban/unban) et liste des administrateurs.
   ===================================================================== */
import '../supabase.js';
import { initAdminPage } from './admin-common.js';
import { initials } from '../auth.js';
import { t, getLang, formatDate, formatRelative } from '../i18n.js';
import {
  esc, icon, icons, debounce, emptyState, errorState, confirmDialog, promptDialog, toast, handleError, setLoading,
} from '../utils.js';

const db = window.db;
const PAGE_SIZE = 25;

let me = null;
let page = 0;
let facultiesMap = new Map();

function sanitizeQueryTerm(str) {
  return String(str || '').trim().replace(/[%_,()\\]/g, ' ');
}

async function loadFaculties() {
  const { data } = await db.from('pran_not_faculties').select('id, name_fr, name_ht').order('id');
  const lang = getLang();
  const sel = document.getElementById('users-faculty');
  (data || []).forEach((f) => {
    const label = lang === 'ht' ? f.name_ht : f.name_fr;
    facultiesMap.set(f.id, label);
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = label;
    sel?.appendChild(opt);
  });
}

async function loadUsers() {
  const box = document.getElementById('users-table-box');
  const pagBox = document.getElementById('users-pagination');
  const q = sanitizeQueryTerm(document.getElementById('users-search')?.value || '');
  const fac = document.getElementById('users-faculty')?.value || 'all';
  const status = document.getElementById('users-status')?.value || 'all';

  try {
    let query = db
      .from('pran_not_profiles')
      .select('id, email, full_name, university, faculty_id, level, xp, xp_level, ai_daily_quota, is_banned, onboarded, last_seen_at, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (q) {
      query = query.or(`email.ilike.%${q}%,full_name.ilike.%${q}%,university.ilike.%${q}%`);
    }
    if (fac !== 'all') query = query.eq('faculty_id', fac);
    if (status === 'active') query = query.eq('is_banned', false);
    if (status === 'banned') query = query.eq('is_banned', true);

    const { data, count, error } = await query;
    if (error) throw error;

    const rows = data || [];
    if (!rows.length) {
      box.innerHTML = emptyState({ icon: 'users', title: t('common.none') });
      pagBox.innerHTML = '';
      icons(box);
      return;
    }

    box.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Etidyan / Étudiant</th>
              <th>Fakilte & Inivèsite</th>
              <th>Nivo / XP</th>
              <th>${esc(t('admin.quota_label'))}</th>
              <th>Dènye aktivite</th>
              <th>Statut</th>
              <th>Aksyon</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((u) => {
              const isSelf = u.id === me?.id;
              const facLabel = facultiesMap.get(u.faculty_id) || u.faculty_id || '—';
              return `<tr>
                <td>
                  <div class="row" style="gap:var(--sp-2);">
                    <span class="avatar" style="width:34px;height:34px;font-size:12px;">${esc(initials(u.full_name, u.email))}</span>
                    <div>
                      <strong>${esc(u.full_name || '—')}</strong>
                      <div class="text-xs muted">${esc(u.email)}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div class="text-sm">${esc(facLabel)}</div>
                  <div class="text-xs muted">${esc(u.university || '—')} (${esc(u.level || 'L1')})</div>
                </td>
                <td>
                  <span class="badge">Niv. ${u.xp_level || 1}</span>
                  <div class="text-xs muted mt-1">${u.xp || 0} XP</div>
                </td>
                <td>
                  <strong>${u.ai_daily_quota}</strong> / j
                </td>
                <td class="text-xs muted">
                  ${u.last_seen_at ? esc(formatRelative(u.last_seen_at)) : esc(formatDate(u.created_at))}
                </td>
                <td>
                  <span class="badge ${u.is_banned ? 'badge-error' : 'badge-success'}">
                    ${esc(u.is_banned ? t('admin.banned') : t('admin.active'))}
                  </span>
                </td>
                <td>
                  <div class="row-wrap">
                    <button type="button" class="btn btn-sm btn-secondary" data-edit-quota="${esc(u.id)}" data-quota="${u.ai_daily_quota}" data-name="${esc(u.full_name || u.email)}">
                      ${icon('sliders')}<span>${esc(t('admin.edit_quota'))}</span>
                    </button>
                    ${isSelf ? '' : `
                      <button type="button" class="btn btn-sm ${u.is_banned ? 'btn-secondary' : 'btn-danger'}" data-toggle-ban="${esc(u.id)}" data-banned="${u.is_banned ? '1' : '0'}" data-name="${esc(u.full_name || u.email)}">
                        ${icon(u.is_banned ? 'user-check' : 'ban')}
                        <span>${esc(u.is_banned ? t('admin.unban') : t('admin.ban'))}</span>
                      </button>`}
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
    icons(box);

    // Pagination
    const total = count || rows.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    pagBox.innerHTML = totalPages > 1 ? `
      <button type="button" class="btn btn-sm btn-secondary" id="users-prev" ${page <= 0 ? 'disabled' : ''}>${icon('chevron-left')}</button>
      <span class="text-sm muted">${page + 1} / ${totalPages} (${total})</span>
      <button type="button" class="btn btn-sm btn-secondary" id="users-next" ${page + 1 >= totalPages ? 'disabled' : ''}>${icon('chevron-right')}</button>
    ` : `<span class="text-xs muted">${total}</span>`;
    icons(pagBox);

    document.getElementById('users-prev')?.addEventListener('click', () => { page = Math.max(0, page - 1); loadUsers(); });
    document.getElementById('users-next')?.addEventListener('click', () => { page += 1; loadUsers(); });

    box.querySelectorAll('[data-edit-quota]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const val = await promptDialog({
          title: t('admin.edit_quota'),
          label: `${btn.dataset.name} (${t('admin.quota_label')})`,
          value: btn.dataset.quota,
          placeholder: '60',
        });
        if (val === null) return;
        const n = Number.parseInt(val, 10);
        if (!Number.isFinite(n) || n < 0 || n > 5000) {
          toast('Valè invalid (0 - 5000)', 'warning');
          return;
        }
        try {
          const { error } = await db.from('pran_not_profiles').update({ ai_daily_quota: n }).eq('id', btn.dataset.editQuota);
          if (error) throw error;
          toast(t('common.saved'), 'success');
          loadUsers();
        } catch (err) {
          handleError(err);
        }
      });
    });

    box.querySelectorAll('[data-toggle-ban]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const currentlyBanned = btn.dataset.banned === '1';
        const ok = await confirmDialog({
          title: currentlyBanned ? t('admin.unban') : t('admin.ban'),
          message: `${btn.dataset.name}`,
          confirmLabel: currentlyBanned ? t('admin.unban') : t('admin.ban'),
          danger: !currentlyBanned,
        });
        if (!ok) return;
        try {
          const { error } = await db.from('pran_not_profiles').update({ is_banned: !currentlyBanned }).eq('id', btn.dataset.toggleBan);
          if (error) throw error;
          toast(t('common.saved'), 'success');
          loadUsers();
        } catch (err) {
          handleError(err);
        }
      });
    });
  } catch (err) {
    box.innerHTML = errorState(handleError(err), loadUsers);
    icons(box);
  }
}

async function loadAdmins() {
  const box = document.getElementById('admins-list-box');
  try {
    const { data, error } = await db.from('pran_not_admin_users').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    const rows = data || [];
    const myEmail = (me?.email || '').toLowerCase();

    box.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Imèl / Email</th>
              <th>Dat</th>
              <th>Aksyon</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((a) => {
              const isSelf = a.email.toLowerCase() === myEmail;
              return `<tr>
                <td>
                  <strong>${esc(a.email)}</strong>
                  ${isSelf ? '<span class="badge badge-accent ml-2">Ou menm</span>' : ''}
                </td>
                <td class="text-xs muted">${esc(formatDate(a.created_at))}</td>
                <td>
                  ${isSelf ? '<span class="text-xs muted">—</span>' : `
                    <button type="button" class="btn btn-sm btn-danger" data-del-admin="${esc(a.email)}">
                      ${icon('trash-2')}<span>${esc(t('common.delete'))}</span>
                    </button>`}
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
    icons(box);

    box.querySelectorAll('[data-del-admin]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const email = btn.dataset.delAdmin;
        const ok = await confirmDialog({
          title: t('common.delete'),
          message: email,
          confirmLabel: t('common.delete'),
          danger: true,
        });
        if (!ok) return;
        try {
          const { error } = await db.from('pran_not_admin_users').delete().eq('email', email);
          if (error) throw error;
          toast(t('common.deleted'), 'success');
          loadAdmins();
        } catch (err) {
          handleError(err);
        }
      });
    });
  } catch (err) {
    box.innerHTML = errorState(handleError(err), loadAdmins);
    icons(box);
  }
}

(async () => {
  const { user } = await initAdminPage('users');
  me = user;

  // Onglets
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((el) => el.setAttribute('aria-selected', el === tab ? 'true' : 'false'));
      const key = tab.dataset.tab;
      document.getElementById('panel-students').hidden = key !== 'students';
      document.getElementById('panel-admins').hidden = key !== 'admins';
      if (key === 'admins') loadAdmins();
    });
  });

  document.getElementById('users-search')?.addEventListener('input', debounce(() => { page = 0; loadUsers(); }, 280));
  document.getElementById('users-faculty')?.addEventListener('change', () => { page = 0; loadUsers(); });
  document.getElementById('users-status')?.addEventListener('change', () => { page = 0; loadUsers(); });

  document.getElementById('add-admin-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('new-admin-email');
    const btn = document.getElementById('add-admin-submit');
    const email = (input?.value || '').trim().toLowerCase();
    if (!email) return;
    setLoading(btn, true);
    try {
      const { error } = await db.from('pran_not_admin_users').upsert({ email }, { onConflict: 'email' });
      if (error) throw error;
      input.value = '';
      toast(t('common.saved'), 'success');
      loadAdmins();
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  await loadFaculties();
  await loadUsers();
})();
