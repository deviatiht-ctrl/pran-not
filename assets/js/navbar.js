/* =====================================================================
   PRAN NÒT - navbar.js
   Navigation desktop (pill flottante) + mobile (barre Android 5 onglets),
   recherche globale plein texte, feuille de capture rapide (2 touches max),
   panneau tuteur IA contextuel, annonces et footer.
   ===================================================================== */
import { appUrl, initials, isAdmin, signOut } from './auth.js';
import { t, getLang, setLang, onLangChange } from './i18n.js';
import {
  esc, icons, icon, openModal, debounce, renderMarkdown, toast, handleError,
} from './utils.js';
import { askTutor } from './ai.js';
import { initOffline } from './offline.js';
import { initPwaInstall } from './pwa.js';

let currentContext = {
  contextType: 'general',
  contextId: null,
  contextTitle: '',
  contextText: '',
  courseId: null,
};
let currentProfile = null;
let tutorInitialized = false;
let tutorHistory = [];
let tutorConvId = null;

function isCurrent(file) {
  const path = location.pathname.toLowerCase();
  return path.endsWith(`/${file.toLowerCase()}`);
}

function pageHref(relFromRoot) {
  return appUrl(relFromRoot);
}

/**
 * Initialise la navigation complète sur toutes les pages de l'application.
 * @param {{ profile?: object, user?: object, active?: string, dueCount?: number, showFab?: boolean, showTutor?: boolean }} opts
 */
export async function initAppChrome({
  profile = null,
  user = null,
  active = '',
  dueCount = 0,
  showFab = true,
  showTutor = true,
} = {}) {
  currentProfile = profile;
  initOffline();

  const lang = getLang();
  const displayName = profile?.full_name || user?.email || 'Etidyan';
  const avatarText = initials(profile?.full_name, user?.email);

  const navItems = [
    { key: 'dashboard', href: 'pages/dashboard.html', icon: 'home', label: t('nav.home') },
    { key: 'notes', href: 'pages/notes.html', icon: 'notebook-pen', label: t('nav.notes') },
    { key: 'library', href: 'pages/library.html', icon: 'library', label: t('nav.library') },
    { key: 'review', href: 'pages/review.html', icon: 'layers', label: t('nav.review') },
    { key: 'courses', href: 'pages/courses.html', icon: 'book-open', label: t('nav.courses') },
    { key: 'tests', href: 'pages/tests.html', icon: 'check-circle-2', label: t('nav.tests') },
    { key: 'assignments', href: 'pages/assignments.html', icon: 'clipboard-list', label: t('nav.assignments') },
  ];

  // 1. Navbar Desktop (pill flottante glassmorphic)
  let pill = document.getElementById('nav-pill');
  if (!pill) {
    pill = document.createElement('nav');
    pill.id = 'nav-pill';
    pill.className = 'nav-pill';
    pill.setAttribute('aria-label', t('nav.main_label'));
    document.body.prepend(pill);
  }

  pill.innerHTML = `
    <a class="nav-brand" href="${pageHref('pages/dashboard.html')}">
      <span class="nav-brand-mark"><img src="${pageHref('assets/icons/icon-nav.png')}" alt=""></span>
      <span>Pran N<span class="nav-brand-dot">ò</span>t</span>
    </a>
    <div class="nav-links">
      ${navItems.map((it) => {
        const cur = active === it.key || isCurrent(it.href.split('/').pop());
        return `<a class="nav-link" href="${pageHref(it.href)}" ${cur ? 'aria-current="page"' : ''}>
          ${icon(it.icon)}<span>${esc(it.label)}</span>
        </a>`;
      }).join('')}
    </div>
    <div class="nav-actions">
      <button type="button" class="btn-icon" id="nav-search-btn" aria-label="${esc(t('nav.search'))}" title="${esc(t('nav.search'))} (Ctrl+K)">
        ${icon('search')}
      </button>
      <button type="button" class="nav-lang" id="nav-lang-btn" aria-label="${esc(t('nav.switch_lang'))}">
        ${lang.toUpperCase()}
      </button>
      <div class="nav-menu-wrap">
        <button type="button" class="nav-avatar-btn" id="nav-avatar-btn" aria-expanded="false" aria-haspopup="menu" aria-label="${esc(t('nav.profile_menu'))}">
          <span class="avatar">${profile?.avatar_url ? `<img src="${esc(profile.avatar_url)}" alt="${esc(displayName)}">` : esc(avatarText)}</span>
        </button>
        <div class="menu" id="nav-user-menu" role="menu" hidden>
          <div class="nav-menu-head">
            <strong>${esc(displayName)}</strong>
            <span>${esc(user?.email || '')}</span>
          </div>
          <a href="${pageHref('pages/profile.html')}" role="menuitem">${icon('user')}<span>${esc(t('nav.profile'))}</span></a>
          <a href="${pageHref('pages/library.html')}" role="menuitem">${icon('library')}<span>${esc(t('nav.library_full'))}</span></a>
          <a href="${pageHref('pages/progress.html')}" role="menuitem">${icon('bar-chart-2')}<span>${esc(t('nav.progress'))}</span></a>
          <a href="${pageHref('pages/planner.html')}" role="menuitem">${icon('calendar')}<span>${esc(t('nav.planner'))}</span></a>
          <a href="${pageHref('pages/tutor.html')}" role="menuitem">${icon('sparkles')}<span>${esc(t('nav.tutor'))}</span></a>
          <a href="${pageHref('pages/settings.html#design-studio')}" role="menuitem">${icon('palette')}<span>${esc(t('nav.design_studio'))}</span></a>
          <a href="${pageHref('pages/settings.html')}" role="menuitem">${icon('settings')}<span>${esc(t('nav.settings'))}</span></a>
          <button type="button" data-pwa-install data-pwa-mode="when-available" role="menuitem">${icon('smartphone')}<span data-pwa-label>${esc(t('pwa.install_phone'))}</span></button>
          <a href="${pageHref('pages/admin/dashboard.html')}" role="menuitem" id="nav-admin-link" hidden>${icon('shield')}<span>${esc(t('nav.admin'))}</span></a>
          <hr class="mt-2 mb-2">
          <button type="button" class="danger" id="nav-logout-btn" role="menuitem">${icon('log-out')}<span>${esc(t('nav.logout'))}</span></button>
        </div>
      </div>
    </div>`;

  // 2. En-tête compact mobile
  let mobileTop = document.getElementById('mobile-top');
  if (!mobileTop) {
    mobileTop = document.createElement('header');
    mobileTop.id = 'mobile-top';
    mobileTop.className = 'mobile-top';
    pill.after(mobileTop);
  }
  mobileTop.innerHTML = `
    <a class="nav-brand" href="${pageHref('pages/dashboard.html')}">
      <span class="nav-brand-mark"><img src="${pageHref('assets/icons/icon-nav.png')}" alt=""></span>
      <span>Pran N<span class="nav-brand-dot">ò</span>t</span>
    </a>
    <div class="mobile-top-actions">
      <button type="button" class="btn-icon" id="mob-install-btn" data-pwa-install data-pwa-mode="when-available" aria-label="${esc(t('pwa.install_phone'))}" title="${esc(t('pwa.install_phone'))}">${icon('smartphone')}</button>
      <button type="button" class="btn-icon" id="mob-search-btn" aria-label="${esc(t('nav.search'))}">${icon('search')}</button>
      <a class="btn-icon" href="${pageHref('pages/library.html')}" aria-label="${esc(t('nav.library_full'))}">${icon('library')}</a>
      <a class="btn-icon" href="${pageHref('pages/planner.html')}" aria-label="${esc(t('nav.planner'))}">${icon('calendar')}</a>
      <a class="btn-icon" href="${pageHref('pages/settings.html')}" aria-label="${esc(t('nav.settings'))}">${icon('settings')}</a>
      <button type="button" class="nav-lang" id="mob-lang-btn" aria-label="${esc(t('nav.switch_lang'))}">${lang.toUpperCase()}</button>
    </div>`;

  // 3. Barre mobile Android (5 onglets exacts : Accueil, Notes, Réviser, Cours, Profil)
  let mobNav = document.getElementById('mobile-nav');
  if (!mobNav) {
    mobNav = document.createElement('nav');
    mobNav.id = 'mobile-nav';
    mobNav.className = 'mobile-nav';
    mobNav.setAttribute('aria-label', t('nav.mobile_label'));
    document.body.appendChild(mobNav);
  }
  const mobTabs = [
    { key: 'dashboard', href: 'pages/dashboard.html', icon: 'home', label: t('nav.home') },
    { key: 'notes', href: 'pages/notes.html', icon: 'notebook-pen', label: t('nav.notes') },
    { key: 'review', href: 'pages/review.html', icon: 'layers', label: t('nav.review'), badge: dueCount },
    { key: 'courses', href: 'pages/courses.html', icon: 'book-open', label: t('nav.courses') },
    { key: 'profile', href: 'pages/profile.html', icon: 'user', label: t('nav.profile') },
  ];
  mobNav.innerHTML = mobTabs.map((it) => {
    const cur = active === it.key || isCurrent(it.href.split('/').pop());
    return `<a class="mobile-nav-item" href="${pageHref(it.href)}" ${cur ? 'aria-current="page"' : ''}>
      <span class="mobile-nav-icon">${icon(it.icon)}</span>
      <span>${esc(it.label)}</span>
      ${it.badge > 0 ? `<span class="mobile-nav-badge">${it.badge > 99 ? '99+' : it.badge}</span>` : ''}
    </a>`;
  }).join('');

  // 4. Footer "Designed by Cvisual"
  ensureFooter();

  // 5. Bouton d'action principal (capture ultra rapide en 2 touches)
  if (showFab && !isCurrent('note-capture.html')) {
    ensureCaptureFab();
  }

  // 6. Panneau Tuteur IA
  if (showTutor && !isCurrent('tutor.html')) {
    ensureTutorButton();
  }

  // Événements du menu & langue
  const avatarBtn = document.getElementById('nav-avatar-btn');
  const userMenu = document.getElementById('nav-user-menu');
  avatarBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = userMenu.hidden;
    userMenu.hidden = !isHidden;
    avatarBtn.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
  });
  document.addEventListener('click', (e) => {
    if (userMenu && !userMenu.hidden && !userMenu.contains(e.target) && e.target !== avatarBtn) {
      userMenu.hidden = true;
      avatarBtn?.setAttribute('aria-expanded', 'false');
    }
  });

  document.getElementById('nav-logout-btn')?.addEventListener('click', () => signOut());

  const toggleLang = async () => {
    const next = getLang() === 'ht' ? 'fr' : 'ht';
    await setLang(next);
    location.reload();
  };
  document.getElementById('nav-lang-btn')?.addEventListener('click', toggleLang);
  document.getElementById('mob-lang-btn')?.addEventListener('click', toggleLang);

  document.getElementById('nav-search-btn')?.addEventListener('click', openSearchModal);
  document.getElementById('mob-search-btn')?.addEventListener('click', openSearchModal);

  if (!window.__pranNotSearchShortcut) {
    window.__pranNotSearchShortcut = true;
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openSearchModal();
      }
    });
  }

  // Vérification silencieuse si admin -> afficher le lien Admin UNIQUEMENT pour admin_users
  isAdmin().then((ok) => {
    const link = document.getElementById('nav-admin-link');
    if (link) link.hidden = !ok;
  });

  // Charger les annonces actives (silencieux)
  loadAnnouncements();

  initPwaInstall({ showBanner: true });
  icons(document.body);
}

/** Footer obligatoire sur toutes les pages. */
export function ensureFooter() {
  if (document.querySelector('footer.site-footer')) return;
  const f = document.createElement('footer');
  f.className = 'site-footer';
  f.innerHTML = `<div class="site-footer-inner">
    <span><strong>Pran Nòt</strong> — ${esc(t('footer.tagline'))}</span>
    <span>Designed by Cvisual</span>
  </div>`;
  document.body.appendChild(f);
}

/** Barre de navigation publique (landing). */
export function renderPublicNav() {
  const pill = document.getElementById('public-nav');
  if (!pill) return;
  const lang = getLang();
  pill.className = 'nav-pill public';
  pill.innerHTML = `
    <a class="nav-brand" href="${pageHref('index.html')}">
      <span class="nav-brand-mark"><img src="${pageHref('assets/icons/icon-nav.png')}" alt=""></span>
      <span>Pran N<span class="nav-brand-dot">ò</span>t</span>
    </a>
    <div class="nav-links">
      <a class="nav-link" href="#features">${esc(t('landing.nav_features'))}</a>
      <a class="nav-link" href="#faculties">${esc(t('landing.nav_faculties'))}</a>
      <a class="nav-link" href="#offline">${esc(t('landing.nav_offline'))}</a>
    </div>
    <div class="nav-actions">
      <button type="button" class="nav-lang" id="pub-lang-btn">${lang.toUpperCase()}</button>
      <a class="btn btn-sm btn-ghost" href="${pageHref('login.html')}">${esc(t('login.submit_login'))}</a>
      <a class="btn btn-sm btn-primary" href="${pageHref('login.html?mode=signup')}">${esc(t('landing.cta_start'))}</a>
    </div>`;
  document.getElementById('pub-lang-btn')?.addEventListener('click', async () => {
    await setLang(getLang() === 'ht' ? 'fr' : 'ht', { persistProfile: false });
    location.reload();
  });
  icons(pill);
}

/** Bouton flottant Capture rapide (2 touches max vers n'importe quel mode). */
function ensureCaptureFab() {
  if (document.getElementById('capture-fab')) return;
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.id = 'capture-fab';
  fab.className = 'fab';
  fab.setAttribute('aria-label', t('capture.fab_label'));
  fab.innerHTML = icon('plus');
  fab.addEventListener('click', openCaptureSheet);
  document.body.appendChild(fab);
  icons(fab);
}

export function openCaptureSheet() {
  const modes = [
    { mode: 'photo', icon: 'camera', title: t('capture.mode_photo'), sub: t('capture.mode_photo_sub') },
    { mode: 'audio', icon: 'mic', title: t('capture.mode_audio'), sub: t('capture.mode_audio_sub') },
    { mode: 'flash', icon: 'zap', title: t('capture.mode_flash'), sub: t('capture.mode_flash_sub') },
    { mode: 'text', icon: 'file-edit', title: t('capture.mode_text'), sub: t('capture.mode_text_sub') },
    { mode: 'import', icon: 'upload', title: t('capture.mode_import'), sub: t('capture.mode_import_sub') },
  ];
  openModal({
    title: t('capture.sheet_title'),
    body: `<p class="muted text-sm mb-4">${esc(t('capture.sheet_sub'))}</p>
      <div class="capture-grid">
        ${modes.map((m) => `
          <a class="capture-option" href="${pageHref(`pages/note-capture.html?mode=${m.mode}`)}">
            <span class="icon-chip accent">${icon(m.icon)}</span>
            <div>
              <strong>${esc(m.title)}</strong><br>
              <span>${esc(m.sub)}</span>
            </div>
          </a>`).join('')}
      </div>`,
  });
}

/** Recherche globale plein texte (notes, flashcards, cours). */
export function openSearchModal() {
  const m = openModal({
    title: t('search.title'),
    body: `
      <div class="input-group mb-4">
        ${icon('search')}
        <input type="search" class="input" id="global-search-input" placeholder="${esc(t('search.placeholder'))}" autocomplete="off">
      </div>
      <div id="global-search-results" class="search-results">
        <p class="muted text-sm">${esc(t('search.hint'))}</p>
      </div>`,
  });
  m.modal.classList.add('search-modal');
  m.el.classList.add('search-overlay');

  const input = m.el.querySelector('#global-search-input');
  const resultsEl = m.el.querySelector('#global-search-results');

  const runSearch = debounce(async (q) => {
    const term = q.trim();
    if (term.length < 2) {
      resultsEl.innerHTML = `<p class="muted text-sm">${esc(t('search.hint'))}</p>`;
      return;
    }
    resultsEl.innerHTML = `<div class="row text-sm muted"><span class="spinner"></span><span>${esc(t('common.loading'))}</span></div>`;
    try {
      const { data, error } = await window.db.rpc('pran_not_search_all', { q: term, max_results: 25 });
      if (error) throw error;
      if (!data?.length) {
        resultsEl.innerHTML = `<p class="muted text-sm">${esc(t('search.empty'))}</p>`;
        return;
      }
      resultsEl.innerHTML = data.map((row) => {
        const href = row.kind === 'note'
          ? pageHref(`pages/note-view.html?id=${row.id}`)
          : row.kind === 'course'
            ? pageHref(`pages/course.html?id=${row.id}`)
            : row.kind === 'book'
              ? pageHref(`pages/library.html?book=${row.id}`)
              : pageHref(`pages/flashcards.html?highlight=${row.id}`);
        const badgeLabel = t(`search.kind_${row.kind}`);
        const ic = row.kind === 'note' ? 'file-text' : row.kind === 'course' ? 'book-open' : row.kind === 'book' ? 'library' : 'layers';
        return `<a class="search-result" href="${href}">
          <span class="icon-chip sm">${icon(ic)}</span>
          <div class="flex-1">
            <div class="row-between">
              <strong>${esc(row.title)}</strong>
              <span class="badge">${esc(badgeLabel)}</span>
            </div>
            ${row.snippet ? `<div class="text-xs muted mt-1">${row.kind === 'note' ? row.snippet : esc(row.snippet)}</div>` : ''}
          </div>
        </a>`;
      }).join('');
      icons(resultsEl);
    } catch (err) {
      resultsEl.innerHTML = `<p class="text-error text-sm">${esc(handleError(err))}</p>`;
    }
  }, 260);

  input.addEventListener('input', (e) => runSearch(e.target.value));
}

/** Annonces admin actives. */
async function loadAnnouncements() {
  const main = document.querySelector('main');
  if (!main || !window.db || !navigator.onLine) return;
  try {
    const { data } = await window.db
      .from('pran_not_announcements')
      .select('id, title, body, level')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1);
    const ann = data?.[0];
    if (!ann || sessionStorage.getItem(`ann_dismissed_${ann.id}`)) return;
    const cls = ann.level === 'warning' ? 'alert-warning' : ann.level === 'success' ? 'alert-success' : 'alert-info';
    const bar = document.createElement('div');
    bar.className = `alert ${cls} announcement-bar`;
    bar.innerHTML = `${icon('megaphone')}
      <div class="flex-1"><strong>${esc(ann.title)}</strong><div class="text-sm">${esc(ann.body)}</div></div>
      <button type="button" class="btn-icon" aria-label="${esc(t('common.close'))}">${icon('x')}</button>`;
    bar.querySelector('button').addEventListener('click', () => {
      sessionStorage.setItem(`ann_dismissed_${ann.id}`, '1');
      bar.remove();
    });
    main.prepend(bar);
    icons(bar);
  } catch { /* silencieux */ }
}

/* =====================================================================
   PANNEAU TUTEUR IA CONTEXTUEL (accessible partout)
   ===================================================================== */
function ensureTutorButton() {
  if (document.getElementById('tutor-toggle-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'tutor-toggle-btn';
  btn.className = 'tutor-toggle';
  btn.innerHTML = `${icon('sparkles')}<span class="tutor-toggle-label">${esc(t('tutor.btn_label'))}</span>`;
  btn.addEventListener('click', () => toggleTutorDrawer(true));
  document.body.appendChild(btn);

  const panel = document.createElement('aside');
  panel.id = 'tutor-panel';
  panel.className = 'tutor-panel';
  panel.setAttribute('aria-label', t('tutor.title'));
  panel.innerHTML = `
    <div class="tutor-panel-head">
      <span class="icon-chip sm accent">${icon('sparkles')}</span>
      <div class="flex-1">
        <strong class="font-display">${esc(t('tutor.title'))}</strong>
        <div class="text-xs muted truncate" id="tutor-context-badge">${esc(t('tutor.context_general'))}</div>
      </div>
      <a class="btn-icon" href="${pageHref('pages/tutor.html')}" title="${esc(t('tutor.open_full'))}" aria-label="${esc(t('tutor.open_full'))}">${icon('maximize-2')}</a>
      <button type="button" class="btn-icon" id="tutor-close-btn" aria-label="${esc(t('common.close'))}">${icon('x')}</button>
    </div>
    <div class="tutor-panel-body" id="tutor-messages"></div>
    <div class="tutor-panel-foot">
      <div class="tutor-modes" id="tutor-mode-chips">
        <button type="button" class="chip" data-mode="simple">${esc(t('tutor.mode_simple'))}</button>
        <button type="button" class="chip" data-mode="child">${esc(t('tutor.mode_child'))}</button>
        <button type="button" class="chip" data-mode="haiti">${esc(t('tutor.mode_haiti'))}</button>
        <button type="button" class="chip" data-mode="compare">${esc(t('tutor.mode_compare'))}</button>
        <button type="button" class="chip" data-mode="mnemonic">${esc(t('tutor.mode_mnemonic'))}</button>
        <button type="button" class="chip" data-mode="quiz">${esc(t('tutor.mode_quiz'))}</button>
      </div>
      <form class="composer" id="tutor-form">
        <textarea class="textarea" id="tutor-input" rows="1" placeholder="${esc(t('tutor.placeholder'))}"></textarea>
        <button type="submit" class="btn btn-primary" id="tutor-send-btn" aria-label="${esc(t('tutor.send'))}">${icon('send')}</button>
      </form>
    </div>`;
  document.body.appendChild(panel);
  icons(btn);
  icons(panel);

  document.getElementById('tutor-close-btn').addEventListener('click', () => toggleTutorDrawer(false));

  const chips = panel.querySelectorAll('#tutor-mode-chips .chip');
  chips.forEach((ch) => {
    ch.addEventListener('click', () => {
      const mode = ch.dataset.mode;
      const prompts = {
        simple: t('tutor.quick_simple'),
        child: t('tutor.quick_child'),
        haiti: t('tutor.quick_haiti'),
        compare: t('tutor.quick_compare'),
        mnemonic: t('tutor.quick_mnemonic'),
        quiz: t('tutor.quick_quiz'),
      };
      sendTutorMessage(prompts[mode] || t('tutor.quick_simple'), mode);
    });
  });

  const form = document.getElementById('tutor-form');
  const input = document.getElementById('tutor-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const txt = input.value.trim();
    if (!txt) return;
    input.value = '';
    sendTutorMessage(txt, 'standard');
  });

  tutorInitialized = true;
  renderTutorWelcome();
}

function needsVerificationNotice() {
  const f = currentProfile?.faculty_id;
  return ['medecine', 'sciences_infirmieres', 'pharmacie', 'odontologie', 'droit'].includes(f);
}

function renderTutorWelcome() {
  const box = document.getElementById('tutor-messages');
  if (!box || tutorHistory.length > 0) return;
  const facNotice = needsVerificationNotice()
    ? `<div class="alert alert-warning text-xs mt-2">${icon('alert-triangle')}<span>${esc(t('tutor.verify_warning'))}</span></div>`
    : '';
  box.innerHTML = `
    <div class="msg msg-assistant">
      <p>${esc(t('tutor.welcome'))}</p>
      ${facNotice}
    </div>`;
  icons(box);
}

export function setTutorContext(ctx = {}) {
  currentContext = { ...currentContext, ...ctx };
  const badge = document.getElementById('tutor-context-badge');
  if (badge) {
    badge.textContent = ctx.contextTitle || t(`tutor.context_${currentContext.contextType}`) || t('tutor.context_general');
  }
}

export function toggleTutorDrawer(open, initialPrompt = null, mode = 'standard') {
  if (!tutorInitialized) ensureTutorButton();
  const panel = document.getElementById('tutor-panel');
  if (!panel) return;
  const shouldOpen = open !== undefined ? open : !panel.classList.contains('is-open');
  panel.classList.toggle('is-open', shouldOpen);
  if (shouldOpen) {
    document.getElementById('tutor-input')?.focus();
    if (initialPrompt) sendTutorMessage(initialPrompt, mode);
  }
}

async function sendTutorMessage(text, mode = 'standard') {
  const box = document.getElementById('tutor-messages');
  if (!box) return;

  if (tutorHistory.length === 0) box.innerHTML = '';

  const userDiv = document.createElement('div');
  userDiv.className = 'msg msg-user';
  userDiv.textContent = text;
  box.appendChild(userDiv);
  tutorHistory.push({ role: 'user', content: text });

  const typing = document.createElement('div');
  typing.className = 'msg msg-assistant';
  typing.innerHTML = '<div class="msg-typing"><span></span><span></span><span></span></div>';
  box.appendChild(typing);
  box.scrollTop = box.scrollHeight;

  try {
    const res = await askTutor({
      conversationId: tutorConvId,
      message: text,
      mode,
      contextType: currentContext.contextType,
      contextId: currentContext.contextId,
      contextText: currentContext.contextText,
      courseId: currentContext.courseId,
      faculty: currentProfile?.faculty_id || 'autre',
      level: currentProfile?.level || 'L1',
      language: getLang(),
      history: tutorHistory.slice(-8),
    });
    if (res?.conversationId) tutorConvId = res.conversationId;
    const reply = res?.reply || t('errors.ai_unavailable');
    tutorHistory.push({ role: 'assistant', content: reply });

    const cites = Array.isArray(res?.libraryCitations) ? res.libraryCitations : [];
    const uniqueCites = cites.filter((c, idx, arr) => c.book_id && arr.findIndex((x) => x.book_id === c.book_id) === idx).slice(0, 3);
    const citesHtml = uniqueCites.length
      ? `<div class="row-wrap mt-2">${uniqueCites.map((c) =>
          `<a class="badge badge-outline" href="${pageHref(`pages/library.html?book=${encodeURIComponent(c.book_id)}`)}">${esc(c.book_title)}${c.section_label ? ` · ${esc(c.section_label)}` : ''}</a>`
        ).join('')}</div>`
      : '';

    typing.innerHTML = renderMarkdown(reply)
      + citesHtml
      + (needsVerificationNotice()
        ? `<div class="text-xs muted mt-2">${esc(t('tutor.verify_short'))}</div>`
        : '');
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    typing.remove();
    toast(handleError(err), 'error');
  }
}

onLangChange(() => {
  // Les labels dynamiques seront rafraîchis au rechargement ou changement manuel
});
