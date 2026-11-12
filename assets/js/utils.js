/* =====================================================================
   PRAN NÒT - utils.js
   Outils partagés : échappement HTML, assainissement, toasts, modales,
   skeletons, états vides, animations GSAP, compression d'images, etc.
   ===================================================================== */
import { t } from './i18n.js';

/* ------------------------------------------------------------------
   DOM
   ------------------------------------------------------------------ */
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Échappe une chaîne pour une insertion sûre dans du HTML. */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
export const esc = escapeHtml;

/** Rendu des icônes Lucide (à appeler après chaque rendu dynamique). */
export function icons(root) {
  if (!window.lucide) return;
  try {
    const opts = { icons: window.lucide.icons, nameAttr: 'data-lucide', attrs: { 'aria-hidden': 'true' } };
    if (root instanceof Element) opts.root = root;
    window.lucide.createIcons(opts);
  } catch {
    try { window.lucide.createIcons(); } catch (e) { console.warn('[lucide]', e); }
  }
}

/** Raccourci pour une icône Lucide. */
export const icon = (name, cls = '') => `<i data-lucide="${esc(name)}" class="${esc(cls)}" aria-hidden="true"></i>`;

/** Paramètre d'URL. */
export function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

/** Validation UUID (avant toute requête basée sur l'URL). */
export function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function debounce(fn, wait = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Normalise un numéro WhatsApp (8 chiffres -> 509XXXXXXXX ; 8 à 15 chiffres sans '+'). Retourne null si vide. */
export function normalizeWhatsAppPhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const digits = s.replace(/[\s+().-]+/g, '');
  if (/^\d{8}$/.test(digits)) return `509${digits}`;
  if (/^\d{8,15}$/.test(digits)) return digits;
  throw new Error('invalid_whatsapp_phone');
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function dayOfYear(d = new Date()) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const u = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function formatMinutes(min) {
  const m = Math.round(min || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r}` : `${h} h`;
}

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------
   Assainissement HTML (liste blanche) pour le contenu riche
   (notes Quill, sorties IA en HTML). Supprime scripts, styles, on*.
   ------------------------------------------------------------------ */
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'MARK', 'CODE', 'PRE', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'A', 'SPAN', 'DIV', 'TABLE', 'THEAD', 'TBODY',
  'TR', 'TH', 'TD', 'SUB', 'SUP', 'HR', 'IMG', 'SMALL',
]);
const ALLOWED_ATTRS = new Set(['href', 'title', 'class', 'src', 'alt', 'colspan', 'rowspan', 'data-uncertain', 'data-suggestion', 'data-value', 'loading', 'width', 'height']);

export function sanitizeHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstChild;
  const walk = (node) => {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === 8) { child.remove(); return; } // commentaires
      if (child.nodeType !== 1) return;
      if (!ALLOWED_TAGS.has(child.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'TEXTAREA', 'BUTTON', 'SVG', 'MATH'].includes(child.tagName)) {
          child.remove();
        } else {
          // garder le contenu texte, retirer la balise
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          child.remove();
        }
        return;
      }
      Array.from(child.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (!ALLOWED_ATTRS.has(name)) { child.removeAttribute(attr.name); return; }
        if ((name === 'href' || name === 'src') && !/^(https?:|mailto:|#|\/|\.\.?\/|blob:|data:image\/(png|jpe?g|webp|gif);)/i.test(attr.value.trim())) {
          child.removeAttribute(attr.name);
        }
      });
      if (child.tagName === 'A') { child.setAttribute('rel', 'noopener noreferrer'); child.setAttribute('target', '_blank'); }
      if (child.tagName === 'IMG') { child.setAttribute('loading', 'lazy'); }
      walk(child);
    });
  };
  walk(root);
  return root.innerHTML;
}

/** Texte brut depuis du HTML. */
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('p, li, h1, h2, h3, h4, div, tr').forEach((el) => el.append('\n'));
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Markdown minimal et sûr pour les réponses de l'IA :
 * titres (#), gras, italique, code, listes, paragraphes. Le texte est échappé d'abord.
 */
export function renderMarkdown(md) {
  if (!md) return '';
  const lines = esc(md).replace(/\r/g, '').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { closeList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      const lvl = Math.min(4, m[1].length + 1);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
      closeList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('');
}

/* ------------------------------------------------------------------
   Toasts
   ------------------------------------------------------------------ */
function toastRegion() {
  let region = qs('.toast-region');
  if (!region) {
    region = document.createElement('div');
    region.className = 'toast-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  return region;
}

/**
 * Affiche un toast.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} type
 * @param {{duration?:number, action?:{label:string, onClick:Function}}} opts
 */
export function toast(message, type = 'info', opts = {}) {
  const iconName = { success: 'check-circle-2', error: 'alert-circle', warning: 'alert-triangle', info: 'info' }[type] || 'info';
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `${icon(iconName)}<div class="flex-1">${esc(message)}</div>
    ${opts.action ? `<button type="button" class="toast-action">${esc(opts.action.label)}</button>` : ''}
    <button type="button" class="toast-close" aria-label="${esc(t('common.close'))}">${icon('x')}</button>`;
  toastRegion().appendChild(el);
  icons(el);
  const remove = () => {
    if (!el.isConnected) return;
    if (window.gsap && !prefersReducedMotion()) {
      window.gsap.to(el, { opacity: 0, y: -8, duration: 0.2, onComplete: () => el.remove() });
    } else el.remove();
  };
  el.querySelector('.toast-close').addEventListener('click', remove);
  if (opts.action) {
    el.querySelector('.toast-action').addEventListener('click', () => { opts.action.onClick?.(); remove(); });
  }
  if (window.gsap && !prefersReducedMotion()) window.gsap.from(el, { opacity: 0, y: -10, duration: 0.25 });
  setTimeout(remove, opts.duration ?? (type === 'error' ? 6000 : 3500));
  return remove;
}

/** Message d'erreur lisible (et journalisation console). */
export function handleError(err, fallbackKey = 'errors.generic') {
  console.error(err);
  let msg = t(fallbackKey);
  if (!navigator.onLine) msg = t('errors.offline');
  else if (err?.code === 'quota_exceeded') msg = err.message || t('errors.quota');
  else if (err?.userMessage) msg = err.userMessage;
  toast(msg, 'error');
  return msg;
}

/* ------------------------------------------------------------------
   Modales
   ------------------------------------------------------------------ */
let modalStack = 0;

/**
 * Ouvre une modale. Retourne { el, close }.
 * @param {{title:string, body:string|HTMLElement, footer?:string, size?:'lg', onClose?:Function, labelledBy?:string}} o
 */
export function openModal({ title = '', body = '', footer = '', size = '', onClose } = {}) {
  const lastFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const titleId = `modal-title-${uid().slice(0, 8)}`;
  overlay.innerHTML = `
    <div class="modal ${size === 'lg' ? 'modal-lg' : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <div class="modal-head">
        <h2 id="${titleId}">${esc(title)}</h2>
        <button type="button" class="btn-icon" data-close aria-label="${esc(t('common.close'))}">${icon('x')}</button>
      </div>
      <div class="modal-body"></div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  const bodyEl = overlay.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body instanceof Node) bodyEl.appendChild(body);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  modalStack++;
  icons(overlay);

  const modal = overlay.querySelector('.modal');
  if (window.gsap && !prefersReducedMotion()) {
    window.gsap.from(overlay, { opacity: 0, duration: 0.18 });
    window.gsap.from(modal, { y: 24, opacity: 0, duration: 0.28, ease: 'power3.out' });
  }

  const focusables = () => qsa('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', modal).filter((e) => !e.disabled && e.offsetParent !== null);
  setTimeout(() => {
    const first = focusables().find((e) => !e.hasAttribute('data-close')) || focusables()[0];
    first?.focus();
  }, 30);

  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener('keydown', onKey);

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    modalStack = Math.max(0, modalStack - 1);
    if (!modalStack) document.body.style.overflow = '';
    const done = () => { overlay.remove(); lastFocus?.focus?.(); onClose?.(result); };
    if (window.gsap && !prefersReducedMotion()) window.gsap.to(overlay, { opacity: 0, duration: 0.15, onComplete: done });
    else done();
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-close]')) close();
  });
  return { el: overlay, modal, body: bodyEl, close };
}

/** Confirmation asynchrone. Retourne true/false. */
export function confirmDialog({ title, message = '', confirmLabel, cancelLabel, danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({
      title: title || t('common.confirm_title'),
      body: `<p class="muted">${esc(message)}</p>`,
      footer: `<button type="button" class="btn btn-secondary" data-cancel>${esc(cancelLabel || t('common.cancel'))}</button>
               <button type="button" class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-ok>${esc(confirmLabel || t('common.confirm'))}</button>`,
      onClose: () => resolve(result),
    });
    m.el.querySelector('[data-cancel]').addEventListener('click', () => m.close());
    m.el.querySelector('[data-ok]').addEventListener('click', () => { result = true; m.close(); });
  });
}

/** Saisie de texte asynchrone. Retourne la chaîne ou null. */
export function promptDialog({ title, label = '', value = '', placeholder = '', multiline = false, maxLength = 500 } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const field = multiline
      ? `<textarea class="textarea" id="prompt-input" maxlength="${maxLength}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input class="input" id="prompt-input" maxlength="${maxLength}" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
    const m = openModal({
      title,
      body: `<div class="field"><label for="prompt-input">${esc(label)}</label>${field}</div>`,
      footer: `<button type="button" class="btn btn-secondary" data-cancel>${esc(t('common.cancel'))}</button>
               <button type="button" class="btn btn-primary" data-ok>${esc(t('common.save'))}</button>`,
      onClose: () => resolve(result),
    });
    const input = m.el.querySelector('#prompt-input');
    const ok = () => { result = input.value.trim(); m.close(); };
    m.el.querySelector('[data-cancel]').addEventListener('click', () => m.close());
    m.el.querySelector('[data-ok]').addEventListener('click', ok);
    if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  });
}

/* ------------------------------------------------------------------
   Skeletons, états vides, chargement de boutons
   ------------------------------------------------------------------ */
export function skeletonList(n = 4, height = 72) {
  return Array.from({ length: n }, () => `<div class="skeleton" style="height:${height}px;border-radius:12px;margin-bottom:10px"></div>`).join('');
}
export function skeletonCards(n = 6) {
  return Array.from({ length: n }, () => '<div class="skeleton skeleton-card"></div>').join('');
}
export function skeletonText(lines = 4) {
  return `<div class="skeleton skeleton-title"></div>${Array.from({ length: lines }, (_, i) => `<div class="skeleton skeleton-line" style="width:${90 - i * 9}%"></div>`).join('')}`;
}

/**
 * État vide soigné.
 * @param {{icon:string, title:string, text?:string, action?:string}} o action = HTML d'un bouton/lien
 */
export function emptyState({ icon: iconName = 'inbox', title, text = '', action = '' }) {
  return `<div class="empty">
    <span class="icon-chip">${icon(iconName)}</span>
    <h3>${esc(title)}</h3>
    ${text ? `<p>${esc(text)}</p>` : ''}
    ${action ? `<div class="row-wrap mt-2">${action}</div>` : ''}
  </div>`;
}

export function errorState(message, retryFn) {
  const id = `retry-${uid().slice(0, 6)}`;
  setTimeout(() => document.getElementById(id)?.addEventListener('click', retryFn));
  return `<div class="alert alert-error" role="alert">${icon('alert-circle')}<div class="flex-1">${esc(message || t('errors.generic'))}
    ${retryFn ? `<div class="mt-2"><button type="button" class="btn btn-sm btn-secondary" id="${id}">${icon('refresh-cw')}<span>${esc(t('common.retry'))}</span></button></div>` : ''}</div></div>`;
}

/** Bascule l'état de chargement d'un bouton. */
export function setLoading(btn, loading = true) {
  if (!btn) return;
  btn.classList.toggle('is-loading', loading);
  btn.disabled = loading;
  btn.setAttribute('aria-busy', loading ? 'true' : 'false');
}

/* ------------------------------------------------------------------
   Animations GSAP (respect de prefers-reduced-motion)
   ------------------------------------------------------------------ */
export function animateIn(targets, opts = {}) {
  const els = typeof targets === 'string' ? qsa(targets) : targets;
  if (!window.gsap || prefersReducedMotion() || !els || (els.length === 0)) return;
  window.gsap.from(els, {
    opacity: 0, y: 14, duration: 0.45, stagger: 0.05, ease: 'power3.out', clearProps: 'all', ...opts,
  });
}

/** Transition d'entrée de page. */
export function pageEnter(root = qs('main')) {
  if (!root || !window.gsap || prefersReducedMotion()) return;
  window.gsap.from(root, { opacity: 0, y: 8, duration: 0.35, ease: 'power2.out', clearProps: 'all' });
}

/** Anneau de progression SVG. */
export function ringSvg(percent, { size = 120, stroke = 10, label = '', sub = '' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = clamp(percent || 0, 0, 100);
  return `<div class="ring" style="width:${size}px;height:${size}px" role="img" aria-label="${esc(`${Math.round(p)}%`)}">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"></circle>
      <circle class="ring-value" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"
        stroke-dasharray="${c}" stroke-dashoffset="${c - (p / 100) * c}"></circle>
    </svg>
    <div class="ring-label"><strong>${esc(label || `${Math.round(p)}%`)}</strong>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
  </div>`;
}

/* ------------------------------------------------------------------
   Images : compression côté client, amélioration du contraste
   ------------------------------------------------------------------ */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/**
 * Compresse une image (JPEG). Option enhance : niveaux de gris + contraste
 * (utile pour le tableau) et rognage automatique des bords uniformes.
 * @returns {Promise<Blob>}
 */
export async function compressImage(file, { maxSize = 1600, quality = 0.72, enhance = false, autoCrop = false } = {}) {
  const img = await loadImage(file);
  let sx = 0; let sy = 0; let sw = img.naturalWidth; let sh = img.naturalHeight;

  if (autoCrop) {
    const crop = detectContentBounds(img);
    if (crop) ({ sx, sy, sw, sh } = crop);
  }

  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: enhance });
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);

  if (enhance) {
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    // histogramme de luminance pour un étirement automatique des niveaux
    const hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
      const l = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      hist[l]++;
    }
    const total = w * h;
    let lo = 0; let hi = 255; let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.02) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.02) { hi = i; break; } }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < px.length; i += 4) {
      const l = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      let v = ((l - lo) / range) * 255;
      v = v < 128 ? v * 0.9 : Math.min(255, v * 1.08); // léger renforcement du contraste
      v = clamp(v, 0, 255);
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(data, 0, 0);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('compression_failed'))), 'image/jpeg', quality);
  });
}

/** Détection simple des bords (zones uniformes) pour un recadrage automatique. */
function detectContentBounds(img) {
  const S = 200;
  const scale = S / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const lum = (x, y) => { const i = (y * w + x) * 4; return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; };
  const variance = (vals) => { const m = vals.reduce((a, b) => a + b, 0) / vals.length; return vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length; };
  const rowVar = (y) => variance(Array.from({ length: w }, (_, x) => lum(x, y)));
  const colVar = (x) => variance(Array.from({ length: h }, (_, y) => lum(x, y)));
  const TH = 60;
  let top = 0; while (top < h * 0.3 && rowVar(top) < TH) top++;
  let bottom = h - 1; while (bottom > h * 0.7 && rowVar(bottom) < TH) bottom--;
  let left = 0; while (left < w * 0.3 && colVar(left) < TH) left++;
  let right = w - 1; while (right > w * 0.7 && colVar(right) < TH) right--;
  if (top === 0 && left === 0 && bottom === h - 1 && right === w - 1) return null;
  const inv = 1 / scale;
  return {
    sx: Math.round(left * inv), sy: Math.round(top * inv),
    sw: Math.round((right - left + 1) * inv), sh: Math.round((bottom - top + 1) * inv),
  };
}

/** Blob -> base64 (sans préfixe data:). */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** Limites de taille des fichiers (octets). */
export const FILE_LIMITS = {
  image: 8 * 1024 * 1024,
  audio: 25 * 1024 * 1024,   // par segment
  pdf: 20 * 1024 * 1024,
  assignment: 20 * 1024 * 1024,
  avatar: 2 * 1024 * 1024,
};

export function checkFileSize(file, kind) {
  const max = FILE_LIMITS[kind] || FILE_LIMITS.image;
  if (file.size > max) {
    toast(t('errors.file_too_large', { max: formatBytes(max) }), 'error');
    return false;
  }
  return true;
}

/** Téléchargement d'un blob côté client. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Nom de fichier sûr. */
export function safeFilename(name, ext) {
  const base = String(name || 'pran-not').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'pran-not';
  return ext ? `${base}.${ext}` : base;
}

/** Charge un script externe une seule fois (chargement différé des bibliothèques lourdes). */
const loadedScripts = new Map();
export function loadScript(src) {
  if (loadedScripts.has(src)) return loadedScripts.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => { loadedScripts.delete(src); reject(new Error(`script_load_failed: ${src}`)); };
    document.head.appendChild(s);
  });
  loadedScripts.set(src, p);
  return p;
}

/** CDN centralisés (versions figées). */
export const CDN = {
  chart: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  jspdf: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
  docx: 'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js',
  pdfjs: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  pdfjsWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  quillJs: 'https://cdn.jsdelivr.net/npm/quill@1.3.7/dist/quill.min.js',
  quillCss: 'https://cdn.jsdelivr.net/npm/quill@1.3.7/dist/quill.snow.css',
};

/** Charge une feuille de style une seule fois. */
export function loadStyle(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}

/** Extrait le texte d'un PDF côté client avec PDF.js (limite de pages). */
export async function extractPdfText(file, { maxPages = 40 } = {}) {
  await loadScript(CDN.pdfjs);
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfjsWorker;
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = Math.min(pdf.numPages, maxPages);
  const parts = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => it.str).join(' '));
  }
  return { text: parts.join('\n\n').replace(/[ \t]+/g, ' ').trim(), pages: pdf.numPages };
}

/** Rendu d'une page PDF en image (pour les PDF scannés sans texte). */
export async function renderPdfPageToBlob(file, pageNumber = 1, scale = 1.6) {
  await loadScript(CDN.pdfjs);
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfjsWorker;
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width; canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
}
