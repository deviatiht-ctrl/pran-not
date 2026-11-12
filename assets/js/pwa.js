/* =====================================================================
   PRAN NÒT - pwa.js
   Installation PWA directe sur téléphone (Android one-tap + guide iOS Safari)
   ===================================================================== */
import { t, getLang, onLangChange } from './i18n.js';
import { icons, icon, esc, openModal, toast } from './utils.js';

const DISMISS_KEY = 'prannot.pwaDismissedAt';
const DISMISS_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const PWA_FALLBACK = {
  ht: {
    'pwa.install_now': 'Enstale app la kounya',
    'pwa.install_phone': 'Enstale sou telefòn',
    'pwa.install_short': 'Enstale',
    'pwa.installed_badge': 'Enstale deja',
    'pwa.ready_badge': 'Pare pou enstalasyon',
    'pwa.ios_badge': 'iPhone / iPad (Safari)',
    'pwa.available_badge': 'Disponib sou navigatè',
    'pwa.installed_success': 'Pran Nòt enstale sou aparèy ou a!',
    'pwa.already_installed': 'Pran Nòt deja enstale ak fonksyone kòm aplikasyon.',
    'pwa.banner_title': 'Pran Nòt — Enstale sou telefòn ou',
    'pwa.banner_sub': 'Aksè nan yon sèl klik, foto rapid ak revizyon san entènèt.',
    'pwa.banner_sub_ios': 'Sou iPhone/iPad, tape Pataje epi Ajoute sou ekran akèy la.',
    'pwa.guide_title': 'Enstale Pran Nòt sou aparèy ou',
    'pwa.ios_intro': 'Sou Safari (iPhone oswa iPad), swiv 3 etap rapid sa yo:',
    'pwa.ios_step1_title': '1. Tape bouton Pataje (Share)',
    'pwa.ios_step1_desc': 'Ikòn kare ak flèch ki monte anba oswa anwo ekran Safari a.',
    'pwa.ios_step2_title': '2. Chwazi "Sur l\'écran d\'accueil" / "Add to Home Screen"',
    'pwa.ios_step2_desc': 'Glise desann nan meni an pou w wè opsyon sa a.',
    'pwa.ios_step3_title': '3. Tape "Ajoute / Add"',
    'pwa.ios_step3_desc': 'Pran Nòt ap parèt sou ekran telefòn ou menm jan ak nenpòt aplikasyon.',
    'pwa.android_intro': 'Si bwat enstalasyon otomatik la pa parèt, swiv 2 etap sa yo nan Chrome / Edge:',
    'pwa.android_step1_title': '1. Louvri meni navigatè a (twa pwen anwo adwat)',
    'pwa.android_step1_desc': 'Asire w w ap itilize Google Chrome, Samsung Internet oswa Edge sou HTTPS.',
    'pwa.android_step2_title': '2. Tape "Installer l\'application" oswa "Ajouter à l\'écran d\'accueil"',
    'pwa.android_step2_desc': 'Konfime enstalasyon an pou jwenn Pran Nòt sou telefòn ou.',
    'pwa.desktop_intro': 'Ou kapab enstale Pran Nòt kòm aplikasyon sou òdinatè w tou:',
    'pwa.desktop_step1_title': '1. Klike sou ikòn Enstale nan ba adrès navigatè a',
    'pwa.desktop_step1_desc': 'Oswa louvri meni Chrome / Edge -> Apps -> Installer Pran Nòt.',
    'pwa.desktop_step2_title': '2. Konfime pou lanse l nan pwòp fenèt pa l',
    'pwa.desktop_step2_desc': 'Li rete pare menm lè entènèt la koupe.',
    'common.ok': 'Oke',
    'common.close': 'Fèmen',
  },
  fr: {
    'pwa.install_now': "Installer l'application",
    'pwa.install_phone': 'Installer sur téléphone',
    'pwa.install_short': 'Installer',
    'pwa.installed_badge': 'Déjà installée',
    'pwa.ready_badge': 'Prête à installer',
    'pwa.ios_badge': 'iPhone / iPad (Safari)',
    'pwa.available_badge': 'Disponible via navigateur',
    'pwa.installed_success': 'Pran Nòt est installée sur votre appareil.',
    'pwa.already_installed': 'Pran Nòt fonctionne déjà en mode application installée.',
    'pwa.banner_title': 'Pran Nòt — Installer sur votre téléphone',
    'pwa.banner_sub': 'Accès direct en 1 touche, capture rapide et révisions hors-ligne.',
    'pwa.banner_sub_ios': "Sur iPhone/iPad, touchez Partager puis Sur l'écran d'accueil.",
    'pwa.guide_title': 'Installer Pran Nòt sur votre appareil',
    'pwa.ios_intro': 'Sur Safari (iPhone ou iPad), suivez ces 3 étapes simples :',
    'pwa.ios_step1_title': '1. Touchez le bouton Partager',
    'pwa.ios_step1_desc': "L'icône carrée avec une flèche vers le haut dans la barre Safari.",
    'pwa.ios_step2_title': '2. Choisissez "Sur l\'écran d\'accueil"',
    'pwa.ios_step2_desc': 'Faites défiler les actions du menu vers le bas si nécessaire.',
    'pwa.ios_step3_title': '3. Touchez "Ajouter"',
    'pwa.ios_step3_desc': "L'icône Pran Nòt apparaît sur votre écran d'accueil comme une app native.",
    'pwa.android_intro': "Si la fenêtre d'installation automatique n'apparaît pas, suivez ces 2 étapes dans Chrome / Edge :",
    'pwa.android_step1_title': '1. Ouvrez le menu du navigateur (3 points en haut à droite)',
    'pwa.android_step1_desc': 'Utilisez Google Chrome, Edge ou Samsung Internet sur la page HTTPS.',
    'pwa.android_step2_title': '2. Touchez "Installer l\'application" ou "Ajouter à l\'écran d\'accueil"',
    'pwa.android_step2_desc': "Validez pour installer l'icône et le mode hors-ligne sur votre téléphone.",
    'pwa.desktop_intro': 'Vous pouvez également installer Pran Nòt sur votre ordinateur :',
    'pwa.desktop_step1_title': "1. Cliquez sur l'icône Installer dans la barre d'adresse",
    'pwa.desktop_step1_desc': 'Ou ouvrez le menu Chrome / Edge -> Applications -> Installer Pran Nòt.',
    'pwa.desktop_step2_title': "2. Confirmez l'installation",
    'pwa.desktop_step2_desc': "L'application s'ouvre dans sa propre fenêtre, même hors-ligne.",
    'common.ok': 'OK',
    'common.close': 'Fermer',
  },
};

function tr(key) {
  const val = t(key);
  if (val && val !== key) return val;
  const lang = getLang() === 'fr' ? 'fr' : 'ht';
  return PWA_FALLBACK[lang][key] || PWA_FALLBACK.ht[key] || key;
}

let deferredPrompt = typeof window !== 'undefined' ? (window.__prannotDeferredPrompt || null) : null;
let listenersBound = false;
let bannerOpts = { showBanner: true };

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.navigator?.standalone === true,
  );
}

export function isIosDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isAndroidDevice() {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
}

export function isMobileViewport() {
  if (typeof window === 'undefined') return false;
  return isIosDevice() || isAndroidDevice() || window.innerWidth <= 900;
}

export function canNativeInstall() {
  return Boolean(deferredPrompt);
}

function isBannerDismissed() {
  try {
    const ts = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return Boolean(ts && (Date.now() - ts) < DISMISS_TTL_MS);
  } catch {
    return false;
  }
}

function dismissBanner() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch { /* ignore */ }
  document.getElementById('pwa-install-banner')?.remove();
}

function bindEarlyEvents() {
  if (listenersBound || typeof window === 'undefined') return;
  listenersBound = true;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.__prannotDeferredPrompt = e;
    syncPwaControls();
    if (bannerOpts.showBanner) maybeShowBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    window.__prannotDeferredPrompt = null;
    document.getElementById('pwa-install-banner')?.remove();
    syncPwaControls();
    toast(tr('pwa.installed_success'), 'success');
  });
}

bindEarlyEvents();

/** Ouvre un guide visuel propre (zéro emoji) selon l'appareil (iPhone/Android/PC). */
export function openInstallGuideModal() {
  const ios = isIosDevice();
  const android = isAndroidDevice();
  const bodyHtml = ios
    ? `<div class="stack-sm">
        <p class="text-sm muted mb-2">${esc(tr('pwa.ios_intro'))}</p>
        <div class="pwa-step">
          <span class="icon-chip sm accent">${icon('share')}</span>
          <div>
            <strong class="text-sm">${esc(tr('pwa.ios_step1_title'))}</strong>
            <div class="text-xs muted">${esc(tr('pwa.ios_step1_desc'))}</div>
          </div>
        </div>
        <div class="pwa-step">
          <span class="icon-chip sm accent">${icon('plus-square')}</span>
          <div>
            <strong class="text-sm">${esc(tr('pwa.ios_step2_title'))}</strong>
            <div class="text-xs muted">${esc(tr('pwa.ios_step2_desc'))}</div>
          </div>
        </div>
        <div class="pwa-step">
          <span class="icon-chip sm accent">${icon('check')}</span>
          <div>
            <strong class="text-sm">${esc(tr('pwa.ios_step3_title'))}</strong>
            <div class="text-xs muted">${esc(tr('pwa.ios_step3_desc'))}</div>
          </div>
        </div>
      </div>`
    : `<div class="stack-sm">
        <p class="text-sm muted mb-2">${esc(tr(android ? 'pwa.android_intro' : 'pwa.desktop_intro'))}</p>
        <div class="pwa-step">
          <span class="icon-chip sm accent">${icon(android ? 'more-vertical' : 'download')}</span>
          <div>
            <strong class="text-sm">${esc(tr(android ? 'pwa.android_step1_title' : 'pwa.desktop_step1_title'))}</strong>
            <div class="text-xs muted">${esc(tr(android ? 'pwa.android_step1_desc' : 'pwa.desktop_step1_desc'))}</div>
          </div>
        </div>
        <div class="pwa-step">
          <span class="icon-chip sm accent">${icon('smartphone')}</span>
          <div>
            <strong class="text-sm">${esc(tr(android ? 'pwa.android_step2_title' : 'pwa.desktop_step2_title'))}</strong>
            <div class="text-xs muted">${esc(tr(android ? 'pwa.android_step2_desc' : 'pwa.desktop_step2_desc'))}</div>
          </div>
        </div>
      </div>`;

  const { close } = openModal({
    title: tr('pwa.guide_title'),
    body: bodyHtml,
    footer: `<button type="button" class="btn btn-primary" data-pwa-ok>${esc(tr('common.ok'))}</button>`,
  });
  document.querySelector('[data-pwa-ok]')?.addEventListener('click', () => close());
}

/** Déclenche l'installation PWA directe (native ou guide iOS/Android). */
export async function triggerPwaInstall() {
  if (isStandalone()) {
    toast(tr('pwa.already_installed'), 'info');
    return true;
  }

  const promptEv = deferredPrompt || window.__prannotDeferredPrompt;
  if (promptEv) {
    try {
      await promptEv.prompt();
      const choice = await promptEv.userChoice;
      deferredPrompt = null;
      window.__prannotDeferredPrompt = null;
      syncPwaControls();
      if (choice?.outcome === 'accepted') {
        document.getElementById('pwa-install-banner')?.remove();
        toast(tr('pwa.installed_success'), 'success');
        return true;
      }
      return false;
    } catch {
      openInstallGuideModal();
      return false;
    }
  }

  openInstallGuideModal();
  return false;
}

/** Synchronise tous les boutons [data-pwa-install] et badges [data-pwa-status]. */
export function syncPwaControls() {
  const installed = isStandalone();
  const nativeReady = canNativeInstall();

  document.querySelectorAll('[data-pwa-install]').forEach((btn) => {
    const mode = btn.dataset.pwaMode || 'always'; // 'always' | 'when-available'
    if (installed) {
      if (mode === 'when-available') {
        btn.hidden = true;
      } else {
        btn.disabled = true;
        const labelEl = btn.querySelector('[data-pwa-label]');
        if (labelEl) labelEl.textContent = tr('pwa.installed_badge');
      }
      return;
    }

    btn.hidden = false;
    btn.disabled = false;
    const labelEl = btn.querySelector('[data-pwa-label]');
    if (labelEl) {
      labelEl.textContent = tr(nativeReady ? 'pwa.install_now' : 'pwa.install_phone');
    }
  });

  document.querySelectorAll('[data-pwa-status]').forEach((el) => {
    if (installed) {
      el.className = 'badge badge-success';
      el.textContent = tr('pwa.installed_badge');
    } else if (nativeReady) {
      el.className = 'badge badge-accent';
      el.textContent = tr('pwa.ready_badge');
    } else {
      el.className = 'badge badge-outline';
      el.textContent = tr(isIosDevice() ? 'pwa.ios_badge' : 'pwa.available_badge');
    }
  });
}

function maybeShowBanner() {
  if (isStandalone() || isBannerDismissed()) return;
  if (!canNativeInstall() && !isMobileViewport()) return;
  if (document.getElementById('pwa-install-banner')) return;

  const hasBottomNav = Boolean(document.getElementById('mobile-nav'));
  const iconSrc = new URL('../icons/icon-nav.png', import.meta.url).href;
  const titleText = tr('pwa.banner_title');
  const subText = tr(isIosDevice() ? 'pwa.banner_sub_ios' : 'pwa.banner_sub');

  const el = document.createElement('aside');
  el.id = 'pwa-install-banner';
  el.className = `pwa-install-banner${hasBottomNav ? ' with-mobile-nav' : ''}`;
  el.setAttribute('aria-label', titleText);
  el.innerHTML = `
    <span class="nav-brand-mark" style="width:40px;height:40px;border-radius:11px;" aria-hidden="true">
      <img src="${esc(iconSrc)}" alt="Pran Nòt">
    </span>
    <div class="pwa-install-copy">
      <strong class="text-sm">${esc(titleText)}</strong>
      <span class="text-xs muted">${esc(subText)}</span>
    </div>
    <div class="pwa-install-actions">
      <button type="button" class="btn btn-sm btn-primary" id="pwa-banner-install-btn">
        ${icon('download')}
        <span>${esc(tr('pwa.install_short'))}</span>
      </button>
      <button type="button" class="btn-icon" id="pwa-banner-close-btn" aria-label="${esc(tr('common.close'))}">
        ${icon('x')}
      </button>
    </div>`;

  document.body.appendChild(el);
  icons(el);

  document.getElementById('pwa-banner-install-btn')?.addEventListener('click', () => {
    triggerPwaInstall();
  });
  document.getElementById('pwa-banner-close-btn')?.addEventListener('click', () => {
    dismissBanner();
  });
}

/** Branche tous les boutons [data-pwa-install] et affiche la bannière mobile si pertinent. */
export function initPwaInstall(opts = {}) {
  bannerOpts = { showBanner: true, ...opts };
  bindEarlyEvents();

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    const swUrl = new URL('../../sw.js', import.meta.url).href;
    navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' }).catch(() => {});
  }

  document.querySelectorAll('[data-pwa-install]').forEach((btn) => {
    if (btn.dataset.pwaBound === '1') return;
    btn.dataset.pwaBound = '1';
    btn.addEventListener('click', () => triggerPwaInstall());
  });

  syncPwaControls();

  if (bannerOpts.showBanner) {
    setTimeout(() => maybeShowBanner(), 900);
  }

  if (!window.__prannotPwaLangHooked) {
    window.__prannotPwaLangHooked = true;
    onLangChange(() => {
      syncPwaControls();
      const b = document.getElementById('pwa-install-banner');
      if (b) {
        b.remove();
        maybeShowBanner();
      }
    });
  }
}
