/* =====================================================================
   PRAN NÒT - pages/live-class.js
   Mode "Kou an dirèk" (Live Class) :
   - Ouverture directe quand un cours commence ou sur choix de l'étudiant
   - Étapes guidées : objectif chapitre -> audio + prise de notes ->
     mots-clés horodatés -> recherche rapide (Bibliothèque, Notes, IA/Web) ->
     sauvegarde structurée ou hors-ligne prête pour étude après cours
   ===================================================================== */
import '../supabase.js';
import { requireAuth, recordActivity, awardXp, appUrl } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, getLang } from '../i18n.js';
import {
  icons, icon, esc, toast, handleError, setLoading, getParam, uid,
  blobToBase64, formatDuration, renderMarkdown, pageEnter,
} from '../utils.js';
import { transcribeAudio, processNote, askTutor, searchLibraryWeb } from '../ai.js';
import { cacheGet, cacheSet, enqueue, isDataSaver, isNetworkError } from '../offline.js';
import {
  mergeCourseSchedules, getCourseLiveStatus, formatCourseScheduleBadge,
  triggerWhatsAppClassAlert, playNotificationSound,
} from '../notifications.js';
import {
  openSendTransferModal, openReceiveTransferModal, openExamRevisionModal,
} from '../live-transfer.js';

const db = window.db;
const DRAFT_KEY = 'prannot.liveClassDraft';
const SEGMENT_SECONDS = 45;

let userRef = null;
let profileRef = null;
let courses = [];
let units = [];
let selectedCourseId = '';
let selectedUnitId = '';
let searchTab = 'library';
let sessionStartedAt = new Date().toISOString();
let homeworkList = []; // { id, title, due, description }
let lastAutoSaveTime = 0;

// Chrono session & audio
let classElapsedSec = 0;
let classTimerId = null;
const keywordsLog = []; // { term, tag, stamp }
const audioChunks = []; // { id, blob, mime, duration, status, transcript, liveDraft }

let isRecording = false;
let rawStream = null;
let recStream = null;
let audioCtx = null;
let analyserNode = null;
let zeroSink = null;
let mediaRecorder = null;
let speechRec = null;
let liveSpeechBuffer = '';
let recTotalSec = 0;
let segElapsedSec = 0;
let recTimerId = null;
let meterRafId = null;
let transcribeQueue = Promise.resolve();
let onStopHardwareCleanup = null;
let wakeLockRef = null;

function setStepDone(stepNum, done = true) {
  const pill = document.querySelector(`.live-step-pill[data-step="${stepNum}"]`);
  if (pill && done) pill.classList.add('is-done');
}

function setStepActive(stepNum) {
  document.querySelectorAll('.live-step-pill').forEach((p) => {
    p.classList.toggle('is-active', Number(p.dataset.step) === stepNum);
  });
}

function formatStamp() {
  return `[${formatDuration(recTotalSec > 0 ? recTotalSec : classElapsedSec)}]`;
}

function saveDraft({ showBadge = true } = {}) {
  try {
    const title = document.getElementById('live-note-title')?.value || '';
    const body = document.getElementById('live-notes-area')?.value || '';
    const thoughts = document.getElementById('live-thoughts-area')?.value || '';
    const payload = {
      courseId: selectedCourseId,
      unitId: selectedUnitId,
      title,
      body,
      thoughts,
      homework: homeworkList,
      keywords: keywordsLog,
      savedAt: Date.now(),
      classElapsedSec,
      recTotalSec,
      sessionStartedAt,
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
    lastAutoSaveTime = Date.now();

    if (showBadge) {
      const badgeText = document.getElementById('live-autosave-text');
      if (badgeText) {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        badgeText.textContent = `Sove ${hh}:${mm}:${ss}`;
      }
    }
  } catch { /* ignore */ }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

function renderHomeworkList() {
  const box = document.getElementById('live-hw-list');
  const countBadge = document.getElementById('live-hw-count');
  if (countBadge) countBadge.textContent = `${homeworkList.length} devwa`;
  if (!box) return;
  if (!homeworkList.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = homeworkList.map((hw, idx) => `
    <div class="card card-sm card-muted row-between">
      <div class="flex-1">
        <div class="text-sm font-bold">${esc(hw.title)}</div>
        ${hw.due ? `<div class="text-xs text-warning">Dat limit : ${esc(hw.due)}</div>` : ''}
        ${hw.description ? `<div class="text-xs muted">${esc(hw.description)}</div>` : ''}
      </div>
      <button type="button" class="btn btn-ghost btn-xs text-error live-hw-del-btn" data-hw-idx="${idx}" aria-label="Supprimer">
        ${icon('trash-2')}
      </button>
    </div>
  `).join('');
  icons(box);
  box.querySelectorAll('.live-hw-del-btn').forEach((b) => {
    b.addEventListener('click', (e) => {
      const i = Number(e.currentTarget.dataset.hwIdx);
      homeworkList.splice(i, 1);
      renderHomeworkList();
      saveDraft();
    });
  });
}

function restoreDraft(targetCourseId) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d || Date.now() - Number(d.savedAt || 0) > 18 * 3600 * 1000) return;
    if (targetCourseId && d.courseId && d.courseId !== targetCourseId) return;
    if (d.title && document.getElementById('live-note-title')) document.getElementById('live-note-title').value = d.title;
    if (d.body && document.getElementById('live-notes-area')) document.getElementById('live-notes-area').value = d.body;
    if (d.thoughts && document.getElementById('live-thoughts-area')) document.getElementById('live-thoughts-area').value = d.thoughts;
    if (Array.isArray(d.homework)) {
      homeworkList.splice(0, homeworkList.length, ...d.homework);
      renderHomeworkList();
    }
    if (Array.isArray(d.keywords)) {
      keywordsLog.splice(0, keywordsLog.length, ...d.keywords);
      renderKeywords();
    }
    if (d.sessionStartedAt) sessionStartedAt = d.sessionStartedAt;
  } catch { /* ignore */ }
}

function updateHeaderStatus() {
  const c = courses.find((x) => x.id === selectedCourseId);
  const pillText = document.getElementById('live-status-text');
  const schedBadge = document.getElementById('live-schedule-badge');
  const heading = document.getElementById('live-heading');

  if (c) {
    heading.textContent = c.name;
    const st = getCourseLiveStatus(c);
    const sched = formatCourseScheduleBadge(c);
    if (sched) {
      schedBadge.hidden = false;
      schedBadge.textContent = sched;
    } else {
      schedBadge.hidden = true;
    }
    if (st.state === 'live') {
      pillText.textContent = t('live.started_banner');
    } else if (st.state === 'soon') {
      pillText.textContent = t('live.badge_soon', { min: st.minutesToStart });
    } else {
      pillText.textContent = t('live.badge_live');
    }

    const titleEl = document.getElementById('live-note-title');
    if (titleEl && !titleEl.value.trim()) {
      const todayLabel = new Date().toLocaleDateString();
      titleEl.placeholder = `${c.name} — ${todayLabel}`;
    }

    setTutorContext({
      contextType: 'course',
      contextId: c.id,
      contextTitle: `${t('live.title')}: ${c.name}`,
      contextText: document.getElementById('live-notes-area')?.value || c.name,
      courseId: c.id,
    });
  } else {
    heading.textContent = t('live.title');
    pillText.textContent = t('live.badge_live');
    schedBadge.hidden = true;
  }
}

async function loadUnitsForCourse(courseId) {
  selectedCourseId = courseId || '';
  const unitSel = document.getElementById('live-unit-select');
  unitSel.innerHTML = `<option value="">${esc(t('common.none'))}</option>`;
  units = [];
  selectedUnitId = '';

  if (courseId) {
    setStepDone(1, true);
    const cachedDetail = await cacheGet(`course_detail_${courseId}`);
    if (cachedDetail?.units?.length) units = cachedDetail.units;
    if (navigator.onLine) {
      try {
        const { data } = await db
          .from('pran_not_syllabus_units')
          .select('id, title, description, keywords, status, position')
          .eq('course_id', courseId)
          .order('position');
        if (data?.length) units = data;
      } catch { /* fallback cached */ }
    }
  }

  units.forEach((u, idx) => {
    unitSel.insertAdjacentHTML('beforeend', `<option value="${esc(u.id)}">${idx + 1}. ${esc(u.title)}</option>`);
  });

  // Auto-choisir la première unité en cours ou non maîtrisée
  const suggestedUnit = units.find((u) => u.status === 'in_progress') || units.find((u) => u.status === 'todo');
  if (suggestedUnit) {
    unitSel.value = suggestedUnit.id;
    selectedUnitId = suggestedUnit.id;
  }
  renderUnitFocus();
  updateHeaderStatus();
}

function renderUnitFocus() {
  selectedUnitId = document.getElementById('live-unit-select').value || '';
  const box = document.getElementById('live-unit-focus');
  const desc = document.getElementById('live-unit-desc');
  const kws = document.getElementById('live-unit-kws');
  const u = units.find((x) => x.id === selectedUnitId);
  if (!u || (!u.description && !(u.keywords || []).length)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  desc.textContent = u.description || u.title;
  kws.innerHTML = (u.keywords || []).slice(0, 8).map((k) =>
    `<button type="button" class="chip" data-unit-kw="${esc(k)}">${icon('plus')}<span>${esc(k)}</span></button>`
  ).join('');
  kws.querySelectorAll('[data-unit-kw]').forEach((btn) => {
    btn.addEventListener('click', () => addKeyword(btn.dataset.unitKw, 'definition'));
  });
  icons(kws);
}

/* ------------------------------------------------------------------
   Étape 3 : Mots-clés horodatés
   ------------------------------------------------------------------ */
function addKeyword(term, tag = 'definition') {
  const clean = String(term || '').trim();
  if (!clean) return;
  keywordsLog.push({ term: clean, tag, stamp: formatStamp() });
  setStepDone(3, true);
  setStepActive(3);
  saveDraft();
  renderKeywords();
}

function renderKeywords() {
  const box = document.getElementById('live-keywords-list');
  if (!keywordsLog.length) {
    box.innerHTML = `<span class="text-xs muted">${esc(t('live.keywords_empty'))}</span>`;
    return;
  }
  const tagClass = {
    exam: 'badge-error',
    definition: 'badge-accent',
    question: 'badge-warning',
    article: 'badge-info',
  };
  box.innerHTML = keywordsLog.map((k, idx) => `
    <span class="badge ${tagClass[k.tag] || ''}">
      <span>${esc(k.stamp)}</span>
      <strong>${esc(k.term)}</strong>
      <button type="button" data-insert-kw="${idx}" title="${esc(t('live.insert_into_notes'))}" style="border:0;background:none;color:inherit;padding:0 2px;cursor:pointer;">${icon('arrow-down-left')}</button>
      <button type="button" data-rm-kw="${idx}" aria-label="${esc(t('common.delete'))}" style="border:0;background:none;color:inherit;padding:0 2px;cursor:pointer;">${icon('x')}</button>
    </span>`).join('');

  box.querySelectorAll('[data-insert-kw]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = keywordsLog[Number(btn.dataset.insertKw)];
      if (k) insertIntoNotes(`${k.stamp} [${k.tag.toUpperCase()}] ${k.term}`);
    });
  });
  box.querySelectorAll('[data-rm-kw]').forEach((btn) => {
    btn.addEventListener('click', () => {
      keywordsLog.splice(Number(btn.dataset.rmKw), 1);
      saveDraft();
      renderKeywords();
    });
  });
  icons(box);
}

function insertIntoNotes(snippet) {
  const area = document.getElementById('live-notes-area');
  const clean = String(snippet || '').trim();
  if (!clean) return;
  const cur = area.value;
  area.value = cur ? `${cur.trimEnd()}\n${clean}\n` : `${clean}\n`;
  area.scrollTop = area.scrollHeight;
  setStepDone(2, true);
  saveDraft();
}

/* ------------------------------------------------------------------
   Étape 2 : Enregistrement audio conditionné (Web Audio + Speech + IA)
   ------------------------------------------------------------------ */
function pickAudioMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg']) {
    if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  }
  return '';
}

function drawIdleMeter() {
  const c = document.getElementById('live-audio-meter');
  if (!c) return;
  const ctx = c.getContext('2d');
  const w = c.width = c.clientWidth || 440;
  const h = c.height = 52;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--c-border-strong').trim() || '#D1D5DB';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

function startLiveMeter() {
  const c = document.getElementById('live-audio-meter');
  if (!c || !analyserNode) return;
  const ctx = c.getContext('2d');
  const data = new Uint8Array(analyserNode.fftSize);

  const tick = () => {
    if (!analyserNode || !isRecording) return;
    analyserNode.getByteTimeDomainData(data);
    const w = c.width = c.clientWidth || 440;
    const h = c.height = 52;
    ctx.clearRect(0, 0, w, h);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim() || '#F97316';
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.beginPath();
    const step = w / data.length;
    for (let i = 0; i < data.length; i++) {
      const norm = (data[i] - 128) / 128;
      const x = i * step;
      const y = (h / 2) + norm * (h * 0.44);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    meterRafId = requestAnimationFrame(tick);
  };
  tick();
}

function startSpeechPreview() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  try {
    speechRec = new SR();
    speechRec.continuous = true;
    speechRec.interimResults = true;
    // fr-FR avec repli automatique pour la reconnaissance vocale
    speechRec.lang = 'fr-FR';
    document.getElementById('live-speech-box').hidden = false;

    let finalPart = '';
    speechRec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const piece = e.results[i][0]?.transcript || '';
        if (e.results[i].isFinal) finalPart += `${piece.trim()} `;
        else interim += piece;
      }
      liveSpeechBuffer = `${finalPart}${interim}`.trim();
      const preview = document.getElementById('live-speech-preview');
      if (preview) preview.textContent = liveSpeechBuffer.slice(-280) || '...';

      // Si hors-ligne, injecter périodiquement les phrases complétées dans le brouillon
      if (!navigator.onLine && finalPart.length > 50) {
        insertIntoNotes(`${formatStamp()} ${finalPart.trim()}`);
        finalPart = '';
      }
    };
    speechRec.onend = () => {
      if (isRecording && speechRec) {
        try { speechRec.start(); } catch { /* ignore */ }
      }
    };
    speechRec.start();
  } catch { /* non supporté */ }
}

function stopSpeechPreview() {
  if (speechRec) {
    const ref = speechRec;
    speechRec = null;
    try { ref.onend = null; ref.stop(); } catch { /* ignore */ }
  }
}

function renderTranscriptLog() {
  document.getElementById('live-chunks-count').textContent = `${audioChunks.length} segman`;
  const box = document.getElementById('live-transcript-log');
  if (!audioChunks.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = audioChunks.slice(-4).map((ch, idx) => `
    <div class="card card-sm card-muted">
      <div class="row-between text-xs mb-1">
        <strong>#${idx + 1} · ${formatDuration(ch.duration)}</strong>
        <span class="badge ${ch.status === 'done' ? 'badge-success' : ch.status === 'queued' ? 'badge-warning' : ''}">
          ${esc(ch.status === 'done' ? 'Transkri' : ch.status === 'queued' ? 'Sove lokalman' : t('common.loading'))}
        </span>
      </div>
      ${ch.transcript ? `<div class="text-xs">${esc(ch.transcript)}</div>` : ''}
    </div>`).join('');
}

async function transcribeChunkItem(chunk) {
  if (!navigator.onLine) {
    chunk.status = 'queued';
    if (chunk.liveDraft && !chunk.transcript) {
      chunk.transcript = chunk.liveDraft;
      insertIntoNotes(`${formatStamp()} ${chunk.liveDraft}`);
    }
    renderTranscriptLog();
    return;
  }
  try {
    const b64 = await blobToBase64(chunk.blob);
    const recentTail = document.getElementById('live-notes-area').value.slice(-250);
    const res = await transcribeAudio({
      audioBase64: b64,
      mimeType: chunk.mime,
      language: document.getElementById('live-course-select')?.value ? 'mix' : getLang(),
      mode: 'detailed',
      previousContext: recentTail,
    });
    const text = (res?.text || chunk.liveDraft || '').trim();
    chunk.transcript = text;
    chunk.status = 'done';
    if (text) insertIntoNotes(text);
  } catch {
    chunk.status = 'queued';
    if (chunk.liveDraft) {
      chunk.transcript = chunk.liveDraft;
      insertIntoNotes(chunk.liveDraft);
    }
  }
  renderTranscriptLog();
}

function enqueueChunk(blob, mime, durationSec) {
  if (!blob || blob.size < 400) return;
  const draft = liveSpeechBuffer.trim();
  liveSpeechBuffer = '';
  const item = {
    id: uid(),
    blob,
    mime: (mime || blob.type || 'audio/webm').split(';')[0].trim(),
    duration: Math.max(1, durationSec),
    status: navigator.onLine ? 'transcribing' : 'queued',
    transcript: '',
    liveDraft: draft,
  };
  audioChunks.push(item);
  setStepDone(2, true);
  renderTranscriptLog();
  transcribeQueue = transcribeQueue.then(() => transcribeChunkItem(item));
}

function spawnSegmentRecorder(mime) {
  if (!recStream || !isRecording) return;
  const localParts = [];
  const mr = mime ? new MediaRecorder(recStream, { mimeType: mime, audioBitsPerSecond: 64000 }) : new MediaRecorder(recStream);
  mediaRecorder = mr;
  segElapsedSec = 0;

  mr.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) localParts.push(e.data);
  };
  mr.onstop = () => {
    const actualMime = mr.mimeType || mime || 'audio/webm';
    const blob = new Blob(localParts, { type: actualMime });
    enqueueChunk(blob, actualMime, segElapsedSec || 1);
    if (isRecording) {
      spawnSegmentRecorder(mime);
    } else if (onStopHardwareCleanup) {
      onStopHardwareCleanup();
      onStopHardwareCleanup = null;
    }
  };
  mr.start(1000);
}

async function startLiveAudio() {
  if (isRecording) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast(t('errors.generic'), 'error');
    return;
  }
  try {
    rawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      audioCtx = new AC();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const src = audioCtx.createMediaStreamSource(rawStream);

      // Filtre coupe-bas à 125 Hz pour éliminer bruits de table, coups et grondements
      const hp = audioCtx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 125;

      // Filtre coupe-haut à 3800 Hz pour éliminer chuchotements aigus et froissements de feuilles
      const lp = audioCtx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 3800;

      // Renfort des formants de la voix du professeur (2600 Hz)
      const presence = audioCtx.createBiquadFilter();
      presence.type = 'peaking'; presence.frequency.value = 2600; presence.Q.value = 1.2; presence.gain.value = 5.0;

      // Compresseur pour amplifier les paroles distantes du prof et calmer les bruits proches
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -24; comp.ratio.value = 4.0; comp.attack.value = 0.005; comp.release.value = 0.15;

      const gain = audioCtx.createGain();
      gain.gain.value = 2.2;

      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 1024;
      const dest = audioCtx.createMediaStreamDestination();
      zeroSink = audioCtx.createGain();
      zeroSink.gain.value = 0;

      src.connect(hp);
      hp.connect(lp);
      lp.connect(presence);
      presence.connect(comp);
      comp.connect(gain);
      gain.connect(analyserNode);
      gain.connect(dest);
      analyserNode.connect(zeroSink);
      zeroSink.connect(audioCtx.destination);
      recStream = dest.stream;
    } else {
      recStream = rawStream;
    }

    isRecording = true;
    recTotalSec = 0;
    document.getElementById('live-rec-dot').hidden = false;
    document.getElementById('live-rec-start').hidden = true;
    document.getElementById('live-rec-stop').hidden = false;
    setStepActive(2);

    if ('wakeLock' in navigator) {
      try { wakeLockRef = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
    }

    const mime = pickAudioMime();
    spawnSegmentRecorder(mime);
    startSpeechPreview();
    startLiveMeter();

    recTimerId = setInterval(() => {
      recTotalSec++;
      segElapsedSec++;
      document.getElementById('live-rec-timer').textContent = formatDuration(recTotalSec);
      if (segElapsedSec >= SEGMENT_SECONDS && mediaRecorder && mediaRecorder.state === 'recording') {
        try { mediaRecorder.stop(); } catch { /* ignore */ }
      }
    }, 1000);
  } catch (err) {
    toast(t('errors.mic_denied'), 'error');
    console.warn(err);
  }
}

function stopLiveAudio() {
  if (!isRecording) return;
  isRecording = false;
  clearInterval(recTimerId);
  recTimerId = null;
  if (meterRafId) cancelAnimationFrame(meterRafId);
  meterRafId = null;
  stopSpeechPreview();

  const cleanup = () => {
    rawStream?.getTracks().forEach((tr) => tr.stop());
    rawStream = null;
    recStream = null;
    try { audioCtx?.close(); } catch { /* ignore */ }
    audioCtx = null;
    analyserNode = null;
    zeroSink = null;
    if (wakeLockRef) {
      try { wakeLockRef.release(); } catch { /* ignore */ }
      wakeLockRef = null;
    }
    drawIdleMeter();
    document.getElementById('live-rec-dot').hidden = true;
    document.getElementById('live-rec-start').hidden = false;
    document.getElementById('live-rec-stop').hidden = true;
  };

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    onStopHardwareCleanup = cleanup;
    try { mediaRecorder.stop(); } catch { cleanup(); }
  } else {
    cleanup();
  }
}

/* ------------------------------------------------------------------
   Étape 4 : Recherche rapide pendant que le prof parle (Offline + Online)
   ------------------------------------------------------------------ */
async function runQuickSearch(query) {
  const box = document.getElementById('live-search-results');
  const q = String(query || '').trim();
  if (!q) {
    box.innerHTML = `<p class="text-xs muted mb-0">${esc(t('live.search_hint'))}</p>`;
    return;
  }

  setStepActive(4);
  setStepDone(4, true);
  box.innerHTML = `<div class="row text-xs muted"><span class="spinner"></span><span>${esc(t('common.loading'))}</span></div>`;

  const renderHits = (items) => {
    if (!items.length) {
      box.innerHTML = `<p class="text-xs muted mb-0">${esc(t('search.empty'))}</p>`;
      return;
    }
    box.innerHTML = items.map((it, idx) => `
      <div class="card card-sm card-muted">
        <div class="row-between mb-1">
          <strong class="text-xs">${esc(it.title)}</strong>
          ${it.badge ? `<span class="badge">${esc(it.badge)}</span>` : ''}
        </div>
        <div class="text-xs muted mb-2">${it.isMarkdown ? renderMarkdown(it.snippet) : esc(it.snippet)}</div>
        <button type="button" class="btn btn-sm btn-secondary" data-insert-hit="${idx}">
          ${icon('arrow-down-left')}<span>${esc(t('live.insert_into_notes'))}</span>
        </button>
      </div>`).join('');

    box.querySelectorAll('[data-insert-hit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const hit = items[Number(btn.dataset.insertHit)];
        if (hit) {
          insertIntoNotes(`[${hit.title}] ${hit.plainInsert || hit.snippet}`);
          toast(t('live.inserted_toast'), 'success');
        }
      });
    });
    icons(box);
  };

  if (searchTab === 'library') {
    const hits = [];
    if (navigator.onLine) {
      try {
        const { data } = await db.rpc('pran_not_search_library', {
          q,
          only_book_id: null,
          max_results: 6,
        });
        for (const r of data || []) {
          hits.push({
            title: `${r.book_title || ''}${r.section_label ? ` — ${r.section_label}` : ''}`,
            badge: r.author || '',
            snippet: (r.content || '').slice(0, 260),
            plainInsert: (r.content || '').slice(0, 320),
          });
        }
      } catch { /* fallback offline */ }
    }
    if (!hits.length) {
      const lower = q.toLowerCase();
      const [chunks, books] = await Promise.all([
        cacheGet('library_chunks_offline'),
        cacheGet('library_books_index'),
      ]);
      const bookTitles = new Map((books || []).map((b) => [b.id, b.title]));
      for (const ch of chunks || []) {
        if (String(ch.content || '').toLowerCase().includes(lower)) {
          hits.push({
            title: `${bookTitles.get(ch.book_id) || 'Liv'}${ch.section_label ? ` — ${ch.section_label}` : ''}`,
            badge: 'Lokal',
            snippet: (ch.content || '').slice(0, 260),
            plainInsert: (ch.content || '').slice(0, 320),
          });
        }
        if (hits.length >= 6) break;
      }
    }
    renderHits(hits);
    return;
  }

  if (searchTab === 'notes') {
    const lower = q.toLowerCase();
    const cachedNotes = (await cacheGet('notes_list')) || [];
    let rows = cachedNotes.filter((n) =>
      `${n.title || ''} ${n.summary || ''} ${n.content_text || ''}`.toLowerCase().includes(lower)
    );
    if (!rows.length && navigator.onLine) {
      try {
        const { data } = await db
          .from('pran_not_notes')
          .select('id, title, summary, content_text')
          .ilike('content_text', `%${q}%`)
          .limit(6);
        rows = data || [];
      } catch { /* ignore */ }
    }
    renderHits(rows.slice(0, 6).map((n) => ({
      title: n.title || t('notes.untitled'),
      badge: t('search.kind_note'),
      snippet: (n.summary || n.content_text || '').slice(0, 240),
      plainInsert: (n.summary || n.content_text || '').slice(0, 260),
    })));
    return;
  }

  // Onglet IA / Web
  if (!navigator.onLine) {
    box.innerHTML = `<div class="alert alert-warning text-xs">${icon('wifi-off')}<span>${esc(t('errors.offline'))}</span></div>`;
    icons(box);
    return;
  }
  try {
    const selectedCourse = courses.find((x) => x.id === selectedCourseId);
    const [aiRes, webRes] = await Promise.allSettled([
      askTutor({
        message: q,
        mode: 'simple',
        contextType: 'course',
        contextId: selectedCourseId || null,
        contextText: `Kou an dirèk: ${selectedCourse?.name || ''}\n${document.getElementById('live-notes-area').value.slice(-800)}`,
        courseId: selectedCourseId || null,
        faculty: profileRef?.faculty_id || 'autre',
        level: profileRef?.level || 'L1',
        language: getLang(),
        history: [],
      }),
      searchLibraryWeb({
        query: q,
        faculty: profileRef?.faculty_id || 'autre',
        language: getLang(),
      }),
    ]);

    const hits = [];
    if (aiRes.status === 'fulfilled' && aiRes.value?.reply) {
      hits.push({
        title: t('live.ai_quick_answer'),
        badge: 'IA',
        snippet: aiRes.value.reply,
        plainInsert: aiRes.value.reply.slice(0, 380),
        isMarkdown: true,
      });
    }
    if (webRes.status === 'fulfilled' && Array.isArray(webRes.value?.results)) {
      for (const w of webRes.value.results.slice(0, 3)) {
        hits.push({
          title: w.title || 'Sous Web',
          badge: w.source || 'Web',
          snippet: w.snippet || w.summary || '',
          plainInsert: `${w.title}: ${w.snippet || w.summary || ''}`.slice(0, 320),
        });
      }
    }
    renderHits(hits);
  } catch (err) {
    box.innerHTML = `<p class="text-error text-xs">${esc(handleError(err))}</p>`;
  }
}

/* ------------------------------------------------------------------
   Étape 5 : Terminer le cours & Sauvegarder (IA structurée ou Hors-ligne)
   ------------------------------------------------------------------ */
function buildCompiledContent() {
  const courseObj = courses.find((x) => x.id === selectedCourseId);
  const unitObj = units.find((x) => x.id === selectedUnitId);
  const titleInput = document.getElementById('live-note-title')?.value.trim() || '';
  const title = titleInput
    || (courseObj ? `${courseObj.name} — ${new Date().toLocaleDateString()}` : `${t('live.title')} — ${new Date().toLocaleDateString()}`);

  const scratch = document.getElementById('live-notes-area')?.value.trim() || '';
  const thoughts = document.getElementById('live-thoughts-area')?.value.trim() || '';
  const thoughtsSection = thoughts ? `\n\n## Ide & Panse Rapid\n${thoughts}` : '';
  const hwSection = homeworkList.length
    ? `\n\n## Devwa & Travay pou Fè\n` + homeworkList.map((h) => `- ${h.title}${h.due ? ` (Dat: ${h.due})` : ''}${h.description ? ` : ${h.description}` : ''}`).join('\n')
    : '';
  const kwSection = keywordsLog.length
    ? `\n\n## ${t('live.keywords_title')}\n` + keywordsLog.map((k) => `- ${k.stamp} [${k.tag.toUpperCase()}] ${k.term}`).join('\n')
    : '';
  const unitHeader = unitObj ? `Chapit: ${unitObj.title}\n\n` : '';
  const rawText = `${unitHeader}${scratch}${thoughtsSection}${hwSection}${kwSection}`.trim();
  return { title, rawText, scratch, thoughts, homework: homeworkList };
}

async function finishLiveClass({ withAi = true } = {}) {
  if (isRecording) {
    stopLiveAudio();
    await new Promise((r) => setTimeout(r, 400));
  }
  await transcribeQueue.catch(() => {});

  const { title, rawText } = buildCompiledContent();
  if (!rawText && !audioChunks.length) {
    toast(t('errors.required'), 'warning');
    return;
  }

  const btn = document.getElementById(withAi ? 'live-finish-ai-btn' : 'live-save-quick-btn');
  setLoading(btn, true);
  setStepDone(5, true);
  setStepActive(5);

  const captureMode = audioChunks.length > 0 ? 'audio' : 'text';
  const contentHtml = `<p>${esc(rawText).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
  const clientId = uid();

  const saveOfflineQueue = async () => {
    const item = await enqueue('note', {
      client_id: clientId,
      course_id: selectedCourseId || null,
      unit_id: selectedUnitId || null,
      title,
      content_html: contentHtml,
      content_text: rawText,
      raw_text: rawText,
      language: getLang(),
      capture_mode: captureMode,
      status: withAi ? 'queued' : 'ready',
      process_ai: withAi && !isDataSaver(),
      files: audioChunks.map((ch) => ({ kind: 'audio', blob: ch.blob, mime: ch.mime })),
    });
    clearDraft();
    playNotificationSound('success');
    toast(t('offline.saved_locally'), 'success');
    location.href = appUrl(`pages/note-view.html?id=${encodeURIComponent(`local:${item.id}`)}`);
  };

  if (!navigator.onLine) {
    await saveOfflineQueue();
    return;
  }

  try {
    let finalTitle = title;
    let finalHtml = contentHtml;
    let finalText = rawText;
    let finalSummary = rawText.slice(0, 240);
    let finalStructured = null;

    if (withAi && rawText.trim()) {
      try {
        const structured = await processNote({
          rawText,
          language: getLang(),
          faculty: profileRef?.faculty_id || 'autre',
          level: profileRef?.level || 'L1',
          existingCourses: courses.map((c) => ({ id: c.id, name: c.name })),
        });
        if (structured) {
          finalStructured = structured;
          finalTitle = structured.title || finalTitle;
          finalSummary = structured.summary || finalSummary;
          finalHtml = structured.content_html || finalHtml;
          finalText = structured.content_text || finalText;
        }
      } catch (aiErr) {
        console.warn('[live-class] processNote fallback raw save:', aiErr);
      }
    }

    const { data: noteRow, error } = await db.from('pran_not_notes').upsert({
      user_id: userRef.id,
      client_id: clientId,
      course_id: selectedCourseId || null,
      unit_id: selectedUnitId || null,
      title: finalTitle,
      summary: finalSummary,
      content_html: finalHtml,
      content_text: finalText,
      raw_text: rawText,
      structured: finalStructured,
      language: getLang(),
      capture_mode: captureMode,
      status: 'ready',
      live_started_at: sessionStartedAt,
      live_ended_at: new Date().toISOString(),
      live_duration_seconds: classElapsedSec,
    }, { onConflict: 'user_id,client_id' }).select().single();

    if (error) throw error;

    // Upload audio segments si présents
    for (let i = 0; i < audioChunks.length; i++) {
      const ch = audioChunks[i];
      if (!ch?.blob) continue;
      const ext = ch.mime.includes('mp4') ? 'mp4' : ch.mime.includes('ogg') ? 'ogg' : 'webm';
      const path = `${userRef.id}/${noteRow.id}/${Date.now()}-${i}.${ext}`;
      const { error: upErr } = await db.storage.from('pran-not-note-audio').upload(path, ch.blob, {
        contentType: ch.mime,
        upsert: true,
      });
      if (!upErr) {
        await db.from('pran_not_note_sources').insert({
          user_id: userRef.id,
          note_id: noteRow.id,
          kind: 'audio',
          storage_path: path,
          mime: ch.mime,
          size_bytes: ch.blob.size,
          chunk_index: i,
          status: 'uploaded',
        });
      }
    }

    // Enregistrer les mots-clés capturés pendant le cours
    if (keywordsLog.length) {
      const uniqueTerms = Array.from(new Set(keywordsLog.map((k) => k.term.trim()).filter(Boolean))).slice(0, 20);
      await db.from('pran_not_keywords').insert(uniqueTerms.map((term) => ({
        user_id: userRef.id,
        course_id: selectedCourseId || null,
        unit_id: selectedUnitId || null,
        note_id: noteRow.id,
        term,
      }))).catch(() => {});
    }

    await cacheSet(`note_${noteRow.id}`, noteRow);
    clearDraft();
    playNotificationSound('success');
    await Promise.all([recordActivity(), awardXp(15, 'live_class', noteRow.id)]);
    toast(t('live.saved_success'), 'success');
    location.href = appUrl(`pages/note-view.html?id=${encodeURIComponent(noteRow.id)}`);
  } catch (err) {
    if (isNetworkError(err)) {
      await saveOfflineQueue();
    } else {
      handleError(err);
      setLoading(btn, false);
    }
  }
}

/* ------------------------------------------------------------------
   Initialisation
   ------------------------------------------------------------------ */
(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  profileRef = profile;

  await initAppChrome({ profile, user, active: 'courses', showFab: false });
  pageEnter();
  drawIdleMeter();

  const cachedCourses = (await cacheGet('courses_list')) || [];
  courses = mergeCourseSchedules(cachedCourses);

  if (navigator.onLine) {
    try {
      const { data } = await db.from('pran_not_courses').select('*').eq('archived', false).order('name');
      if (data) {
        courses = mergeCourseSchedules(data);
        await cacheSet('courses_list', courses);
      }
    } catch { /* use cached */ }
  }

  const courseSel = document.getElementById('live-course-select');
  courses.forEach((c) => {
    const badge = formatCourseScheduleBadge(c);
    courseSel.insertAdjacentHTML('beforeend', `<option value="${esc(c.id)}">${esc(c.name)}${badge ? ` (${esc(badge)})` : ''}</option>`);
  });

  // Auto-sélection : param ?course= -> sinon cours en direct -> sinon cours imminent
  let initialCourseId = getParam('course') || '';
  if (!initialCourseId) {
    const liveMatch = courses.find((c) => getCourseLiveStatus(c).state === 'live')
      || courses.find((c) => getCourseLiveStatus(c).state === 'soon');
    if (liveMatch) initialCourseId = liveMatch.id;
  }
  if (initialCourseId && courses.some((c) => c.id === initialCourseId)) {
    courseSel.value = initialCourseId;
  }

  await loadUnitsForCourse(courseSel.value);
  restoreDraft(courseSel.value);
  renderKeywords();

  // Chrono session en direct
  classTimerId = setInterval(() => {
    classElapsedSec++;
    const clock = document.getElementById('live-clock-badge');
    if (clock) clock.textContent = formatDuration(classElapsedSec);
  }, 1000);

  courseSel.addEventListener('change', async () => {
    await loadUnitsForCourse(courseSel.value);
    saveDraft();
  });
  document.getElementById('live-unit-select').addEventListener('change', () => {
    renderUnitFocus();
    saveDraft();
  });

  document.getElementById('live-notes-area').addEventListener('input', () => {
    setStepDone(2, true);
    setStepActive(2);
    saveDraft();
  });
  document.getElementById('live-note-title').addEventListener('input', saveDraft);

  document.getElementById('live-stamp-btn').addEventListener('click', () => {
    insertIntoNotes(`${formatStamp()} `);
    document.getElementById('live-notes-area').focus();
  });

  // Audio
  document.getElementById('live-rec-start').addEventListener('click', startLiveAudio);
  document.getElementById('live-rec-stop').addEventListener('click', stopLiveAudio);

  // Mots-clés
  document.getElementById('live-kw-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = document.getElementById('live-kw-input');
    const tag = document.getElementById('live-kw-tag').value;
    if (!inp.value.trim()) return;
    addKeyword(inp.value.trim(), tag);
    inp.value = '';
    inp.focus();
  });

  document.querySelectorAll('#live-quick-tags [data-quick-tag]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.quickTag;
      const inp = document.getElementById('live-kw-input');
      const val = inp.value.trim() || btn.textContent.trim();
      addKeyword(val, tag);
      if (inp.value.trim()) inp.value = '';
    });
  });

  // Recherche rapide tabs
  document.querySelectorAll('#live-search-tabs [data-search-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      searchTab = btn.dataset.searchTab;
      document.querySelectorAll('#live-search-tabs [data-search-tab]').forEach((b) => {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      const q = document.getElementById('live-search-input').value.trim();
      if (q) runQuickSearch(q);
    });
  });

  document.getElementById('live-search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runQuickSearch(document.getElementById('live-search-input').value);
  });

  // WhatsApp rapèl manyèl
  document.getElementById('live-wa-btn').addEventListener('click', async (e) => {
    const c = courses.find((x) => x.id === selectedCourseId) || { id: null, name: t('live.title') };
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const res = await triggerWhatsAppClassAlert(c, { manual: true });
      if (res?.sent || res?.ok || res?.queued) {
        toast(t('notifications.wa_sent'), 'success');
      }
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  // Devwa & Travay pou fè pandan kou a
  document.getElementById('live-hw-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('live-hw-title')?.value.trim();
    const due = document.getElementById('live-hw-due')?.value || '';
    const desc = document.getElementById('live-hw-desc')?.value.trim() || '';
    if (!title) return;
    const hwItem = { id: uid(), title, due, description: desc, course_id: selectedCourseId || null };
    homeworkList.push(hwItem);
    renderHomeworkList();
    document.getElementById('live-hw-title').value = '';
    document.getElementById('live-hw-due').value = '';
    document.getElementById('live-hw-desc').value = '';
    insertIntoNotes(`\n[DEVWA] ${title}${due ? ` (Dat limit : ${due})` : ''}${desc ? ` : ${desc}` : ''}\n`);
    saveDraft();
    playNotificationSound('success');
    toast('Devwa anrejistre pou kou a!', 'success');

    if (navigator.onLine && userRef) {
      try {
        await db.from('pran_not_assignments').insert({
          user_id: userRef.id,
          course_id: selectedCourseId || null,
          title,
          description: desc,
          due_at: due ? new Date(due).toISOString() : null,
          status: 'todo',
        });
      } catch { /* sera synchronisé */ }
    }
  });

  document.getElementById('live-thoughts-area')?.addEventListener('input', () => {
    saveDraft({ showBadge: true });
  });

  // Pwolonje lè kou a (+15 min, +30 min, +60 min)
  const extendClassTime = async (minutes) => {
    const c = courses.find((x) => x.id === selectedCourseId);
    if (!c) {
      toast(`Ajoute ${minutes} min sou sesyon an!`, 'info');
      return;
    }
    const endStr = c.schedule_end_time || '';
    let newEndStr = endStr;
    if (endStr) {
      const parts = endStr.split(':');
      let hh = Number(parts[0]);
      let mm = Number(parts[1]) + minutes;
      while (mm >= 60) { mm -= 60; hh = (hh + 1) % 24; }
      newEndStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      c.schedule_end_time = newEndStr;
    }
    updateHeaderStatus();
    playNotificationSound('chime');
    toast(`Kou a pwolonje de +${minutes} minit!`, 'success');

    if (navigator.onLine && c.id) {
      try {
        await db.from('pran_not_courses').update({ schedule_end_time: newEndStr }).eq('id', c.id);
      } catch { /* ignore */ }
    }
  };

  document.getElementById('live-add-15-btn')?.addEventListener('click', () => extendClassTime(15));
  document.getElementById('live-add-30-btn')?.addEventListener('click', () => extendClassTime(30));
  document.getElementById('live-add-60-btn')?.addEventListener('click', () => extendClassTime(60));

  document.getElementById('live-delay-start-btn')?.addEventListener('click', () => {
    classElapsedSec = 0;
    const clock = document.getElementById('live-clock-badge');
    if (clock) clock.textContent = '00:00';
    toast('Kòmansman kou a repòte.', 'info');
  });

  document.getElementById('live-mark-finished-btn')?.addEventListener('click', async () => {
    if (isRecording) stopLiveAudio();
    playNotificationSound('chime');
    toast(`Kou a fini (${formatDuration(classElapsedSec)}). Nap prepare nòt la...`, 'info');
    await finishLiveClass({ withAi: true });
  });

  // Transfè nòt an dirèk sou sit la
  document.getElementById('live-transfer-btn')?.addEventListener('click', () => {
    const compiled = buildCompiledContent();
    const c = courses.find((x) => x.id === selectedCourseId);
    openSendTransferModal({
      title: compiled.title,
      content_html: `<p>${esc(compiled.rawText).replace(/\n/g, '<br>')}</p>`,
      content_text: compiled.rawText,
      summary: compiled.rawText.slice(0, 240),
      keywords: keywordsLog,
      homework: homeworkList,
      course_name: c?.name || '',
    });
  });

  document.getElementById('live-receive-btn')?.addEventListener('click', () => {
    openReceiveTransferModal((newNote) => {
      location.href = appUrl(`pages/note-view.html?id=${newNote.id}`);
    });
  });

  // Revizyon egzamen pa peryòd dat
  document.getElementById('live-exam-history-btn')?.addEventListener('click', () => {
    openExamRevisionModal({ courseId: selectedCourseId, courses });
  });

  // Tradiksyon rapid Kreyòl <-> Français
  document.getElementById('live-translate-btn')?.addEventListener('click', async (e) => {
    const area = document.getElementById('live-notes-area');
    const text = area?.value.trim();
    if (!text) {
      toast(t('errors.required'), 'warning');
      return;
    }
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      // Detekte lang dominan pou tradiksyon
      const isMostlyFrench = /^(le|la|les|des|un|une|dans|pour|avec|nous|vous|est|sont)\b/i.test(text);
      const targetMode = isMostlyFrench ? 'harmonize_ht' : 'harmonize_fr';
      const res = await processNote({
        rawText: text,
        mode: targetMode,
        language: isMostlyFrench ? 'ht' : 'fr',
        faculty: profileRef?.faculty_id || 'autre',
        level: profileRef?.level || 'L1',
      });
      if (res?.content_text) {
        area.value = res.content_text;
        saveDraft();
        playNotificationSound('success');
        toast('Nòt la tradui ak siksè!', 'success');
      } else {
        toast('Tradiksyon an pa t ka konplete', 'warning');
      }
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  // Auto-save en arrière-plan chak 10 segonn
  setInterval(() => {
    if (document.getElementById('live-notes-area')?.value) {
      saveDraft({ showBadge: false });
    }
  }, 10000);

  // Sauvegarde finale
  document.getElementById('live-finish-ai-btn').addEventListener('click', () => finishLiveClass({ withAi: true }));
  document.getElementById('live-save-quick-btn').addEventListener('click', () => finishLiveClass({ withAi: false }));

  icons(document.body);
})();
