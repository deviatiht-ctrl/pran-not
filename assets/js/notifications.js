/* =====================================================================
   PRAN NÒT - notifications.js
   Moteur complet de notifications hors-ligne & en ligne :
   - Sonneries Web Audio synthétisées (fonctionne 100 % hors-ligne, zéro MP3)
   - Vibration mobile + Notifications PWA natives (via Service Worker)
   - Détection automatique des cours qui commencent / en direct + bannière Live
   - Rappels échéances devoirs, révisions dues et Pomodoro
   - Synchronisation WhatsApp temps réel (via Edge Function whatsapp-gateway)
   ===================================================================== */
import { appUrl } from './auth.js';
import { t, getLang, formatRelative } from './i18n.js';
import { esc, icon, icons, openModal, toast } from './utils.js';
import { cacheGet, cacheSet } from './offline.js';
import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from './supabase.js';

const SCHEDULES_KEY = 'prannot.courseSchedules';
const SOUND_KEY = 'prannot.notifySound';
const CLASSES_NOTIFY_KEY = 'prannot.notifyClasses';
const FIRED_KEY = 'prannot.notifFired';
const LOCAL_NOTIFS_CACHE_KEY = 'notifications_local';
const REMOTE_NOTIFS_CACHE_KEY = 'notifications_remote';

const DAY_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

let sharedAudioCtx = null;
let audioUnlocked = false;
let monitorTimer = null;
let cachedProfileRef = null;
let cachedUserRef = null;

/* ------------------------------------------------------------------
   Son synthétisé 100 % hors-ligne (Web Audio API) + vibration
   ------------------------------------------------------------------ */
function ensureAudioContext() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!sharedAudioCtx) {
    try { sharedAudioCtx = new AC(); } catch { return null; }
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

function bindAudioUnlock() {
  if (audioUnlocked || typeof window === 'undefined') return;
  const unlock = () => {
    try {
      const ctx = ensureAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      // Jouer un micro-tampon silencieux pour déverrouiller le matériel audio sur iOS Safari et Chrome Android
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      audioUnlocked = true;
      ['pointerdown', 'touchstart', 'touchend', 'click', 'keydown'].forEach((evt) => {
        window.removeEventListener(evt, unlock);
      });
    } catch { /* ignore */ }
  };
  ['pointerdown', 'touchstart', 'touchend', 'click', 'keydown'].forEach((evt) => {
    window.addEventListener(evt, unlock, { passive: true, once: false });
  });
}
bindAudioUnlock();

export function isSoundEnabled() {
  try {
    const raw = localStorage.getItem(SOUND_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

export function setSoundEnabled(enabled) {
  try { localStorage.setItem(SOUND_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
}

export function isClassNotifyEnabled() {
  try {
    const raw = localStorage.getItem(CLASSES_NOTIFY_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

export function setClassNotifyEnabled(enabled) {
  try { localStorage.setItem(CLASSES_NOTIFY_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
}

/**
 * Joue un carillon acoustique riche avec harmoniques naturelles sans connexion réseau.
 * @param {'chime'|'live_class'|'deadline'|'success'|'pomodoro'} kind
 */
export function playNotificationSound(kind = 'chime', { force = false } = {}) {
  if (!force && !isSoundEnabled()) return false;
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(kind === 'live_class' || kind === 'deadline' ? [180, 80, 220, 80, 180] : [140, 60, 140]);
    }
  } catch { /* ignore */ }

  const ctx = ensureAudioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime + 0.015;

    // Motifs harmoniques mélodieux (fondamentale + harmonique 2.76x et 5.4x type cloche/marimba)
    const patterns = {
      live_class: [
        { freq: 659.25, dur: 0.38, delay: 0.0, vol: 0.28 },  // E5
        { freq: 783.99, dur: 0.42, delay: 0.16, vol: 0.30 }, // G5
        { freq: 1046.5, dur: 0.60, delay: 0.34, vol: 0.32 }, // C6
      ],
      deadline: [
        { freq: 587.33, dur: 0.35, delay: 0.0, vol: 0.26 },  // D5
        { freq: 440.0, dur: 0.32, delay: 0.18, vol: 0.24 },  // A4
        { freq: 587.33, dur: 0.48, delay: 0.36, vol: 0.28 }, // D5
      ],
      pomodoro: [
        { freq: 659.25, dur: 0.32, delay: 0.0, vol: 0.26 },
        { freq: 880.0, dur: 0.50, delay: 0.18, vol: 0.30 },
      ],
      success: [
        { freq: 523.25, dur: 0.24, delay: 0.0, vol: 0.24 },  // C5
        { freq: 783.99, dur: 0.45, delay: 0.12, vol: 0.28 }, // G5
      ],
      chime: [
        { freq: 587.33, dur: 0.30, delay: 0.0, vol: 0.24 },  // D5
        { freq: 880.0, dur: 0.48, delay: 0.14, vol: 0.26 },  // A5
      ],
    };

    const notes = patterns[kind] || patterns.chime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(1.0, now);
    masterGain.connect(ctx.destination);

    for (const n of notes) {
      const noteStart = now + n.delay;
      // Fondamentale
      const osc1 = ctx.createOscillator();
      const g1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(n.freq, noteStart);
      g1.gain.setValueAtTime(0.0001, noteStart);
      g1.gain.exponentialRampToValueAtTime(n.vol, noteStart + 0.008);
      g1.gain.exponentialRampToValueAtTime(0.0001, noteStart + n.dur);
      osc1.connect(g1);
      g1.connect(masterGain);
      osc1.start(noteStart);
      osc1.stop(noteStart + n.dur + 0.05);

      // Harmonique de résonance cristalline (timbre cloche douce)
      const osc2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(n.freq * 2.756, noteStart);
      g2.gain.setValueAtTime(0.0001, noteStart);
      g2.gain.exponentialRampToValueAtTime(n.vol * 0.32, noteStart + 0.006);
      g2.gain.exponentialRampToValueAtTime(0.0001, noteStart + (n.dur * 0.65));
      osc2.connect(g2);
      g2.connect(masterGain);
      osc2.start(noteStart);
      osc2.stop(noteStart + (n.dur * 0.65) + 0.05);
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------
   Horaires de cours (DB + stockage local persistant pour résilience)
   ------------------------------------------------------------------ */
export function normalizeTimeHHMM(val) {
  const s = String(val || '').trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return '';
  const hh = Math.min(23, Math.max(0, Number(m[1])));
  const mm = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function getLocalCourseSchedules() {
  try {
    return JSON.parse(localStorage.getItem(SCHEDULES_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function saveLocalCourseSchedule(courseId, sched = {}) {
  if (!courseId) return;
  try {
    const map = getLocalCourseSchedules();
    map[courseId] = {
      schedule_days: Array.isArray(sched.schedule_days) ? sched.schedule_days : (map[courseId]?.schedule_days || []),
      schedule_start_time: normalizeTimeHHMM(sched.schedule_start_time) || null,
      schedule_end_time: normalizeTimeHHMM(sched.schedule_end_time) || null,
      notify_before_minutes: Number.isFinite(Number(sched.notify_before_minutes))
        ? Number(sched.notify_before_minutes)
        : 15,
    };
    localStorage.setItem(SCHEDULES_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

export function mergeCourseSchedules(courses = []) {
  const map = getLocalCourseSchedules();
  return (courses || []).map((c) => {
    const local = map[c.id] || {};
    const start = normalizeTimeHHMM(c.schedule_start_time || local.schedule_start_time);
    const end = normalizeTimeHHMM(c.schedule_end_time || local.schedule_end_time);
    const days = Array.isArray(c.schedule_days) && c.schedule_days.length
      ? c.schedule_days
      : (Array.isArray(local.schedule_days) ? local.schedule_days : []);
    const notifyBefore = c.notify_before_minutes ?? local.notify_before_minutes ?? 15;
    if (start || end) {
      saveLocalCourseSchedule(c.id, {
        schedule_days: days,
        schedule_start_time: start,
        schedule_end_time: end,
        notify_before_minutes: notifyBefore,
      });
    }
    return {
      ...c,
      schedule_days: days,
      schedule_start_time: start || null,
      schedule_end_time: end || null,
      notify_before_minutes: Number(notifyBefore),
    };
  });
}

function toMinutes(hhmm) {
  const norm = normalizeTimeHHMM(hhmm);
  if (!norm) return null;
  const [h, m] = norm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Évalue si un cours est actuellement "en direct", "bientôt", ou "aujourd'hui".
 */
export function getCourseLiveStatus(course, now = new Date()) {
  const startStr = normalizeTimeHHMM(course?.schedule_start_time);
  if (!startStr) return { state: 'none', startLabel: '', endLabel: '' };
  const days = Array.isArray(course.schedule_days) ? course.schedule_days : [];
  const todayId = DAY_IDS[now.getDay()];
  if (days.length > 0 && !days.includes(todayId)) {
    return {
      state: 'other_day',
      startLabel: startStr,
      endLabel: normalizeTimeHHMM(course?.schedule_end_time),
    };
  }

  const startMin = toMinutes(startStr);
  const endStr = normalizeTimeHHMM(course?.schedule_end_time);
  const endMin = toMinutes(endStr) ?? (startMin + 90);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const notifyBefore = Number(course?.notify_before_minutes ?? 15);

  if (nowMin >= startMin && nowMin <= endMin) {
    return {
      state: 'live',
      minutesRemaining: Math.max(0, endMin - nowMin),
      minutesElapsed: Math.max(0, nowMin - startMin),
      startLabel: startStr,
      endLabel: endStr || '',
    };
  }
  const diffToStart = startMin - nowMin;
  if (diffToStart > 0 && diffToStart <= Math.max(notifyBefore, 30)) {
    return {
      state: 'soon',
      minutesToStart: diffToStart,
      notifyWindow: diffToStart <= notifyBefore,
      startLabel: startStr,
      endLabel: endStr || '',
    };
  }
  return {
    state: diffToStart > 0 ? 'upcoming_today' : 'ended_today',
    minutesToStart: diffToStart,
    startLabel: startStr,
    endLabel: endStr || '',
  };
}

export function formatCourseScheduleBadge(course) {
  const start = normalizeTimeHHMM(course?.schedule_start_time);
  const end = normalizeTimeHHMM(course?.schedule_end_time);
  if (!start) return '';
  return end ? `${start} - ${end}` : start;
}

/* ------------------------------------------------------------------
   Permissions PWA & Affichage Notification Système (Offline OK!)
   ------------------------------------------------------------------ */
export function getNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestPushPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission || 'default';
  }
}

async function dispatchOsNotification({ title, body, tag, link }) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const targetUrl = link ? appUrl(link.replace(/^\.?\//, '')) : appUrl('pages/dashboard.html');
  const iconUrl = appUrl('assets/icons/icon-192.png');
  const opts = {
    body: body || '',
    icon: iconUrl,
    badge: appUrl('assets/icons/icon-nav.png'),
    vibrate: [180, 80, 220],
    tag: tag || `prannot-${Date.now()}`,
    renotify: true,
    data: { link: targetUrl },
  };
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(title, opts);
        return true;
      }
    }
  } catch { /* fallback below */ }
  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      location.href = targetUrl;
    };
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------
   Historique & Centre de notifications (Local IndexedDB + Supabase)
   ------------------------------------------------------------------ */
function getFiredMap() {
  try { return JSON.parse(localStorage.getItem(FIRED_KEY) || '{}') || {}; } catch { return {}; }
}

function wasFired(key) {
  return Boolean(getFiredMap()[key]);
}

function markFired(key) {
  try {
    const map = getFiredMap();
    map[key] = Date.now();
    // Nettoyage des clés de plus de 14 jours
    const cutoff = Date.now() - 14 * 86400000;
    for (const k of Object.keys(map)) {
      if (map[k] < cutoff) delete map[k];
    }
    localStorage.setItem(FIRED_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

async function getLocalNotifications() {
  return (await cacheGet(LOCAL_NOTIFS_CACHE_KEY)) || [];
}

async function saveLocalNotification(entry) {
  const list = await getLocalNotifications();
  const deduped = [entry, ...list.filter((x) => x.id !== entry.id)].slice(0, 40);
  await cacheSet(LOCAL_NOTIFS_CACHE_KEY, deduped);
  return deduped;
}

export async function getAllNotifications() {
  const [localList, remoteList] = await Promise.all([
    getLocalNotifications(),
    cacheGet(REMOTE_NOTIFS_CACHE_KEY),
  ]);
  const combined = [...(localList || []), ...(remoteList || [])];
  const seen = new Set();
  return combined
    .filter((item) => {
      if (!item?.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 40);
}

export async function updateBellBadges() {
  const all = await getAllNotifications();
  const unread = all.filter((x) => !x.read_at).length;
  ['nav-notif-badge', 'mob-notif-badge'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (unread > 0) {
      el.hidden = false;
      el.textContent = unread > 99 ? '99+' : String(unread);
    } else {
      el.hidden = true;
    }
  });
}

export async function markAllNotificationsRead() {
  const nowIso = new Date().toISOString();
  const [localList, remoteList] = await Promise.all([
    getLocalNotifications(),
    cacheGet(REMOTE_NOTIFS_CACHE_KEY),
  ]);
  await Promise.all([
    cacheSet(LOCAL_NOTIFS_CACHE_KEY, (localList || []).map((x) => ({ ...x, read_at: x.read_at || nowIso }))),
    cacheSet(REMOTE_NOTIFS_CACHE_KEY, (remoteList || []).map((x) => ({ ...x, read_at: x.read_at || nowIso }))),
  ]);
  if (navigator.onLine && window.db && cachedUserRef?.id) {
    try {
      await window.db
        .from('pran_not_notifications')
        .update({ read_at: nowIso })
        .eq('user_id', cachedUserRef.id)
        .is('read_at', null);
    } catch { /* ignore */ }
  }
  await updateBellBadges();
}

export async function triggerAppNotification({
  id = `loc_${Date.now()}`,
  kind = 'info',
  soundKind = 'chime',
  title,
  body = '',
  link = 'pages/dashboard.html',
  toastType = 'info',
  silentToast = false,
  playSound = true,
  osNotify = true,
  whatsappCourse = null,
}) {
  const entry = {
    id,
    kind,
    title,
    body,
    link,
    read_at: null,
    created_at: new Date().toISOString(),
    is_local: true,
  };
  await saveLocalNotification(entry);
  await updateBellBadges();

  if (playSound) {
    playNotificationSound(soundKind);
  }
  if (osNotify) {
    dispatchOsNotification({ title, body, tag: id, link }).catch(() => {});
  }
  if (!silentToast) {
    toast(body ? `${title} — ${body}` : title, toastType, {
      duration: 6500,
      action: link ? {
        label: t('common.open'),
        onClick: () => { location.href = appUrl(link.replace(/^\.?\//, '')); },
      } : null,
    });
  }

  if (whatsappCourse && navigator.onLine) {
    triggerWhatsAppClassAlert(whatsappCourse).catch(() => {});
  }
}

/* ------------------------------------------------------------------
   Envoi WhatsApp temps réel (Fast Lane quand le cours commence/approche)
   ------------------------------------------------------------------ */
export async function triggerWhatsAppClassAlert(course, { manual = false } = {}) {
  if (!navigator.onLine || !window.db) {
    if (manual) toast(t('errors.offline'), 'warning');
    return { sent: false, reason: 'offline' };
  }
  if (!manual && cachedProfileRef?.notify_whatsapp === false) {
    return { sent: false, reason: 'opted_out' };
  }
  const phone = cachedProfileRef?.whatsapp_phone;
  if (!phone) {
    if (manual) toast(t('notifications.wa_missing_phone'), 'warning');
    return { sent: false, reason: 'no_phone' };
  }
  const { data: sessionData } = await window.db.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return { sent: false, reason: 'no_session' };

  const startStr = normalizeTimeHHMM(course?.schedule_start_time) || new Date().toTimeString().slice(0, 5);
  const res = await fetch(`${FUNCTIONS_URL}/whatsapp-gateway`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      action: 'notify_class_start',
      course_id: course?.id || null,
      course_name: course?.name || 'Kou',
      start_time: startStr,
      app_url: location.origin,
      manual,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.message || json?.error || 'wa_error');
  }
  return json;
}

/* ------------------------------------------------------------------
   Bannière persistante "Cours en direct" dans l'app
   ------------------------------------------------------------------ */
function renderLiveClassBanner(liveCourse, status) {
  // Ne pas dupliquer sur la page live-class.html elle-même
  if (location.pathname.toLowerCase().includes('live-class.html')) {
    document.getElementById('live-class-banner')?.remove();
    return;
  }
  if (!liveCourse || (status.state !== 'live' && status.state !== 'soon')) {
    document.getElementById('live-class-banner')?.remove();
    return;
  }

  let banner = document.getElementById('live-class-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'live-class-banner';
    banner.className = 'live-class-banner';
    const main = document.querySelector('main');
    if (main) main.prepend(banner);
    else document.body.prepend(banner);
  }

  const isLive = status.state === 'live';
  const titleText = isLive
    ? t('notifications.banner_live_title', { course: liveCourse.name })
    : t('notifications.banner_soon_title', { course: liveCourse.name, min: status.minutesToStart });
  const subText = isLive
    ? t('notifications.banner_live_sub', { time: formatCourseScheduleBadge(liveCourse) })
    : t('notifications.banner_soon_sub', { time: status.startLabel });

  banner.innerHTML = `
    <div class="live-class-banner-left">
      <span class="live-pulse-dot" aria-hidden="true"></span>
      <div>
        <strong class="text-sm">${esc(titleText)}</strong>
        <div class="text-xs muted">${esc(subText)}</div>
      </div>
    </div>
    <a class="btn btn-sm btn-primary" href="${esc(appUrl(`pages/live-class.html?course=${encodeURIComponent(liveCourse.id)}`))}">
      ${icon('radio')}
      <span>${esc(t('live.enter_btn'))}</span>
    </a>`;
  icons(banner);
}

/* ------------------------------------------------------------------
   Moniteur périodique (hors-ligne & en ligne)
   ------------------------------------------------------------------ */
async function evaluateSchedulesAndReminders() {
  if (!isClassNotifyEnabled()) {
    document.getElementById('live-class-banner')?.remove();
  }
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const [rawCourses, rawAssignments, stats, dueCards] = await Promise.all([
    cacheGet('courses_list'),
    cacheGet('assignments_list'),
    cacheGet('dashboard_stats'),
    cacheGet('due_cards'),
  ]);

  const courses = mergeCourseSchedules(rawCourses || []);
  let activeLive = null;
  let activeStatus = null;

  for (const c of courses) {
    const st = getCourseLiveStatus(c, now);
    if (st.state === 'live' && (!activeLive || activeStatus?.state !== 'live')) {
      activeLive = c;
      activeStatus = st;
    } else if (st.state === 'soon' && !activeLive) {
      activeLive = c;
      activeStatus = st;
    }

    if (!isClassNotifyEnabled()) continue;

    if (st.state === 'soon' && st.notifyWindow) {
      const fKey = `class_soon:${c.id}:${todayStr}`;
      if (!wasFired(fKey)) {
        markFired(fKey);
        await triggerAppNotification({
          id: fKey,
          kind: 'reminder',
          soundKind: 'live_class',
          title: t('notifications.class_soon_title', { course: c.name }),
          body: t('notifications.class_soon_body', { min: st.minutesToStart, time: st.startLabel }),
          link: `pages/live-class.html?course=${encodeURIComponent(c.id)}`,
          toastType: 'info',
          whatsappCourse: c,
        });
      }
    }

    if (st.state === 'live') {
      const fKey = `class_live:${c.id}:${todayStr}`;
      if (!wasFired(fKey)) {
        markFired(fKey);
        await triggerAppNotification({
          id: fKey,
          kind: 'reminder',
          soundKind: 'live_class',
          title: t('notifications.class_started_title', { course: c.name }),
          body: t('notifications.class_started_body'),
          link: `pages/live-class.html?course=${encodeURIComponent(c.id)}`,
          toastType: 'success',
          whatsappCourse: c,
        });
      }
    }
  }

  if (isClassNotifyEnabled()) {
    renderLiveClassBanner(activeLive, activeStatus || { state: 'none' });
  }

  // Échéances devoirs (fonctionne 100 % hors-ligne sur le cache)
  for (const a of rawAssignments || []) {
    if (!a?.due_at || a.status === 'done' || a.status === 'submitted') continue;
    const diffMs = new Date(a.due_at).getTime() - now.getTime();
    if (diffMs < 0) continue;
    const diffDays = Math.ceil(diffMs / 86400000);
    let tag = '';
    if (diffDays <= 1) tag = 'J1';
    else if (diffDays <= 3) tag = 'J3';
    else if (diffDays <= 7) tag = 'J7';
    if (!tag) continue;

    const dKey = `deadline:${a.id}:${tag}:${todayStr}`;
    if (!wasFired(dKey)) {
      markFired(dKey);
      await triggerAppNotification({
        id: dKey,
        kind: 'deadline',
        soundKind: 'deadline',
        title: t('notifications.deadline_title', { title: a.title }),
        body: t('notifications.deadline_body', { when: formatRelative(a.due_at) }),
        link: `pages/assignment.html?id=${encodeURIComponent(a.id)}`,
        toastType: 'warning',
      });
    }
  }

  // Rappel quotidien à l'heure choisie par l'étudiant (flashcards dues)
  const remTime = normalizeTimeHHMM(cachedProfileRef?.reminder_time || '');
  const dueCount = Number(stats?.due_cards ?? (Array.isArray(dueCards) ? dueCards.length : 0));
  if (remTime && dueCount > 0) {
    const remMin = toMinutes(remTime);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin >= remMin && nowMin - remMin <= 60) {
      const rKey = `daily_review:${todayStr}`;
      if (!wasFired(rKey)) {
        markFired(rKey);
        await triggerAppNotification({
          id: rKey,
          kind: 'reminder',
          soundKind: 'chime',
          title: t('notifications.daily_review_title'),
          body: t('notifications.daily_review_body', { count: dueCount }),
          link: 'pages/review.html',
          toastType: 'info',
        });
      }
    }
  }
}

async function pullRemoteNotifications() {
  if (!navigator.onLine || !window.db || !cachedUserRef?.id) return;
  try {
    const { data } = await window.db
      .from('pran_not_notifications')
      .select('id, kind, title, body, link, read_at, created_at')
      .eq('user_id', cachedUserRef.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (data) {
      await cacheSet(REMOTE_NOTIFS_CACHE_KEY, data);
      await updateBellBadges();
    }
  } catch { /* silent */ }
}

/**
 * Démarre le moniteur global de notifications + son sur chaque page de l'app.
 */
export async function startNotificationMonitor({ profile = null, user = null } = {}) {
  cachedProfileRef = profile;
  cachedUserRef = user;

  if (profile && typeof profile.notify_sound === 'boolean' && localStorage.getItem(SOUND_KEY) === null) {
    setSoundEnabled(profile.notify_sound);
  }
  if (profile && typeof profile.notify_classes === 'boolean' && localStorage.getItem(CLASSES_NOTIFY_KEY) === null) {
    setClassNotifyEnabled(profile.notify_classes);
  }

  await updateBellBadges();
  await evaluateSchedulesAndReminders();
  if (navigator.onLine) {
    pullRemoteNotifications();
  }

  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(() => {
    evaluateSchedulesAndReminders().catch(() => {});
  }, 25000);
}

/* ------------------------------------------------------------------
   Modale Centre de Notifications (cloche dans la navbar)
   ------------------------------------------------------------------ */
export async function openNotificationsModal() {
  const perm = getNotificationPermission();
  const soundOn = isSoundEnabled();
  const all = await getAllNotifications();

  const kindIcon = (k) => ({
    reminder: 'radio',
    deadline: 'clock',
    streak: 'flame',
    badge: 'award',
    announcement: 'megaphone',
    ai: 'sparkles',
  }[k] || 'bell');

  const m = openModal({
    title: t('notifications.center_title'),
    size: 'lg',
    body: `
      <div class="card card-sm card-muted mb-4">
        <div class="row-between" style="flex-wrap:wrap;gap:10px;">
          <div class="row-wrap">
            <label class="switch" style="min-height:36px;">
              <input type="checkbox" id="notif-sound-toggle" ${soundOn ? 'checked' : ''}>
              <span class="switch-track"></span>
              <span class="text-sm">${esc(t('notifications.sound_label'))}</span>
            </label>
          </div>
          <div class="row-wrap">
            ${perm === 'default' ? `
              <button type="button" class="btn btn-sm btn-primary" id="notif-enable-os-btn">
                ${icon('bell-ring')}<span>${esc(t('notifications.enable_os_btn'))}</span>
              </button>` : `
              <span class="badge ${perm === 'granted' ? 'badge-success' : 'badge-warning'}">
                ${esc(perm === 'granted' ? t('notifications.os_active') : t('notifications.os_blocked'))}
              </span>`}
            <button type="button" class="btn btn-sm btn-secondary" id="notif-test-sound-btn">
              ${icon('volume-2')}<span>${esc(t('notifications.test_btn'))}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="row-between mb-3">
        <span class="text-xs muted">${esc(t('notifications.offline_ready_hint'))}</span>
        ${all.some((x) => !x.read_at) ? `<button type="button" class="btn btn-sm btn-ghost" id="notif-mark-all-btn">${icon('check-check')}<span>${esc(t('notifications.mark_all_read'))}</span></button>` : ''}
      </div>

      <div id="notif-list-box">
        ${all.length ? `<ul class="list">${all.map((n) => `
          <li class="list-item ${n.read_at ? '' : 'notif-unread'}">
            <span class="icon-chip sm ${n.kind === 'deadline' ? 'error' : 'accent'}">${icon(kindIcon(n.kind))}</span>
            <div class="flex-1">
              <div class="list-item-title">${esc(n.title)}</div>
              ${n.body ? `<div class="list-item-sub">${esc(n.body)}</div>` : ''}
              <div class="text-xs muted mt-1">${esc(formatRelative(n.created_at))}</div>
            </div>
            ${n.link ? `<a class="btn btn-sm btn-secondary" href="${esc(appUrl(n.link.replace(/^\.?\//, '')))}">${esc(t('common.open'))}</a>` : ''}
          </li>`).join('')}</ul>`
          : `<p class="text-sm muted text-center py-6">${esc(t('notifications.empty'))}</p>`}
      </div>`,
  });

  icons(m.el);

  m.el.querySelector('#notif-sound-toggle')?.addEventListener('change', (e) => {
    setSoundEnabled(e.target.checked);
    if (e.target.checked) playNotificationSound('success', { force: true });
  });

  m.el.querySelector('#notif-enable-os-btn')?.addEventListener('click', async (e) => {
    const res = await requestPushPermission();
    toast(res === 'granted' ? t('notifications.os_active') : t('notifications.os_blocked'), res === 'granted' ? 'success' : 'warning');
    e.target.closest('button').hidden = true;
  });

  m.el.querySelector('#notif-test-sound-btn')?.addEventListener('click', async () => {
    if (Notification?.permission === 'default') {
      await requestPushPermission();
    }
    await triggerAppNotification({
      id: `test_${Date.now()}`,
      kind: 'reminder',
      soundKind: 'live_class',
      title: t('notifications.test_title'),
      body: t('notifications.test_body'),
      link: 'pages/live-class.html',
      toastType: 'success',
      playSound: true,
      osNotify: true,
    });
  });

  m.el.querySelector('#notif-mark-all-btn')?.addEventListener('click', async () => {
    await markAllNotificationsRead();
    m.el.querySelectorAll('.notif-unread').forEach((el) => el.classList.remove('notif-unread'));
    m.el.querySelector('#notif-mark-all-btn')?.remove();
  });
}
