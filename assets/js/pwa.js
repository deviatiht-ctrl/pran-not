/* =====================================================================
   PRAN NÒT - pwa.js
   Installation PWA directe sur téléphone (Android one-tap + guide iOS Safari)
   ===================================================================== */
import { t, onLangChange } from './i18n.js';
import { icons, icon, esc, openModal, toast } from './utils.js';

const DISMISS_KEY = 'prannot.pwaDismissedAt';
const DISMISS_TTL_MS = 3 * 24 * 60 * 60 * 1000;

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
    toast(t('pwa.installed_success'), 'success');
  });
}

bindEarlyEvents();

/** Ouvre un guide visuel propre (zéro emoji) selon l'appareil (iPhone/Android/PC). */
export function openInstallGuideModal() {
  const ios = isIosDevice();
  const android = isAndroidDevice();
  const bodyHtml = ios
    ? `<div class="stack-sm">
        <p class="text-sm muted mb-2">${esc(t('pwa.ios_intro'))}</p>
        <div class="pwa-step">
          <span class="icon-chip sm accent">${icon('share')}</span>
          <div>
            <strong class="text-sm">${esc(t('pwa.ios_step1_title'))}</strong>
            <div class="text-xs muted">${esc(t('pwa.ios_step1_desc'))}</div>
          </div>
        </div>
        <div class="pwa-step">
          <span class="icon-chip sm accent">${icon('plus-square')}</span>
          <div>
            <strong class="text-sm">${esc(t('pwa.ios_step2_title'))}</strong>
            <div class="text-xs muted">${esc(t('pwa.ios_step2_desc'))}</div>
          </div>
        </div>
        <div class="pwa-step">
          <span class="icon-chip sm accent">${icon('check')}</span>
          <div>
            <strong class="text-sm">${esc(t('pwa.ios_step3_title'))}</strong>
            <div class="text-xs muted">${esc(t('pwa.ios_step3_desc'))}</div>
          </div>
        </div>
      </div>`
    : `<div class="stack-sm">
        <p class="text-sm muted mb-2">${esc(t(android ? 'pwa.android_intro' : 'pwa.desktop_intro'))}</p>
        <div class="pwa-step">
          <span class="icon-chip sm accent">${icon(android ? 'more-vertical' : 'download')}</span>
          <div>
            <strong class="text-sm">${esc(t(android ? 'pwa.android_step1_title' : 'pwa.desktop_step1_title'))}</strong>
            <div class="text-xs muted">${esc(t(android ? 'pwa.android_step1_desc' : 'pwa.desktop_step1_desc'))}</div>
          </div>
        </div>
        <div class="pwa-step">
          <span class="icon-chip sm accent">${icon('smartphone')}</span>
          <div>
            <strong class="text-sm">${esc(t(android ? 'pwa.android_step2_title' : 'pwa.desktop_step2_title'))}</strong>
            <div class="text-xs muted">${esc(t(android ? 'pwa.android_step2_desc' : 'pwa.desktop_step2_desc'))}</div>
          </div>
        </div>
      </div>`;

  const { close } = openModal({
    title: t('pwa.guide_title'),
    body: bodyHtml,
    footer: `<button type="button" class="btn btn-primary" data-pwa-ok>${esc(t('common.ok'))}</button>`,
  });
  document.querySelector('[data-pwa-ok]')?.addEventListener('click', () => close());
}

/** Déclenche l'installation PWA directe (native ou guide iOS/Android). */
export async function triggerPwaInstall() {
  if (isStandalone()) {
    toast(t('pwa.already_installed'), 'info');
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
        toast(t('pwa.installed_success'), 'success');
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
        if (labelEl) labelEl.textContent = t('pwa.installed_badge');
      }
      return;
    }

    btn.hidden = false;
    btn.disabled = false;
    const labelEl = btn.querySelector('[data-pwa-label]');
    if (labelEl) {
      labelEl.textContent = t(nativeReady ? 'pwa.install_now' : 'pwa.install_phone');
    }
  });

  document.querySelectorAll('[data-pwa-status]').forEach((el) => {
    if (installed) {
      el.className = 'badge badge-success';
      el.textContent = t('pwa.installed_badge');
    } else if (nativeReady) {
      el.className = 'badge badge-accent';
      el.textContent = t('pwa.ready_badge');
    } else {
      el.className = 'badge badge-outline';
      el.textContent = t(isIosDevice() ? 'pwa.ios_badge' : 'pwa.available_badge');
    }
  });
}

function maybeShowBanner() {
  if (isStandalone() || isBannerDismissed()) return;
  if (!canNativeInstall() && !isMobileViewport()) return;
  if (document.getElementById('pwa-install-banner')) return;

  const hasBottomNav = Boolean(document.getElementById('mobile-nav'));
  const el = document.createElement('aside');
  el.id = 'pwa-install-banner';
  el.className = `pwa-install-banner${hasBottomNav ? ' with-mobile-nav' : ''}`;
  el.setAttribute('aria-label', t('pwa.banner_title'));
  el.innerHTML = `
    <span class="icon-chip sm accent" aria-hidden="true">${icon('smartphone')}</span>
    <div class="pwa-install-copy">
      <strong class="text-sm">${esc(t('pwa.banner_title'))}</strong>
      <span class="text-xs muted">${esc(t(isIosDevice() ? 'pwa.banner_sub_ios' : 'pwa.banner_sub'))}</span>
    </div>
    <div class="pwa-install-actions">
      <button type="button" class="btn btn-sm btn-primary" id="pwa-banner-install-btn">
        ${icon('download')}
        <span>${esc(t('pwa.install_short'))}</span>
      </button>
      <button type="button" class="btn-icon" id="pwa-banner-close-btn" aria-label="${esc(t('common.close'))}">
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
