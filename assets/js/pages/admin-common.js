/* =====================================================================
   PRAN NÒT - admin-common.js
   Initialisation commune aux pages d'administration :
   vérification stricte (getSession + admin_users), barre latérale,
   changement de langue, déconnexion et footer.
   ===================================================================== */
import { requireAdmin, appUrl, signOut } from '../auth.js';
import { t, getLang, setLang, applyI18n } from '../i18n.js';
import { ensureFooter } from '../navbar.js';
import { esc, icon, icons, pageEnter } from '../utils.js';

/**
 * Initialise l'espace admin et vérifie l'accès via requireAdmin().
 * @param {'overview'|'users'|'content'|'ai'} activeKey
 */
export async function initAdminPage(activeKey) {
  const auth = await requireAdmin();
  applyI18n(document);

  const sidebar = document.getElementById('admin-sidebar');
  if (sidebar) {
    const lang = getLang();
    const links = [
      { key: 'overview', href: 'pages/admin/dashboard.html', ic: 'layout-dashboard', label: t('admin.nav_overview') },
      { key: 'users', href: 'pages/admin/users.html', ic: 'users', label: t('admin.nav_users') },
      { key: 'content', href: 'pages/admin/content.html', ic: 'flag', label: t('admin.nav_content') },
      { key: 'ai', href: 'pages/admin/ai-usage.html', ic: 'cpu', label: t('admin.nav_ai') },
      { key: 'whatsapp', href: 'pages/admin/whatsapp.html', ic: 'message-square', label: t('admin.nav_whatsapp') },
    ];

    sidebar.innerHTML = `
      <div class="admin-brand">
        <a class="nav-brand" href="${appUrl('pages/admin/dashboard.html')}">
          <span class="nav-brand-mark">${icon('shield')}</span>
          <span>Pran N<span class="nav-brand-dot">ò</span>t</span>
        </a>
        <span class="badge badge-accent">Admin</span>
      </div>

      <nav class="admin-nav" aria-label="${esc(t('admin.title'))}">
        ${links.map((l) => `
          <a href="${appUrl(l.href)}" ${l.key === activeKey ? 'aria-current="page"' : ''}>
            ${icon(l.ic)}<span>${esc(l.label)}</span>
          </a>`).join('')}
      </nav>

      <div class="stack-sm">
        <div class="text-xs muted truncate" style="padding:0 var(--sp-2);" title="${esc(auth.user?.email || '')}">
          ${esc(auth.user?.email || '')}
        </div>
        <div class="row-wrap" style="padding:0 var(--sp-1);">
          <button type="button" class="nav-lang" id="admin-lang-btn">${lang.toUpperCase()}</button>
          <a class="btn btn-sm btn-secondary flex-1" href="${appUrl('pages/dashboard.html')}">
            ${icon('arrow-left')}<span>${esc(t('admin.back_app'))}</span>
          </a>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" id="admin-logout-btn" style="justify-content:flex-start;color:var(--c-error);">
          ${icon('log-out')}<span>${esc(t('nav.logout'))}</span>
        </button>
      </div>`;

    document.getElementById('admin-lang-btn')?.addEventListener('click', async () => {
      await setLang(getLang() === 'ht' ? 'fr' : 'ht');
      location.reload();
    });
    document.getElementById('admin-logout-btn')?.addEventListener('click', () => signOut());
  }

  ensureFooter();
  icons(document.body);
  pageEnter(document.querySelector('.admin-main'));
  return auth;
}
