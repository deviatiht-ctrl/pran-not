/* =====================================================================
   PRAN NÒT - offline.js
   File d'attente hors-ligne (IndexedDB) + cache local léger.
   Synchronisation automatique au retour de la connexion.
   ===================================================================== */
import { t } from './i18n.js';
import { toast, icons, icon, uid } from './utils.js';
import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from './supabase.js';

const DB_NAME = 'prannot_offline_v1';
const DB_VERSION = 1;
const STORE_QUEUE = 'queue';
const STORE_CACHE = 'cache';

let idbPromise = null;
let flushing = false;
const listeners = new Set();

function openDb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        const s = db.createObjectStore(STORE_QUEUE, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const txx = db.transaction(storeName, mode);
    const store = txx.objectStore(storeName);
    const req = fn(store);
    txx.oncomplete = () => resolve(req?.result);
    txx.onerror = () => reject(txx.error);
  });
}

export function isDataSaver() {
  return document.body.classList.contains('data-saver') || localStorage.getItem('prannot.dataSaver') === '1';
}

export function isNetworkError(err) {
  if (!navigator.onLine) return true;
  if (!err) return false;
  const msg = String(err?.message || err || '');
  return err?.name === 'TypeError'
    || /failed to fetch|networkerror|load failed|network request failed|internet|offline|timeout|aborted/i.test(msg);
}

/** Stocke une donnée en cache local pour lecture hors-ligne. */
export async function cacheSet(key, data) {
  try {
    await tx(STORE_CACHE, 'readwrite', (s) => s.put({ key, data, updatedAt: Date.now() }));
  } catch (e) {
    console.warn('[offline] cacheSet', e);
  }
}

/** Lit une donnée du cache local. */
export async function cacheGet(key) {
  try {
    const row = await tx(STORE_CACHE, 'readonly', (s) => s.get(key));
    return row?.data ?? null;
  } catch {
    return null;
  }
}

/** Lit toutes les entrées du cache dont la clé commence par un préfixe. */
export async function cacheEntriesByPrefix(prefix) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const txx = db.transaction(STORE_CACHE, 'readonly');
      const req = txx.objectStore(STORE_CACHE).getAll();
      req.onsuccess = () => {
        const rows = (req.result || []).filter((r) => String(r.key || '').startsWith(prefix));
        resolve(rows);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/** Ajoute une action dans la file hors-ligne. */
export async function enqueue(kind, payload) {
  const item = {
    id: uid(),
    kind,
    payload,
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
  await tx(STORE_QUEUE, 'readwrite', (s) => s.put(item));
  notifyQueueChange();

  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('prannot-sync');
    } catch { /* fallback sur l'événement online */ }
  }
  return item;
}

export async function getQueueItems() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const txx = db.transaction(STORE_QUEUE, 'readonly');
      const req = txx.objectStore(STORE_QUEUE).getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.createdAt - b.createdAt));
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function getQueueCount() {
  const items = await getQueueItems();
  return items.length;
}

async function removeQueueItem(id) {
  await tx(STORE_QUEUE, 'readwrite', (s) => s.delete(id));
  notifyQueueChange();
}

async function updateQueueItem(item) {
  await tx(STORE_QUEUE, 'readwrite', (s) => s.put(item));
}

export function onQueueChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function notifyQueueChange() {
  const count = await getQueueCount();
  updateBanner(count);
  listeners.forEach((fn) => {
    try { fn(count); } catch (e) { console.error(e); }
  });
}

function updateBanner(pending = 0) {
  let banner = document.getElementById('offline-banner');
  const offline = !navigator.onLine;
  if (!offline && pending === 0) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.className = 'offline-banner';
    banner.setAttribute('role', 'status');
    document.body.appendChild(banner);
  }
  if (offline) {
    banner.innerHTML = `${icon('wifi-off')}<span>${t('offline.banner_offline', { count: pending })}</span>`;
  } else if (pending > 0) {
    banner.innerHTML = `${icon('refresh-cw')}<span>${t('offline.banner_syncing', { count: pending })}</span>`;
  }
  icons(banner);
}

function mimeToExt(mime = '') {
  const clean = String(mime || '').toLowerCase();
  if (clean.includes('mp4')) return 'mp4';
  if (clean.includes('m4a')) return 'm4a';
  if (clean.includes('aac')) return 'aac';
  if (clean.includes('mpeg') || clean.includes('mp3')) return 'mp3';
  if (clean.includes('ogg') || clean.includes('opus')) return 'ogg';
  if (clean.includes('wav')) return 'wav';
  if (clean.includes('flac')) return 'flac';
  if (clean.includes('png')) return 'png';
  if (clean.includes('webp')) return 'webp';
  return clean.startsWith('image/') ? 'jpg' : 'webm';
}

/** Synchronise un élément de note hors-ligne. */
async function syncNoteItem(db, userId, payload) {
  const clientId = payload.client_id || uid();
  const noteRow = {
    user_id: userId,
    client_id: clientId,
    course_id: payload.course_id || null,
    unit_id: payload.unit_id || null,
    title: payload.title || t('notes.untitled'),
    content_html: payload.content_html || '',
    content_text: payload.content_text || '',
    raw_text: payload.raw_text || null,
    language: payload.language || 'mix',
    capture_mode: payload.capture_mode || 'text',
    status: payload.process_ai ? 'queued' : (payload.status || 'ready'),
  };

  const { data: savedNote, error } = await db
    .from('pran_not_notes')
    .upsert(noteRow, { onConflict: 'user_id,client_id' })
    .select()
    .single();
  if (error) throw error;

  // Upload des sources binaires (images/audio) si présentes
  const files = payload.files || [];
  let collectedRaw = noteRow.raw_text || noteRow.content_text || '';
  const sessionRes = await db.auth.getSession();
  const token = sessionRes?.data?.session?.access_token;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f?.blob) continue;
    const ext = f.ext || mimeToExt(f.mime) || (f.kind === 'audio' ? 'webm' : 'jpg');
    const bucket = f.kind === 'audio' ? 'pran-not-note-audio' : f.kind === 'pdf' ? 'pran-not-syllabi' : 'pran-not-note-images';
    const path = `${userId}/${savedNote.id}/${Date.now()}-${i}.${ext}`;
    const rawMime = f.mime || (f.kind === 'audio' ? 'audio/webm' : 'image/jpeg');
    const cleanMime = rawMime.split(';')[0].trim() || rawMime;
    const uploadBlob = new Blob([f.blob], { type: cleanMime });
    const { error: upErr } = await db.storage.from(bucket).upload(path, uploadBlob, {
      contentType: cleanMime,
      upsert: true,
    });
    if (upErr) throw upErr;

    await db.from('pran_not_note_sources').insert({
      user_id: userId,
      note_id: savedNote.id,
      kind: f.kind,
      storage_path: path,
      mime: cleanMime,
      size_bytes: f.blob.size,
      chunk_index: i,
      status: 'uploaded',
    });

    // Traitement IA différé si demandé et hors mode économie de données
    if (payload.process_ai && token && !isDataSaver()) {
      try {
        if (f.kind === 'image') {
          const b64 = await blobToB64(f.blob);
          const res = await fetch(`${FUNCTIONS_URL}/ocr-board`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              apikey: SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ imagesBase64: [b64], language: noteRow.language, noteId: savedNote.id }),
          });
          if (res.ok) {
            const j = await res.json();
            if (j?.text) collectedRaw = `${collectedRaw}\n\n${j.text}`.trim();
          }
        } else if (f.kind === 'audio') {
          const b64 = await blobToB64(f.blob);
          const res = await fetch(`${FUNCTIONS_URL}/transcribe`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              apikey: SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({
              audioBase64: b64,
              mimeType: f.mime || 'audio/webm',
              language: noteRow.language,
              noteId: savedNote.id,
              chunkIndex: i,
              mode: 'detailed',
              previousContext: collectedRaw.slice(-260),
            }),
          });
          if (res.ok) {
            const j = await res.json();
            if (j?.text) collectedRaw = `${collectedRaw}\n\n${j.text}`.trim();
          }
        }
      } catch (aiErr) {
        console.warn('[offline] Traitement IA différé reporté', aiErr);
      }
    }
  }

  if (payload.process_ai && collectedRaw && token && !isDataSaver()) {
    try {
      await fetch(`${FUNCTIONS_URL}/process-note`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ rawText: collectedRaw, language: noteRow.language, noteId: savedNote.id }),
      });
    } catch (e) {
      console.warn('[offline] process-note différé', e);
    }
  }
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** Synchronise une révision de flashcard hors-ligne. */
async function syncReviewItem(db, userId, payload) {
  const { cardId, srsPatch, rating, durationMs, clientId } = payload;
  const { error: uErr } = await db
    .from('pran_not_flashcards')
    .update(srsPatch)
    .eq('id', cardId)
    .eq('user_id', userId);
  if (uErr) throw uErr;

  const { error: rErr } = await db
    .from('pran_not_card_reviews')
    .upsert({
      user_id: userId,
      card_id: cardId,
      rating,
      prev_interval: payload.prevInterval ?? 0,
      new_interval: srsPatch.interval_days,
      new_ease: srsPatch.ease,
      duration_ms: durationMs || null,
      client_id: clientId || uid(),
    }, { onConflict: 'user_id,client_id' });
  if (rErr) throw rErr;
}

/** Synchronise une session d'étude hors-ligne. */
async function syncSessionItem(db, userId, payload) {
  const { error } = await db.from('pran_not_study_sessions').upsert({
    user_id: userId,
    course_id: payload.course_id || null,
    kind: payload.kind || 'pomodoro',
    started_at: payload.started_at || new Date().toISOString(),
    ended_at: payload.ended_at || new Date().toISOString(),
    duration_minutes: payload.duration_minutes || 0,
    client_id: payload.client_id || uid(),
  }, { onConflict: 'user_id,client_id' });
  if (error) throw error;
}

/** Synchronise la modification d'une note existante hors-ligne. */
async function syncNoteUpdateItem(db, userId, payload) {
  if (!payload?.note_id) return;
  const patch = {
    title: payload.title,
    summary: payload.summary,
    content_text: payload.content_text,
    content_html: payload.content_html,
  };
  const { error } = await db
    .from('pran_not_notes')
    .update(patch)
    .eq('id', payload.note_id)
    .eq('user_id', userId);
  if (error) throw error;
}

/** Synchronise la modification d'un devoir hors-ligne. */
async function syncAssignmentUpdateItem(db, userId, payload) {
  if (!payload?.assignment_id) return;
  const { error } = await db
    .from('pran_not_assignments')
    .update(payload.patch || {})
    .eq('id', payload.assignment_id)
    .eq('user_id', userId);
  if (error) throw error;
}

/** Vide la file d'attente hors-ligne dès que la connexion est active. */
export async function flushQueue({ silent = false } = {}) {
  if (flushing || !navigator.onLine || !window.db) return 0;
  const items = await getQueueItems();
  if (!items.length) {
    updateBanner(0);
    return 0;
  }

  const { data } = await window.db.auth.getSession();
  const userId = data?.session?.user?.id;
  if (!userId) return 0;

  flushing = true;
  let synced = 0;
  updateBanner(items.length);

  try {
    for (const item of items) {
      if (!navigator.onLine) break;
      try {
        if (item.kind === 'note') await syncNoteItem(window.db, userId, item.payload);
        else if (item.kind === 'note_update') await syncNoteUpdateItem(window.db, userId, item.payload);
        else if (item.kind === 'assignment_update') await syncAssignmentUpdateItem(window.db, userId, item.payload);
        else if (item.kind === 'review') await syncReviewItem(window.db, userId, item.payload);
        else if (item.kind === 'session') await syncSessionItem(window.db, userId, item.payload);
        await removeQueueItem(item.id);
        synced++;
      } catch (err) {
        console.warn('[offline] Échec sync élément', item.id, err);
        item.attempts = (item.attempts || 0) + 1;
        item.lastError = err?.message || 'sync_error';
        if (item.attempts >= 6) {
          // Éviter de bloquer indéfiniment la file si une erreur est permanente
          await removeQueueItem(item.id);
        } else {
          await updateQueueItem(item);
        }
      }
    }
    if (synced > 0) {
      try { await window.db.rpc('pran_not_record_activity'); } catch { /* ignore */ }
      if (!silent) toast(t('offline.synced', { count: synced }), 'success');
    }
  } finally {
    flushing = false;
    await notifyQueueChange();
  }
  return synced;
}

/** Initialise l'écoute réseau et la synchronisation automatique. */
export function initOffline() {
  getQueueCount().then(updateBanner);

  window.addEventListener('online', () => {
    toast(t('offline.back_online'), 'info');
    flushQueue();
  });
  window.addEventListener('offline', () => {
    getQueueCount().then(updateBanner);
  });

  if ('serviceWorker' in navigator) {
    const swUrl = new URL('../../sw.js', import.meta.url).href;
    navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' })
      .then((reg) => reg.update().catch(() => {}))
      .catch((e) => console.warn('[sw]', e));
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'SYNC_QUEUE') flushQueue({ silent: true });
    });
  }

  if (navigator.onLine) {
    setTimeout(() => flushQueue({ silent: true }), 1500);
  }
}
