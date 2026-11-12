/* =====================================================================
   PRAN NÒT - i18n.js
   Internationalisation Kreyòl (par défaut) / Français.
   - Les clés sont imbriquées : t('nav.home')
   - Interpolation : t('review.due', { count: 5 }) avec "{count}" dans le texte
   - Attributs HTML : data-i18n, data-i18n-placeholder, data-i18n-aria, data-i18n-title
   ===================================================================== */

const SUPPORTED = ['ht', 'fr'];
const STORAGE_KEY = 'prannot.lang';
const I18N_VERSION = '20261112f';
const LS_CACHE_PREFIX = 'prannot.i18n.';
const dictionaries = {};
let current = 'ht';
let readyPromise = null;
const listeners = new Set();

function readLocalDict(lang) {
  try {
    const raw = localStorage.getItem(`${LS_CACHE_PREFIX}${lang}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.v === I18N_VERSION && parsed?.data) return parsed.data;
  } catch { /* ignore */ }
  return null;
}

function writeLocalDict(lang, data) {
  try {
    localStorage.setItem(`${LS_CACHE_PREFIX}${lang}`, JSON.stringify({ v: I18N_VERSION, data }));
  } catch { /* quota localStorage */ }
}

/** Charge un dictionnaire JSON (instantané via localStorage / Service Worker, repli réseau). */
async function load(lang) {
  if (dictionaries[lang] && Object.keys(dictionaries[lang]).length > 0) return dictionaries[lang];
  const local = readLocalDict(lang);
  if (local) {
    dictionaries[lang] = local;
    return local;
  }
  try {
    const url = new URL(`../i18n/${lang}.json?v=${I18N_VERSION}`, import.meta.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dictionaries[lang] = await res.json();
    writeLocalDict(lang, dictionaries[lang]);
  } catch (err) {
    console.warn(`[i18n] Impossible de charger ${lang}.json`, err);
    dictionaries[lang] = local || {};
  }
  return dictionaries[lang];
}

function lookup(dict, key) {
  return key.split('.').reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), dict);
}

/** Langue détectée : préférence enregistrée, sinon créole. */
export function detectLang() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (SUPPORTED.includes(saved)) return saved;
  return 'ht';
}

/** Initialise l'i18n (idempotent). À attendre avant tout rendu. */
export function initI18n(lang) {
  if (readyPromise && !lang) return readyPromise;
  current = SUPPORTED.includes(lang) ? lang : detectLang();
  document.documentElement.lang = current === 'ht' ? 'ht' : 'fr';
  const fallback = current === 'ht' ? 'fr' : 'ht';
  readyPromise = load(current).then(() => {
    applyI18n(document);
    // Pré-chauffer la deuxième langue en arrière-plan sans bloquer le premier affichage
    load(fallback).catch(() => {});
    return current;
  });
  return readyPromise;
}

export function getLang() {
  return current;
}

/** Change la langue, l'enregistre et réapplique les traductions. */
export async function setLang(lang, { persistProfile = true } = {}) {
  if (!SUPPORTED.includes(lang)) return;
  localStorage.setItem(STORAGE_KEY, lang);
  current = lang;
  document.documentElement.lang = lang;
  await load(lang);
  applyI18n(document);
  listeners.forEach((fn) => {
    try { fn(lang); } catch (e) { console.error(e); }
  });
  if (persistProfile && window.db) {
    try {
      const { data } = await window.db.auth.getSession();
      const uid = data?.session?.user?.id;
      if (uid) await window.db.from('pran_not_profiles').update({ language: lang }).eq('id', uid);
    } catch (e) {
      console.warn('[i18n] Préférence de langue non synchronisée', e);
    }
  }
}

/** Abonnement au changement de langue (pour re-rendre une page). */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Traduit une clé. Repli : autre langue, puis la clé elle-même.
 * Si la valeur est un tableau, retourne le tableau (voir tPick).
 */
export function t(key, vars = {}) {
  let value = lookup(dictionaries[current] || {}, key);
  if (value === undefined) value = lookup(dictionaries[current === 'ht' ? 'fr' : 'ht'] || {}, key);
  if (value === undefined) return key;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    // Pluriel simple : { "one": "...", "other": "..." }
    const n = Number(vars.count);
    value = n === 1 || n === 0 ? (value.one ?? value.other) : (value.other ?? value.one);
  }
  return String(value).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
}

/** Choisit un élément d'un tableau de traductions selon une graine (ex : jour de l'année). */
export function tPick(key, seed = 0, vars = {}) {
  const arr = t(key);
  if (!Array.isArray(arr) || !arr.length) return typeof arr === 'string' ? arr : key;
  const item = arr[Math.abs(seed) % arr.length];
  return String(item).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

/** Applique les traductions sur les attributs data-i18n* d'un sous-arbre. */
export function applyI18n(root = document) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    // Réservé aux chaînes de confiance provenant des fichiers i18n
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
}

/** Formatage de dates selon la langue (le créole utilise les conventions françaises). */
export function formatDate(value, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  if (current === 'ht') {
    const months = t('dates.months_short');
    if (Array.isArray(months) && opts.month === 'short' && !opts.hour) {
      const parts = [d.getDate(), months[d.getMonth()]];
      if (opts.year) parts.push(d.getFullYear());
      return parts.join(' ');
    }
  }
  return new Intl.DateTimeFormat('fr-FR', opts).format(d);
}

/** "il y a 3 h", "dans 2 jours" etc. */
export function formatRelative(value) {
  if (!value) return '';
  const d = new Date(value);
  const diffSec = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const future = diffSec > 0;
  let n; let unit;
  if (abs < 60) return t('dates.now');
  if (abs < 3600) { n = Math.round(abs / 60); unit = 'minutes'; }
  else if (abs < 86400) { n = Math.round(abs / 3600); unit = 'hours'; }
  else if (abs < 86400 * 30) { n = Math.round(abs / 86400); unit = 'days'; }
  else return formatDate(d);
  return t(future ? `dates.in_${unit}` : `dates.ago_${unit}`, { count: n });
}
