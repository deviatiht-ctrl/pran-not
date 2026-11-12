/* =====================================================================
   PRAN NÒT - auth.js
   Session, garde d'accès des pages, profil, administration.
   ===================================================================== */
import './supabase.js';
import { initI18n, detectLang } from './i18n.js';
import { syncThemeFromProfile } from './theme.js';

const db = window.db;
let profileCache = null;

// Mettre à jour le Service Worker sans cache HTTP périmé (y compris sur onboarding.html et login.html)
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  const swUrl = new URL('../../sw.js', import.meta.url).href;
  let userStartedInput = false;
  document.addEventListener('input', () => { userStartedInput = true; }, { once: true, capture: true });

  navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' })
    .then((reg) => reg.update().catch(() => {}))
    .catch(() => {});

  if (hadController) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const last = Number(sessionStorage.getItem('prannot.swReloadAt') || 0);
      if (!userStartedInput && Date.now() - last > 10000) {
        sessionStorage.setItem('prannot.swReloadAt', String(Date.now()));
        location.reload();
      }
    });
  }
}

/** URL absolue d'une ressource du site, quelle que soit la profondeur de la page. */
export function appUrl(path = '') {
  return new URL(`../../${path.replace(/^\//, '')}`, import.meta.url).href;
}

/** Redirection vers une page interne. */
export function go(path) {
  location.href = appUrl(path);
}

export async function getSession() {
  const { data, error } = await db.auth.getSession();
  if (error) console.warn('[auth] getSession', error);
  return data?.session || null;
}

export async function getUser() {
  const s = await getSession();
  return s?.user || null;
}

/** Profil de l'utilisateur courant (mis en cache pour la page). */
export async function getProfile(force = false) {
  if (profileCache && !force) return profileCache;
  const user = await getUser();
  if (!user) return null;
  let { data, error } = await db
    .from('pran_not_profiles')
    .select('*, faculty:pran_not_faculties(id, name_fr, name_ht, icon, case_label_fr, case_label_ht)')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // Crée le profil Pran Nòt si le compte existait déjà dans auth.users (projet Supabase partagé)
    const { error: ensureErr } = await db.rpc('pran_not_ensure_profile');
    if (ensureErr) throw ensureErr;
    const retry = await db
      .from('pran_not_profiles')
      .select('*, faculty:pran_not_faculties(id, name_fr, name_ht, icon, case_label_fr, case_label_ht)')
      .eq('id', user.id)
      .maybeSingle();
    if (retry.error) throw retry.error;
    data = retry.data;
  }
  profileCache = data;
  // Hors-ligne : garder une copie locale pour démarrer sans réseau
  if (data) localStorage.setItem('prannot.profile', JSON.stringify(data));
  return data;
}

export async function updateProfile(patch) {
  const user = await getUser();
  if (!user) throw new Error('not_authenticated');
  const { data, error } = await db.from('pran_not_profiles').update(patch).eq('id', user.id).select().single();
  if (error) throw error;
  profileCache = { ...(profileCache || {}), ...data };
  localStorage.setItem('prannot.profile', JSON.stringify(profileCache));
  return profileCache;
}

/** Applique les préférences du profil à l'interface (langue, économie de données, thème). */
function applyPreferences(profile) {
  if (!profile) return;
  document.body.classList.toggle('data-saver', !!profile.data_saver);
  localStorage.setItem('prannot.dataSaver', profile.data_saver ? '1' : '0');
  if (!localStorage.getItem('prannot.lang') && profile.language) {
    localStorage.setItem('prannot.lang', profile.language);
  }
  syncThemeFromProfile(profile);
}

/**
 * Garde d'accès pour les pages applicatives.
 * - Redirige vers login.html si pas de session.
 * - Redirige vers onboarding.html si le profil n'est pas complété.
 * Hors-ligne : utilise le profil mis en cache.
 * @returns {Promise<{session, user, profile}>}
 */
export async function requireAuth({ requireOnboarded = true } = {}) {
  const session = await getSession();
  if (!session) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(appUrl(`login.html?next=${next}`));
    throw new Error('redirect_login');
  }

  let profile = null;
  try {
    profile = await getProfile();
  } catch (err) {
    console.warn('[auth] profil indisponible, utilisation du cache', err);
    const cached = localStorage.getItem('prannot.profile');
    profile = cached ? JSON.parse(cached) : null;
  }

  if (profile?.is_banned) {
    await db.auth.signOut();
    location.replace(appUrl('login.html?banned=1'));
    throw new Error('banned');
  }

  if (requireOnboarded && profile && !profile.onboarded) {
    location.replace(appUrl('onboarding.html'));
    throw new Error('redirect_onboarding');
  }

  applyPreferences(profile);
  await initI18n(localStorage.getItem('prannot.lang') || profile?.language || detectLang());

  // Ping silencieux d'activité (toutes les 15 min) pour garder last_seen_at exact sur toutes les pages
  if (requireOnboarded && navigator.onLine) {
    const lastPing = Number(sessionStorage.getItem('prannot.lastPing') || 0);
    if (Date.now() - lastPing > 15 * 60 * 1000) {
      sessionStorage.setItem('prannot.lastPing', String(Date.now()));
      recordActivity().catch(() => {});
    }
  }

  return { session, user: session.user, profile };
}

/** L'utilisateur courant figure-t-il dans pran_not_admin_users ? */
export async function isAdmin() {
  const user = await getUser();
  if (!user?.email) return false;
  const { data, error } = await db
    .from('pran_not_admin_users')
    .select('email')
    .eq('email', user.email.toLowerCase())
    .maybeSingle();
  if (error) return false;
  return !!data;
}

/**
 * Garde d'accès des pages admin : getSession puis lecture pran_not_admin_users,
 * redirection vers login.html sinon.
 */
export async function requireAdmin() {
  const session = await getSession();
  if (!session) {
    location.replace(appUrl('login.html'));
    throw new Error('redirect_login');
  }
  const ok = await isAdmin();
  if (!ok) {
    location.replace(appUrl('login.html?admin=denied'));
    throw new Error('not_admin');
  }
  let profile = null;
  try { profile = await getProfile(); } catch { /* facultatif */ }
  applyPreferences(profile);
  await initI18n(localStorage.getItem('prannot.lang') || profile?.language || 'ht');
  return { session, user: session.user, profile };
}

export async function signOut() {
  try {
    await db.auth.signOut();
  } finally {
    profileCache = null;
    localStorage.removeItem('prannot.profile');
    location.replace(appUrl('login.html'));
  }
}

/** Réagit aux changements d'état d'authentification (ex : expiration). */
db.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    profileCache = null;
  }
});

/** Initiales pour l'avatar. */
export function initials(name, email) {
  const src = (name || email || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/** Signale une activité d'étude (série + XP de base). Silencieux hors-ligne. */
export async function recordActivity() {
  if (!navigator.onLine) return null;
  try {
    const { data, error } = await db.rpc('pran_not_record_activity');
    if (error) throw error;
    return data;
  } catch (e) {
    console.warn('[auth] record_activity', e);
    return null;
  }
}

/** Attribue de l'XP (plafonné côté serveur). */
export async function awardXp(amount, reason, refId = null) {
  if (!navigator.onLine) return null;
  try {
    const { data, error } = await db.rpc('pran_not_award_xp', { p_amount: amount, p_reason: reason, p_ref: refId });
    if (error) throw error;
    return data;
  } catch (e) {
    console.warn('[auth] award_xp', e);
    return null;
  }
}
