/* =====================================================================
   PRAN NÒT - auth.js
   Session, garde d'accès des pages, profil, administration.
   ===================================================================== */
import './supabase.js';
import { initI18n, detectLang } from './i18n.js';
import { syncThemeFromProfile } from './theme.js';
import { cacheGet, cacheSet, cacheDel, cacheEntriesByPrefix } from './offline.js';

const db = window.db;
let profileCache = null;

// Enregistrer le Service Worker une seule fois sans déclencher de rechargement intempestif
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  const swUrl = new URL('../../sw.js', import.meta.url).href;
  navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' })
    .then((reg) => reg.update().catch(() => {}))
    .catch(() => {});
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
  try {
    const { data, error } = await db.auth.getSession();
    if (!error && data?.session) return data.session;
    if (error) console.warn('[auth] getSession', error);
  } catch (e) {
    console.warn('[auth] getSession thrown', e);
  }

  // Repli hors-ligne : si l'utilisateur s'était déjà connecté, restaurer sa session locale
  try {
    const rawUser = localStorage.getItem('prannot.last_user');
    const rawProfile = localStorage.getItem('prannot.profile');
    if (rawUser) {
      const u = JSON.parse(rawUser);
      return {
        user: u,
        access_token: 'offline_token',
        is_offline_guest: false,
      };
    }
    // Mode invité / offline local si activé
    const guestUser = localStorage.getItem('prannot.offline_guest');
    if (guestUser) {
      const u = JSON.parse(guestUser);
      return {
        user: u,
        access_token: 'offline_guest_token',
        is_offline_guest: true,
      };
    }
  } catch { /* ignore */ }

  return null;
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

  if (!navigator.onLine) {
    try {
      const raw = localStorage.getItem('prannot.profile');
      if (raw) {
        profileCache = JSON.parse(raw);
        return profileCache;
      }
    } catch { /* ignore */ }
  }

  let data = null;
  try {
    const res = await db
      .from('pran_not_profiles')
      .select('*, faculty:pran_not_faculties(id, name_fr, name_ht, icon, case_label_fr, case_label_ht)')
      .eq('id', user.id)
      .maybeSingle();
    if (res.error) throw res.error;
    data = res.data;
  } catch (err) {
    console.warn('[auth] profil non récupéré en ligne', err);
    try {
      const raw = localStorage.getItem('prannot.profile');
      if (raw) data = JSON.parse(raw);
    } catch { /* ignore */ }
  }

  if (!data && navigator.onLine) {
    // Crée le profil Pran Nòt si le compte existait déjà dans auth.users (projet Supabase partagé)
    try {
      const { error: ensureErr } = await db.rpc('pran_not_ensure_profile');
      if (!ensureErr) {
        const retry = await db
          .from('pran_not_profiles')
          .select('*, faculty:pran_not_faculties(id, name_fr, name_ht, icon, case_label_fr, case_label_ht)')
          .eq('id', user.id)
          .maybeSingle();
        if (!retry.error) data = retry.data;
      }
    } catch { /* ignore */ }
  }

  if (!data) {
    // Profil par défaut minimal pour ne pas bloquer hors-ligne
    data = {
      id: user.id,
      email: user.email || 'etidyan@prannot.ht',
      full_name: user.user_metadata?.full_name || 'Etidyan',
      faculty_id: 'autre',
      level: 'L1',
      university: 'Inivèsite',
      language: localStorage.getItem('prannot.lang') || 'ht',
      onboarded: true,
      xp: 0,
      xp_level: 1,
    };
  }

  profileCache = data;
  // Hors-ligne : garder une copie locale pour démarrer sans réseau
  if (data) {
    try {
      localStorage.setItem('prannot.profile', JSON.stringify(data));
      if (user) localStorage.setItem('prannot.last_user', JSON.stringify({ id: user.id, email: user.email || data.email }));
    } catch { /* ignore */ }
  }
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
 * Hors-ligne ou réseau lent : démarre immédiatement avec le profil en cache.
 * @returns {Promise<{session, user, profile}>}
 */
export async function requireAuth({ requireOnboarded = true } = {}) {
  const session = await getSession();
  if (!session) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(appUrl(`login.html?next=${next}`));
    throw new Error('redirect_login');
  }

  let cachedProfile = null;
  try {
    const raw = localStorage.getItem('prannot.profile');
    cachedProfile = raw ? JSON.parse(raw) : null;
  } catch { /* ignore */ }

  // Lancer i18n en parallèle sans attendre Supabase (gain ~150-500 ms par page)
  const initialLang = localStorage.getItem('prannot.lang') || cachedProfile?.language || detectLang();
  const i18nPromise = initI18n(initialLang);

  let profile = null;
  if (!navigator.onLine && cachedProfile) {
    profile = cachedProfile;
  } else {
    try {
      const fetchProfilePromise = getProfile();
      profile = cachedProfile
        ? await Promise.race([
            fetchProfilePromise,
            new Promise((resolve) => setTimeout(() => resolve(cachedProfile), 2500)),
          ])
        : await fetchProfilePromise;
    } catch (err) {
      console.warn('[auth] profil indisponible, utilisation du cache', err);
      profile = cachedProfile;
    }
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
  await i18nPromise;
  if (!localStorage.getItem('prannot.lang') && profile?.language && profile.language !== initialLang) {
    await initI18n(profile.language);
  }

  // Ping silencieux d'activité (toutes les 15 min) pour garder last_seen_at exact sur toutes les pages
  if (requireOnboarded && navigator.onLine) {
    const lastPing = Number(sessionStorage.getItem('prannot.lastPing') || 0);
    if (Date.now() - lastPing > 15 * 60 * 1000) {
      sessionStorage.setItem('prannot.lastPing', String(Date.now()));
      recordActivity().catch(() => {});
    }
  }

  // Nettoyer en arrière-plan tout résidu de cache d'autres étudiants (indispensable pour les comptes admin-étudiants)
  sanitizeUserStorage(session.user.id).catch(() => {});

  return { session, user: session.user, profile };
}

/**
 * Nettoie le cache local si des données d'autres étudiants s'y trouvent
 * (essentiel pour les comptes administrateurs qui sont aussi étudiants).
 */
export async function sanitizeUserStorage(userId) {
  if (!userId) return;
  try {
    // 1. Nettoyer les cours globaux en cache
    const cachedCourses = await cacheGet('courses_list');
    if (Array.isArray(cachedCourses) && cachedCourses.some((c) => c.user_id && c.user_id !== userId)) {
      const cleanCourses = cachedCourses.filter((c) => !c.user_id || c.user_id === userId);
      await cacheSet('courses_list', cleanCourses);
      await cacheSet(`courses_list_${userId}`, cleanCourses);
    }

    // 2. Nettoyer les notes globales en cache
    const cachedNotes = await cacheGet('notes_list');
    if (Array.isArray(cachedNotes) && cachedNotes.some((n) => n.user_id && n.user_id !== userId)) {
      const cleanNotes = cachedNotes.filter((n) => !n.user_id || n.user_id === userId);
      await cacheSet('notes_list', cleanNotes);
      await cacheSet(`notes_list_${userId}`, cleanNotes);
    }

    // 3. Nettoyer les devoirs globaux en cache
    const cachedAsgs = await cacheGet('assignments_list');
    if (Array.isArray(cachedAsgs) && cachedAsgs.some((a) => a.user_id && a.user_id !== userId)) {
      const cleanAsgs = cachedAsgs.filter((a) => !a.user_id || a.user_id === userId);
      await cacheSet('assignments_list', cleanAsgs);
      await cacheSet(`assignments_list_${userId}`, cleanAsgs);
    }

    // 4. Nettoyer les notes individuelles enregistrées dans le cache
    const entries = await cacheEntriesByPrefix('note_');
    for (const entry of entries || []) {
      if (entry.data?.user_id && entry.data.user_id !== userId) {
        await cacheDel(entry.key);
      }
    }
  } catch (e) {
    console.warn('[auth] sanitizeUserStorage error:', e);
  }
}

/** L'utilisateur courant figure-t-il dans pran_not_admin_users ? */
export async function isAdmin() {
  const user = await getUser();
  if (!user?.email) return false;
  if (!navigator.onLine) {
    return sessionStorage.getItem('prannot.isAdmin') === '1';
  }
  try {
    const { data, error } = await db
      .from('pran_not_admin_users')
      .select('email')
      .eq('email', user.email.toLowerCase())
      .maybeSingle();
    if (error) return sessionStorage.getItem('prannot.isAdmin') === '1';
    const ok = !!data;
    sessionStorage.setItem('prannot.isAdmin', ok ? '1' : '0');
    return ok;
  } catch {
    return sessionStorage.getItem('prannot.isAdmin') === '1';
  }
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
    localStorage.removeItem('prannot.last_user');
    localStorage.removeItem('prannot.offline_guest');
    localStorage.removeItem('prannot_note_capture_draft');
    localStorage.removeItem('prannot.liveClassDraft');
    await cacheDel('courses_list').catch(() => {});
    await cacheDel('notes_list').catch(() => {});
    await cacheDel('assignments_list').catch(() => {});
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
