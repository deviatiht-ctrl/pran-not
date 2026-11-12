/* =====================================================================
   PRAN NÒT - pages/note-capture.js
   Capture ultra rapide en 5 modes :
   photo (rafale + contraste + OCR), audio salle de cours conditionné Web Audio
   (gain, filtre vocal 85Hz-2.6kHz, compresseur, rotation 75s + import audio),
   note éclair vocale, texte riche (Quill), import PDF/image.
   Fonctionne hors-ligne via IndexedDB.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, recordActivity, awardXp, appUrl } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t } from '../i18n.js';
import {
  icons, icon, esc, toast, handleError, setLoading, getParam, uid,
  compressImage, blobToBase64, checkFileSize, extractPdfText, renderPdfPageToBlob,
  loadScript, loadStyle, CDN, sanitizeHtml, htmlToText, promptDialog, formatDuration, pageEnter,
} from '../utils.js';
import { ocrBoard, transcribeAudio, processNote } from '../ai.js';
import { enqueue, isDataSaver, cacheGet, cacheSet, isNetworkError } from '../offline.js';

const db = window.db;
const SEGMENT_ROTATE_SECONDS = 45;

let currentMode = 'photo';
let profileRef = null;
let userRef = null;
let coursesList = [];
let quill = null;
let structuredData = null;
let suggestedCourseId = null;

// Fichiers originaux conservés
const photoBlobs = []; // { blob, url, name }
const audioChunksBlobs = []; // { id, blob, url, mime, ext, duration, status, transcript, liveDraft, provider, error }
const importedFiles = []; // { file, kind }

// Enregistrement audio conditionné (Web Audio API + rotation segments autonomes + reconnaissance directe)
let audioProfile = 'classroom'; // 'classroom' | 'close' | 'direct'
let transcribePrecision = 'detailed'; // 'detailed' | 'fast'
let micGainMultiplier = 2.0;

let isRecordingSession = false;
let rawMicStream = null;
let recordStream = null;
let audioCtx = null;
let gainNode = null;
let analyserNode = null;
let zeroSinkNode = null;
let mediaRecorder = null;
let speechRecognition = null;
let liveSpeechBuffer = '';
let segmentPeakMax = 0;
let meterSampledFrames = 0;
let totalSeconds = 0;
let segmentSeconds = 0;
let recTimerId = null;
let meterRafId = null;
let wakeLockRef = null;
let transcribeQueue = Promise.resolve();
let onStopHardwareCleanup = null;

function mimeToExt(mime = '') {
  const clean = String(mime || '').toLowerCase();
  if (clean.includes('mp4')) return 'mp4';
  if (clean.includes('m4a')) return 'm4a';
  if (clean.includes('aac')) return 'aac';
  if (clean.includes('mpeg') || clean.includes('mp3')) return 'mp3';
  if (clean.includes('ogg') || clean.includes('opus')) return 'ogg';
  if (clean.includes('wav')) return 'wav';
  if (clean.includes('flac')) return 'flac';
  return 'webm';
}

async function initQuill() {
  try {
    loadStyle(CDN.quillCss);
    await loadScript(CDN.quillJs);
    quill = new window.Quill('#quill-editor', {
      theme: 'snow',
      placeholder: 'Ekri oswa kole nòt ou a isit la...',
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', { background: [] }],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['blockquote', 'code-block', 'clean'],
        ],
      },
    });
  } catch {
    // Repli hors-ligne si Quill CDN n'était pas encore en cache
    const host = document.getElementById('quill-editor');
    if (host && !host.querySelector('textarea')) {
      host.innerHTML = `<textarea class="textarea" id="quill-fallback-ta" rows="10" placeholder="Ekri oswa kole nòt ou a isit la..."></textarea>`;
      const getText = () => host.querySelector('#quill-fallback-ta')?.value || '';
      quill = {
        root: {
          get innerHTML() {
            return `<p>${esc(getText()).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
          },
          set innerHTML(html) {
            const ta = host.querySelector('#quill-fallback-ta');
            if (ta) ta.value = htmlToText(html);
          },
        },
      };
    }
  }
}

function setAudioProfile(profile) {
  audioProfile = ['close', 'direct'].includes(profile) ? profile : 'classroom';
  document.querySelectorAll('#audio-profile-group [data-audio-profile]').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.audioProfile === audioProfile ? 'true' : 'false');
  });
  if (!isRecordingSession) {
    micGainMultiplier = audioProfile === 'classroom' ? 2.0 : audioProfile === 'close' ? 1.2 : 1.0;
    const slider = document.getElementById('rec-gain-slider');
    const badge = document.getElementById('rec-gain-val');
    if (slider) slider.value = String(micGainMultiplier);
    if (badge) badge.textContent = `${micGainMultiplier.toFixed(1)}x`;
  }
  const slider = document.getElementById('rec-gain-slider');
  if (slider) slider.disabled = audioProfile === 'direct';
  if (gainNode) gainNode.gain.value = micGainMultiplier;
}

function setTranscribePrecision(mode) {
  transcribePrecision = mode === 'fast' ? 'fast' : 'detailed';
  document.querySelectorAll('#transcribe-mode-group [data-transcribe-mode]').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.transcribeMode === transcribePrecision ? 'true' : 'false');
  });
}

async function populateMicDevices() {
  const sel = document.getElementById('mic-device-select');
  if (!sel || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const current = sel.value;
    sel.innerHTML = `<option value="">${esc(t('capture.mic_device_default'))}</option>` + inputs.map((d, idx) =>
      `<option value="${esc(d.deviceId)}">${esc(d.label || `Mikwofòn ${idx + 1}`)}</option>`
    ).join('');
    if (current && inputs.some((d) => d.deviceId === current)) sel.value = current;
  } catch { /* ignore */ }
}

function switchMode(mode) {
  currentMode = ['photo', 'audio', 'flash', 'text', 'import'].includes(mode) ? mode : 'photo';
  document.querySelectorAll('#capture-modes [role="tab"]').forEach((btn) => {
    btn.setAttribute('aria-selected', btn.dataset.mode === currentMode ? 'true' : 'false');
  });
  document.getElementById('panel-photo').hidden = currentMode !== 'photo';
  document.getElementById('panel-audio').hidden = !(currentMode === 'audio' || currentMode === 'flash');
  document.getElementById('panel-import').hidden = currentMode !== 'import';
  document.getElementById('raw-section').hidden = currentMode === 'text';

  const hint = document.getElementById('audio-live-hint');
  if (currentMode === 'flash') {
    hint.textContent = 'Nòt eklè : peze Kòmanse, pale lide ou a vit, epi peze Fini pou transkri touswit.';
    if (!isRecordingSession) setAudioProfile('close');
  } else if (currentMode === 'audio') {
    hint.textContent = 'Mòd sal kou : filt vwa pwofesè (85 Hz - 2.6 kHz) + konpresè + segman 45 s pou presizyon maksimòm.';
    if (!isRecordingSession) setAudioProfile('classroom');
  }
  if (currentMode === 'audio' || currentMode === 'flash') {
    populateMicDevices();
  }
}

function updateRawWordCount() {
  const txt = document.getElementById('raw-text').value.trim();
  const words = txt ? txt.split(/\s+/).length : 0;
  document.getElementById('raw-count').textContent = `${words} mo`;
}

function renderPhotoThumbs() {
  const grid = document.getElementById('photo-thumbs');
  grid.innerHTML = photoBlobs.map((p, idx) => `
    <div class="thumb">
      <img src="${esc(p.url)}" alt="Foto ${idx + 1}" loading="lazy">
      <button type="button" class="btn-icon" data-rm-photo="${idx}" aria-label="${esc(t('common.delete'))}">${icon('x')}</button>
    </div>`).join('');
  grid.querySelectorAll('[data-rm-photo]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.rmPhoto);
      URL.revokeObjectURL(photoBlobs[i].url);
      photoBlobs.splice(i, 1);
      renderPhotoThumbs();
    });
  });
  document.getElementById('ocr-run-btn').disabled = photoBlobs.length === 0;
  icons(grid);
}

async function handlePhotoFiles(fileList) {
  const enhance = document.getElementById('opt-enhance').checked;
  const autoCrop = document.getElementById('opt-autocrop').checked;
  const maxSize = isDataSaver() ? 1200 : 1600;
  const quality = isDataSaver() ? 0.6 : 0.75;

  for (const file of Array.from(fileList || []).slice(0, 8)) {
    if (!checkFileSize(file, 'image')) continue;
    try {
      const blob = await compressImage(file, { maxSize, quality, enhance, autoCrop });
      photoBlobs.push({ blob, url: URL.createObjectURL(blob), name: file.name });
    } catch (err) {
      handleError(err);
    }
  }
  renderPhotoThumbs();
}

function renderUncertainItems(uncertainList = []) {
  const alertBox = document.getElementById('uncertain-alert');
  const chips = document.getElementById('uncertain-chips');
  if (!uncertainList.length) {
    alertBox.hidden = true;
    chips.innerHTML = '';
    return;
  }
  alertBox.hidden = false;
  chips.innerHTML = uncertainList.map((u, idx) => `
    <button type="button" class="chip" data-uncertain-idx="${idx}" title="${esc(u.reason || '')}">
      <span>"${esc(u.text)}"</span>
      ${u.suggestion ? `<span>-> ${esc(u.suggestion)}</span>` : ''}
    </button>`).join('');

  chips.querySelectorAll('[data-uncertain-idx]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = uncertainList[Number(btn.dataset.uncertainIdx)];
      const corrected = await promptDialog({
        title: t('common.uncertain_note'),
        label: u.reason || u.text,
        value: u.suggestion || u.text,
      });
      if (corrected) {
        const area = document.getElementById('raw-text');
        area.value = area.value.replace(u.text, corrected);
        updateRawWordCount();
        btn.remove();
        if (!chips.children.length) alertBox.hidden = true;
      }
    });
  });
}

/* ------------------------------------------------------------------
   Pipeline audio avancé pour captation voix professeur en salle
   ------------------------------------------------------------------ */
function pickAudioMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg']) {
    if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  }
  return '';
}

function drawIdleMeter() {
  const canvas = document.getElementById('audio-meter');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth || 480;
  const h = canvas.height = 64;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--c-border-strong').trim() || '#D1D5DB';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

function startLiveMeter() {
  if (!analyserNode) return;
  const canvas = document.getElementById('audio-meter');
  const badge = document.getElementById('audio-signal-badge');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const data = new Uint8Array(analyserNode.fftSize);
  let lowFrames = 0;

  const tick = () => {
    if (!analyserNode || !isRecordingSession) return;
    analyserNode.getByteTimeDomainData(data);

    const w = canvas.width = canvas.clientWidth || 480;
    const h = canvas.height = 64;
    ctx.clearRect(0, 0, w, h);

    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--c-accent').trim() || '#F97316';
    const navy = style.getPropertyValue('--c-navy').trim() || '#1B2A4A';

    let sumSq = 0;
    let peak = 0;
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.beginPath();

    const step = w / data.length;
    for (let i = 0; i < data.length; i++) {
      const norm = (data[i] - 128) / 128;
      const abs = Math.abs(norm);
      if (abs > peak) peak = abs;
      sumSq += norm * norm;
      const x = i * step;
      const y = (h / 2) + norm * (h * 0.44);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    meterSampledFrames++;
    if (peak > segmentPeakMax) segmentPeakMax = peak;

    const rms = Math.sqrt(sumSq / data.length);
    if (badge) {
      if (peak > 0.94) {
        badge.className = 'badge badge-error';
        badge.textContent = t('capture.audio_meter_clip');
        lowFrames = 0;
      } else if (rms < 0.012) {
        lowFrames++;
        if (lowFrames > 45) {
          badge.className = 'badge badge-warning';
          badge.textContent = t('capture.audio_meter_low');
        }
      } else {
        lowFrames = 0;
        badge.className = 'badge badge-success';
        badge.textContent = t('capture.audio_meter_good');
      }
    }

    // Barre de niveau RMS discrète en bas du canevas
    const lvlWidth = Math.min(1, rms * 6.5) * w;
    ctx.fillStyle = navy;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(0, h - 4, lvlWidth, 4);
    ctx.globalAlpha = 1;

    meterRafId = requestAnimationFrame(tick);
  };
  meterRafId = requestAnimationFrame(tick);
}

async function setupAudioConditioning(stream) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return stream;
  try {
    audioCtx = new AC({ latencyHint: 'interactive' });
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    const source = audioCtx.createMediaStreamSource(stream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 1024;
    analyserNode.smoothingTimeConstant = 0.78;

    // Puits silencieux obligatoire : maintient le graphe Web Audio actif sur Chrome/Android même sans haut-parleur
    zeroSinkNode = audioCtx.createGain();
    zeroSinkNode.gain.value = 0;
    analyserNode.connect(zeroSinkNode);
    zeroSinkNode.connect(audioCtx.destination);

    // Profil "Direct" : mesure du signal uniquement, enregistrement du flux matériel brut sans traitement
    if (audioProfile === 'direct') {
      source.connect(analyserNode);
      return stream;
    }

    // 1. Filtre passe-haut 85 Hz : enlève le bourdonnement électrique, vent et chocs de table
    const highpass = audioCtx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 85;
    highpass.Q.value = 0.7;

    // 2. Légère bosse d'intelligibilité vocale autour de 2.6 kHz (consonnes créoles/françaises)
    const presence = audioCtx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2600;
    presence.Q.value = 1.0;
    presence.gain.value = audioProfile === 'classroom' ? 4.5 : 1.5;

    // 3. Préamplification ajustable en direct (capte les professeurs au fond de la salle)
    gainNode = audioCtx.createGain();
    gainNode.gain.value = micGainMultiplier;

    // 4. Compresseur dynamique : relève la voix faible sans saturer les sons proches
    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = audioProfile === 'classroom' ? -30 : -20;
    compressor.knee.value = 18;
    compressor.ratio.value = audioProfile === 'classroom' ? 4.5 : 2.5;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.22;

    const dest = audioCtx.createMediaStreamDestination();
    source
      .connect(highpass)
      .connect(presence)
      .connect(gainNode)
      .connect(compressor)
      .connect(analyserNode);
    compressor.connect(dest);

    const outTrack = dest.stream?.getAudioTracks?.()[0];
    if (!outTrack || outTrack.readyState !== 'live') {
      return stream;
    }
    return dest.stream;
  } catch (err) {
    console.warn('[audio] Web Audio conditioning fallback to raw stream', err);
    return stream;
  }
}

function startLiveSpeechPreview(langVal) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const box = document.getElementById('live-speech-box');
  const prev = document.getElementById('live-speech-preview');
  liveSpeechBuffer = '';
  if (!SR || !navigator.onLine || !box || !prev) return;
  try {
    speechRecognition = new SR();
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = langVal === 'fr' ? 'fr-FR' : 'fr-HT';
    let finalText = '';
    speechRecognition.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finalText += `${res[0].transcript} `;
        else interim += res[0].transcript;
      }
      liveSpeechBuffer = `${finalText}${interim}`.trim();
      if (liveSpeechBuffer) {
        box.hidden = false;
        prev.textContent = liveSpeechBuffer;
      }
    };
    speechRecognition.onerror = () => {};
    speechRecognition.onend = () => {
      if (isRecordingSession && speechRecognition) {
        try { speechRecognition.start(); } catch { /* ignore */ }
      }
    };
    speechRecognition.start();
  } catch {
    speechRecognition = null;
  }
}

function stopLiveSpeechPreview() {
  if (!speechRecognition) return;
  const ref = speechRecognition;
  speechRecognition = null;
  try { ref.onend = null; ref.stop(); } catch { /* ignore */ }
}

function spawnSegmentRecorder(stream, mime) {
  const bps = isDataSaver() ? 64000 : 96000;
  let rec;
  try {
    rec = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: bps }) : new MediaRecorder(stream);
  } catch {
    rec = new MediaRecorder(stream);
  }

  let segChunks = [];
  const segStartedAt = Date.now();
  const capturedLiveDraft = () => liveSpeechBuffer.trim();

  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) segChunks.push(e.data);
  };

  rec.onstop = () => {
    const finalMime = rec.mimeType || mime || 'audio/webm';
    const blob = new Blob(segChunks, { type: finalMime });
    segChunks = [];
    const segDuration = Math.max(1, Math.round((Date.now() - segStartedAt) / 1000));
    const observedPeak = segmentPeakMax;
    const sampled = meterSampledFrames;
    segmentPeakMax = 0;
    meterSampledFrames = 0;

    if (typeof onStopHardwareCleanup === 'function') {
      const fn = onStopHardwareCleanup;
      onStopHardwareCleanup = null;
      fn();
    }

    if (sampled > 10 && observedPeak < 0.002 && segDuration >= 2) {
      toast(t('capture.audio_silent_warning'), 'warning');
    }

    if (blob.size > 250) {
      const ext = mimeToExt(finalMime);
      const clip = {
        id: uid(),
        blob,
        url: URL.createObjectURL(blob),
        mime: finalMime,
        ext,
        duration: segDuration,
        status: navigator.onLine ? 'pending' : 'offline',
        transcript: '',
        liveDraft: capturedLiveDraft(),
        provider: '',
        error: '',
      };
      liveSpeechBuffer = '';
      audioChunksBlobs.push(clip);
      document.getElementById('rec-chunks-badge').textContent = `${audioChunksBlobs.length} segman`;
      renderAudioClips();

      if (navigator.onLine) {
        enqueueTranscription(clip);
      } else {
        toast(t('offline.saved_locally'), 'info');
      }
    } else {
      toast(t('capture.audio_silent_warning'), 'warning');
    }
  };

  rec.start(500);
  return rec;
}

function rotateAudioSegment(mime) {
  if (!isRecordingSession || !mediaRecorder || mediaRecorder.state !== 'recording') return;
  const oldRec = mediaRecorder;
  // Démarrer le nouveau segman avant de clore l'ancien pour ne perdre aucun mot du professeur
  segmentSeconds = totalSeconds;
  mediaRecorder = spawnSegmentRecorder(recordStream, mime);
  try {
    oldRec.stop();
  } catch { /* ignore */ }
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Navigatè sa a pa sipòte anrejistreman mikwofòn.', 'error');
    return;
  }
  const selectedDeviceId = document.getElementById('mic-device-select')?.value || '';
  const deviceConstraint = selectedDeviceId ? { deviceId: { ideal: selectedDeviceId } } : {};

  try {
    const constraints = audioProfile === 'direct'
      ? { audio: selectedDeviceId ? deviceConstraint : true }
      : audioProfile === 'classroom'
        ? {
            audio: {
              ...deviceConstraint,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: true,
              channelCount: 1,
            },
          }
        : {
            audio: {
              ...deviceConstraint,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
          };
    rawMicStream = await navigator.mediaDevices.getUserMedia(constraints);
    populateMicDevices();
  } catch {
    toast('Otorize mikwofòn nan nan navigatè ou pou anrejistre.', 'error');
    return;
  }

  isRecordingSession = true;
  segmentPeakMax = 0;
  meterSampledFrames = 0;
  onStopHardwareCleanup = null;
  totalSeconds = 0;
  segmentSeconds = 0;
  recordStream = await setupAudioConditioning(rawMicStream);

  const mime = pickAudioMime();
  mediaRecorder = spawnSegmentRecorder(recordStream, mime);

  const liveBox = document.getElementById('live-speech-box');
  if (liveBox) liveBox.hidden = true;
  startLiveSpeechPreview(document.getElementById('note-lang')?.value || 'mix');

  document.getElementById('rec-dot').hidden = false;
  document.getElementById('rec-start-btn').hidden = true;
  document.getElementById('rec-pause-btn').hidden = false;
  document.getElementById('rec-stop-btn').hidden = false;
  document.getElementById('rec-timer').textContent = '00:00';

  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').then((wl) => { wakeLockRef = wl; }).catch(() => {});
  }

  startLiveMeter();

  recTimerId = setInterval(() => {
    if (mediaRecorder?.state === 'recording') {
      totalSeconds++;
      document.getElementById('rec-timer').textContent = formatDuration(totalSeconds);
      if (currentMode === 'audio' && (totalSeconds - segmentSeconds) >= SEGMENT_ROTATE_SECONDS) {
        rotateAudioSegment(mime);
      }
    }
  }, 1000);
}

function togglePauseRecording() {
  if (!mediaRecorder) return;
  const btn = document.getElementById('rec-pause-btn');
  if (mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    document.getElementById('rec-dot').hidden = true;
    btn.innerHTML = `${icon('play')}<span>${esc(t('capture.rec_resume'))}</span>`;
  } else if (mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    document.getElementById('rec-dot').hidden = false;
    btn.innerHTML = `${icon('pause')}<span>${esc(t('capture.rec_pause'))}</span>`;
  }
  icons(btn);
}

function stopRecording() {
  isRecordingSession = false;
  clearInterval(recTimerId);
  cancelAnimationFrame(meterRafId);
  stopLiveSpeechPreview();

  const streamToStop = rawMicStream;
  const ctxToClose = audioCtx;
  rawMicStream = null;
  recordStream = null;
  audioCtx = null;
  gainNode = null;
  analyserNode = null;
  zeroSinkNode = null;

  let cleaned = false;
  const releaseHardware = () => {
    if (cleaned) return;
    cleaned = true;
    streamToStop?.getTracks().forEach((tr) => tr.stop());
    if (ctxToClose) {
      ctxToClose.close().catch(() => {});
    }
  };

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    onStopHardwareCleanup = releaseHardware;
    try {
      if (mediaRecorder.state === 'recording') mediaRecorder.requestData();
    } catch { /* ignore */ }
    mediaRecorder.stop();
    setTimeout(releaseHardware, 500);
  } else {
    releaseHardware();
  }

  if (wakeLockRef) {
    wakeLockRef.release().catch(() => {});
    wakeLockRef = null;
  }

  document.getElementById('rec-dot').hidden = true;
  document.getElementById('rec-start-btn').hidden = false;
  document.getElementById('rec-pause-btn').hidden = true;
  document.getElementById('rec-stop-btn').hidden = true;

  const badge = document.getElementById('audio-signal-badge');
  if (badge) {
    badge.className = 'badge badge-outline';
    badge.textContent = t('capture.audio_meter_idle');
  }
  drawIdleMeter();
}

function renderAudioClips() {
  const box = document.getElementById('audio-clips-box');
  box.innerHTML = audioChunksBlobs.map((a, i) => {
    const statusBadge = a.status === 'transcribing'
      ? `<span class="badge badge-info"><span class="spinner" style="width:12px;height:12px;"></span><span>${esc(t('capture.audio_transcribing'))}</span></span>`
      : a.status === 'done' && a.transcript
        ? `<span class="badge badge-success">OK</span>`
        : a.status === 'done'
          ? `<span class="badge badge-warning">Silans</span>`
          : a.status === 'error'
            ? `<span class="badge badge-error" title="${esc(a.error || '')}">Erè</span>`
            : `<span class="badge">Lokal</span>`;
    return `
      <div class="card card-sm">
        <div class="row-between mb-2" style="flex-wrap:wrap;">
          <div class="row-wrap">
            <strong class="text-sm">${esc(a.label || `Odyo #${i + 1}`)}</strong>
            <span class="text-xs muted">${a.duration ? formatDuration(a.duration) : a.ext.toUpperCase()}</span>
            ${statusBadge}
          </div>
          <div class="row-wrap">
            <button type="button" class="btn btn-sm btn-secondary" data-retry-clip="${esc(a.id)}" ${a.status === 'transcribing' ? 'disabled' : ''}>
              ${icon('rotate-cw')}<span>${esc(t('capture.audio_retry_btn'))}</span>
            </button>
          </div>
        </div>
        <audio controls src="${esc(a.url)}" style="width:100%;height:36px;"></audio>
        ${a.transcript ? `<p class="text-xs mt-2 mb-0">${esc(a.transcript)}</p>` : ''}
        ${a.status === 'error' && a.error ? `<p class="text-xs text-error mt-2 mb-0">${esc(a.error)}</p>` : ''}
      </div>`;
  }).join('');

  box.querySelectorAll('[data-retry-clip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const clip = audioChunksBlobs.find((c) => c.id === btn.dataset.retryClip);
      if (clip) enqueueTranscription(clip, true);
    });
  });
  icons(box);
}

function enqueueTranscription(clip, isRetry = false) {
  transcribeQueue = transcribeQueue.then(() => transcribeClip(clip, isRetry)).catch(() => {});
  return transcribeQueue;
}

async function transcribeClip(clip, isRetry = false) {
  const idx = audioChunksBlobs.indexOf(clip);
  clip.status = 'transcribing';
  clip.error = '';
  renderAudioClips();

  try {
    const b64 = await blobToBase64(clip.blob);
    const courseSel = document.getElementById('note-course');
    const courseName = courseSel?.selectedOptions?.[0]?.value ? courseSel.selectedOptions[0].textContent : '';
    const area = document.getElementById('raw-text');
    const previousContext = (area.value.trim() || clip.liveDraft || '').slice(-260);

    const res = await transcribeAudio({
      audioBase64: b64,
      mimeType: clip.mime || 'audio/webm',
      language: document.getElementById('note-lang').value,
      chunkIndex: Math.max(0, idx),
      mode: transcribePrecision,
      courseName,
      faculty: profileRef?.faculty_id || '',
      previousContext,
    });

    clip.status = 'done';
    clip.provider = res?.provider || '';
    const prevText = (clip.transcript || '').trim();
    const serverText = (res?.text || '').trim();
    const text = serverText || (clip.liveDraft ? clip.liveDraft.trim() : '');
    clip.transcript = text;
    if (text) {
      if (isRetry && prevText && area.value.includes(prevText)) {
        area.value = area.value.replace(prevText, text);
      } else {
        area.value = `${area.value}\n\n${text}`.trim();
      }
      updateRawWordCount();
      toast(isRetry ? 'Transkripsyon an mete ajou.' : 'Transkripsyon an ajoute.', 'success');
    } else {
      toast(t('capture.audio_silent_warning'), 'info');
    }
  } catch (err) {
    clip.status = 'error';
    clip.error = err?.userMessage || err?.message || 'error';
    handleError(err);
  }
  renderAudioClips();
}

async function handleAudioFileImport(fileList) {
  for (const file of Array.from(fileList || []).slice(0, 4)) {
    if (file.size > 24 * 1024 * 1024) {
      toast(t('errors.file_too_large', { max: '24 Mo' }), 'warning');
      continue;
    }
    const ext = mimeToExt(file.type) || file.name.split('.').pop()?.toLowerCase() || 'mp3';
    const clip = {
      id: uid(),
      blob: file,
      url: URL.createObjectURL(file),
      mime: file.type || `audio/${ext}`,
      ext,
      duration: 0,
      label: file.name,
      status: navigator.onLine ? 'pending' : 'offline',
      transcript: '',
      liveDraft: '',
      provider: '',
      error: '',
    };
    audioChunksBlobs.push(clip);
    document.getElementById('rec-chunks-badge').textContent = `${audioChunksBlobs.length} segman`;
    renderAudioClips();
    if (navigator.onLine) {
      enqueueTranscription(clip);
    }
  }
}

/* ------------------------------------------------------------------
   Import PDF / image
   ------------------------------------------------------------------ */
async function handleImportFiles(fileList) {
  const statusEl = document.getElementById('import-status');
  for (const file of Array.from(fileList || [])) {
    if (file.type === 'application/pdf') {
      if (!checkFileSize(file, 'pdf')) continue;
      importedFiles.push({ file, kind: 'pdf' });
      statusEl.textContent = `${file.name} — ap li tèks PDF la...`;
      try {
        const { text, pages } = await extractPdfText(file);
        if (text && text.length > 40) {
          const area = document.getElementById('raw-text');
          area.value = `${area.value}\n\n${text}`.trim();
          updateRawWordCount();
          statusEl.textContent = `${file.name} (${pages} paj) enpòte avèk siksè.`;
        } else if (navigator.onLine) {
          statusEl.textContent = `${file.name} sanble yon PDF imaj. Ap li paj 1 ak IA...`;
          const blob = await renderPdfPageToBlob(file, 1);
          if (blob) {
            const b64 = await blobToBase64(blob);
            const ocr = await ocrBoard({
              imagesBase64: [b64],
              language: document.getElementById('note-lang').value,
              faculty: profileRef?.faculty_id,
              level: profileRef?.level,
            });
            if (ocr?.text) {
              const area = document.getElementById('raw-text');
              area.value = `${area.value}\n\n${ocr.text}`.trim();
              updateRawWordCount();
              renderUncertainItems(ocr.uncertain || []);
            }
            statusEl.textContent = `${file.name} li ak IA.`;
          }
        }
      } catch (err) {
        handleError(err);
      }
    } else if (file.type.startsWith('image/')) {
      await handlePhotoFiles([file]);
      switchMode('photo');
    } else if (file.type.startsWith('audio/') || /\.(mp3|m4a|mp4|wav|ogg|webm|aac|flac|opus)$/i.test(file.name)) {
      await handleAudioFileImport([file]);
      switchMode('audio');
    }
  }
}

/* ------------------------------------------------------------------
   Traitement IA de la note (structuration + harmonisation)
   ------------------------------------------------------------------ */
async function runStructureAi(mode = 'standard', btnEl = null) {
  const raw = document.getElementById('raw-text').value.trim();
  if (!raw) {
    toast(t('errors.required'), 'warning');
    return;
  }
  setLoading(btnEl, true);
  try {
    const res = await processNote({
      rawText: raw,
      language: document.getElementById('note-lang').value,
      faculty: profileRef?.faculty_id || 'autre',
      level: profileRef?.level || 'L1',
      courses: coursesList,
      mode,
    });
    structuredData = res;
    if (res.title) document.getElementById('note-title').value = res.title;
    if (res.content_html && quill) {
      quill.root.innerHTML = sanitizeHtml(res.content_html);
    }

    if (res.suggested_course_id && !document.getElementById('note-course').value) {
      const matched = coursesList.find((c) => c.id === res.suggested_course_id);
      if (matched) {
        suggestedCourseId = matched.id;
        document.getElementById('course-suggestion-text').textContent = t('capture.suggested_course', { course: matched.name });
        document.getElementById('course-suggestion-box').hidden = false;
      }
    }

    renderStructuredExtras(res);
    toast(t('common.saved'), 'success');
  } catch (err) {
    handleError(err);
  } finally {
    setLoading(btnEl, false);
  }
}

function renderStructuredExtras(st) {
  const box = document.getElementById('structured-preview');
  if (!st) { box.hidden = true; return; }
  box.hidden = false;
  const takeaways = Array.isArray(st.takeaways) ? st.takeaways : [];
  const implied = Array.isArray(st.implied_points) ? st.implied_points : [];
  const keywords = Array.isArray(st.keywords) ? st.keywords : [];
  box.innerHTML = `
    ${st.summary ? `<div class="card card-sm card-muted"><strong>${esc(t('notes.summary'))}</strong><p class="text-sm mt-1 mb-0">${esc(st.summary)}</p></div>` : ''}
    ${takeaways.length ? `<div class="card card-sm"><strong>${esc(t('notes.takeaways'))}</strong><ul class="text-sm mt-2 mb-0">${takeaways.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${implied.length ? `<div class="ai-suggestion"><div class="ai-suggestion-label">${icon('sparkles')}<span>${esc(t('notes.implied_title'))} — ${esc(t('notes.implied_badge'))}</span></div><ul class="text-sm mt-1 mb-0">${implied.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${keywords.length ? `<div class="row-wrap">${keywords.map((k) => `<span class="badge">${esc(k)}</span>`).join('')}</div>` : ''}`;
  icons(box);
}

/* ------------------------------------------------------------------
   Sauvegarde (En ligne -> Supabase + Storage | Hors-ligne -> IndexedDB)
   ------------------------------------------------------------------ */
async function saveNote() {
  const btn = document.getElementById('save-note-btn');
  const title = document.getElementById('note-title').value.trim() || t('notes.untitled');
  const rawText = document.getElementById('raw-text').value.trim();
  const editorHtml = quill ? sanitizeHtml(quill.root.innerHTML) : '';
  const editorText = htmlToText(editorHtml);
  const finalHtml = editorText ? editorHtml : (rawText ? `<p>${esc(rawText).replace(/\n/g, '</p><p>')}</p>` : '');
  const finalText = editorText || rawText;
  const courseId = document.getElementById('note-course').value || null;
  const unitId = document.getElementById('note-unit').value || null;
  const lang = document.getElementById('note-lang').value;

  if (!finalText && !photoBlobs.length && !audioChunksBlobs.length && !importedFiles.length) {
    toast(t('errors.required'), 'warning');
    return;
  }

  setLoading(btn, true);
  const clientId = uid();

  const saveLocallyToQueue = async () => {
    const files = [
      ...photoBlobs.map((p) => ({ kind: 'image', blob: p.blob, mime: 'image/jpeg', ext: 'jpg' })),
      ...audioChunksBlobs.map((a) => ({ kind: 'audio', blob: a.blob, mime: a.mime, ext: a.ext || mimeToExt(a.mime) })),
      ...importedFiles.map((imp) => ({ kind: 'pdf', blob: imp.file, mime: imp.file.type || 'application/pdf', ext: 'pdf' })),
    ];
    await enqueue('note', {
      client_id: clientId,
      course_id: courseId,
      unit_id: unitId,
      title,
      content_html: finalHtml,
      content_text: finalText,
      raw_text: rawText || null,
      language: lang,
      capture_mode: currentMode,
      process_ai: !structuredData && (files.length > 0 || Boolean(rawText)),
      files,
    });
    toast(t('offline.saved_locally'), 'success');
    location.href = appUrl('pages/notes.html');
  };

  // Mode hors-ligne : file d'attente IndexedDB avec les blobs originaux
  if (!navigator.onLine) {
    try {
      await saveLocallyToQueue();
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
    return;
  }

  // Mode en ligne
  try {
    const noteRow = {
      user_id: userRef.id,
      client_id: clientId,
      course_id: courseId,
      unit_id: unitId,
      title,
      content_html: finalHtml,
      content_text: finalText,
      raw_text: rawText || null,
      structured: structuredData || null,
      summary: structuredData?.summary || finalText.slice(0, 260),
      ai_course_suggestion: !courseId ? suggestedCourseId : null,
      language: lang,
      capture_mode: currentMode,
      status: 'ready',
    };

    const { data: saved, error } = await db.from('pran_not_notes').insert(noteRow).select().single();
    if (error) throw error;

    for (let i = 0; i < photoBlobs.length; i++) {
      const path = `${userRef.id}/${saved.id}/photo-${Date.now()}-${i}.jpg`;
      const { error: imgUpErr } = await db.storage.from('pran-not-note-images').upload(path, photoBlobs[i].blob, { contentType: 'image/jpeg' });
      if (imgUpErr) { console.warn('[saveNote] photo upload', imgUpErr); continue; }
      await db.from('pran_not_note_sources').insert({
        user_id: userRef.id,
        note_id: saved.id,
        kind: 'image',
        storage_path: path,
        mime: 'image/jpeg',
        size_bytes: photoBlobs[i].blob.size,
        chunk_index: i,
        ocr_text: rawText || null,
        status: 'done',
      });
    }

    for (let i = 0; i < audioChunksBlobs.length; i++) {
      const clip = audioChunksBlobs[i];
      const baseMime = (clip.mime || 'audio/webm').split(';')[0].trim() || 'audio/webm';
      const ext = clip.ext || mimeToExt(baseMime);
      const path = `${userRef.id}/${saved.id}/audio-${Date.now()}-${i}.${ext}`;
      const cleanBlob = new Blob([clip.blob], { type: baseMime });
      const { error: audUpErr } = await db.storage.from('pran-not-note-audio').upload(path, cleanBlob, { contentType: baseMime });
      if (audUpErr) { console.warn('[saveNote] audio upload', audUpErr); continue; }
      await db.from('pran_not_note_sources').insert({
        user_id: userRef.id,
        note_id: saved.id,
        kind: 'audio',
        storage_path: path,
        mime: baseMime,
        size_bytes: clip.blob.size,
        chunk_index: i,
        duration_seconds: clip.duration || null,
        transcript: clip.transcript || rawText || null,
        status: 'done',
      });
    }

    for (let i = 0; i < importedFiles.length; i++) {
      const imp = importedFiles[i];
      const path = `${userRef.id}/${saved.id}/doc-${Date.now()}-${i}.pdf`;
      const { error: pdfUpErr } = await db.storage.from('pran-not-syllabi').upload(path, imp.file, { contentType: 'application/pdf' });
      if (pdfUpErr) { console.warn('[saveNote] pdf upload', pdfUpErr); continue; }
      await db.from('pran_not_note_sources').insert({
        user_id: userRef.id,
        note_id: saved.id,
        kind: 'pdf',
        storage_path: path,
        mime: 'application/pdf',
        size_bytes: imp.file.size,
        chunk_index: i,
        status: 'done',
      });
    }

    if (Array.isArray(structuredData?.keywords)) {
      for (const kw of structuredData.keywords.slice(0, 10)) {
        const term = String(kw || '').trim();
        if (!term) continue;
        await db.from('pran_not_keywords').insert({
          user_id: userRef.id,
          course_id: courseId,
          unit_id: unitId,
          note_id: saved.id,
          term,
        }).then(() => {});
      }
    }

    await cacheSet(`note_${saved.id}`, saved);
    await recordActivity();
    await awardXp(15, 'note_capture', saved.id);
    toast(t('common.saved'), 'success');
    location.href = appUrl(`pages/note-view.html?id=${saved.id}`);
  } catch (err) {
    if (isNetworkError(err)) {
      try {
        await saveLocallyToQueue();
        return;
      } catch (qErr) {
        handleError(qErr);
      }
    } else {
      handleError(err);
    }
    setLoading(btn, false);
  }
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  profileRef = profile;

  await initAppChrome({ profile, user, active: 'notes', showFab: false });
  setTutorContext({ contextType: 'general', contextTitle: t('capture.page_title') });
  pageEnter();

  // Câbler immédiatement tous les contrôles de capture (sans attendre le chargement du CDN Quill)
  switchMode(getParam('mode') || 'photo');
  drawIdleMeter();

  // Enpòtasyon Word — si yon tèks vini de settings.html via sessionStorage
  if (getParam('from_import') === '1') {
    const importedText = sessionStorage.getItem('import_word_text');
    const importedFilename = sessionStorage.getItem('import_word_filename');
    if (importedText) {
      sessionStorage.removeItem('import_word_text');
      sessionStorage.removeItem('import_word_filename');
      // Chanje mode a "text" epi pré-ranpli zone tèks lan
      switchMode('text');
      // Tann Quill chaje
      await new Promise((r) => setTimeout(r, 800));
      const editor = document.querySelector('.ql-editor');
      if (editor) {
        editor.innerHTML = importedText.split('\n\n').map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
      }
      const titleInput = document.getElementById('note-title');
      if (titleInput && importedFilename) titleInput.value = importedFilename;
      toast(t('capture.import_word_loaded'), 'success');
    }
  }

  document.querySelectorAll('#capture-modes [role="tab"]').forEach((btn) => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  // Photos
  document.getElementById('photo-input').addEventListener('change', (e) => handlePhotoFiles(e.target.files));
  const dropZone = document.getElementById('photo-drop');
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('is-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-over');
    handlePhotoFiles(e.dataTransfer.files);
  });

  document.getElementById('ocr-run-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!photoBlobs.length) return;
    setLoading(btn, true);
    try {
      const b64List = await Promise.all(photoBlobs.slice(0, 5).map((p) => blobToBase64(p.blob)));
      const res = await ocrBoard({
        imagesBase64: b64List,
        language: document.getElementById('note-lang').value,
        faculty: profileRef?.faculty_id,
        level: profileRef?.level,
      });
      if (res?.text) {
        const area = document.getElementById('raw-text');
        area.value = `${area.value}\n\n${res.text}`.trim();
        updateRawWordCount();
      }
      renderUncertainItems(res?.uncertain || []);
      toast(t('common.saved'), 'success');
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  // Audio / Salle de cours
  document.querySelectorAll('#audio-profile-group [data-audio-profile]').forEach((btn) => {
    btn.addEventListener('click', () => setAudioProfile(btn.dataset.audioProfile));
  });
  document.querySelectorAll('#transcribe-mode-group [data-transcribe-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setTranscribePrecision(btn.dataset.transcribeMode));
  });
  document.getElementById('rec-gain-slider')?.addEventListener('input', (e) => {
    micGainMultiplier = Number(e.target.value) || 1.0;
    document.getElementById('rec-gain-val').textContent = `${micGainMultiplier.toFixed(1)}x`;
    if (gainNode) gainNode.gain.value = micGainMultiplier;
  });

  document.getElementById('mic-refresh-btn')?.addEventListener('click', populateMicDevices);
  document.getElementById('rec-start-btn').addEventListener('click', startRecording);
  document.getElementById('rec-pause-btn').addEventListener('click', togglePauseRecording);
  document.getElementById('rec-stop-btn').addEventListener('click', stopRecording);
  document.getElementById('audio-file-input')?.addEventListener('change', (e) => handleAudioFileImport(e.target.files));

  // Import
  document.getElementById('import-input').addEventListener('change', (e) => handleImportFiles(e.target.files));

  // Texte brut & IA
  document.getElementById('raw-text').addEventListener('input', updateRawWordCount);
  document.getElementById('ai-structure-btn').addEventListener('click', (e) => runStructureAi('standard', e.currentTarget));
  document.getElementById('ai-ht-btn').addEventListener('click', (e) => runStructureAi('harmonize_ht', e.currentTarget));
  document.getElementById('ai-fr-btn').addEventListener('click', (e) => runStructureAi('harmonize_fr', e.currentTarget));

  document.getElementById('confirm-course-btn').addEventListener('click', () => {
    if (suggestedCourseId) {
      document.getElementById('note-course').value = suggestedCourseId;
      document.getElementById('note-course').dispatchEvent(new Event('change'));
      document.getElementById('course-suggestion-box').hidden = true;
    }
  });

  document.getElementById('save-note-btn').addEventListener('click', saveNote);
  document.body.dataset.captureReady = '1';

  // Charger l'éditeur Quill et la liste des cours en parallèle sans bloquer la capture vocale/photo
  initQuill().catch(() => {});

  try {
    const cSel = document.getElementById('note-course');
    const preCourse = getParam('course');
    const populateCourses = (list) => {
      coursesList = list || [];
      cSel.innerHTML = `<option value="">${esc(t('common.none'))}</option>`;
      coursesList.forEach((c) => cSel.insertAdjacentHTML('beforeend', `<option value="${esc(c.id)}">${esc(c.name)}</option>`));
      if (preCourse) cSel.value = preCourse;
    };

    const loadUnits = async (cid) => {
      const uSel = document.getElementById('note-unit');
      uSel.innerHTML = `<option value="">${esc(t('common.none'))}</option>`;
      if (!cid) return;
      const cachedUnits = await cacheGet(`course_units_${cid}`);
      if (cachedUnits?.length) {
        cachedUnits.forEach((u) => uSel.insertAdjacentHTML('beforeend', `<option value="${esc(u.id)}">${esc(u.title)}</option>`));
      }
      if (!navigator.onLine) return;
      const { data: uData } = await db.from('pran_not_syllabus_units').select('id, title').eq('course_id', cid).order('position');
      if (uData) {
        await cacheSet(`course_units_${cid}`, uData);
        uSel.innerHTML = `<option value="">${esc(t('common.none'))}</option>`;
        uData.forEach((u) => uSel.insertAdjacentHTML('beforeend', `<option value="${esc(u.id)}">${esc(u.title)}</option>`));
      }
    };

    cSel.addEventListener('change', () => loadUnits(cSel.value));

    const cachedCourses = await cacheGet('courses_list');
    if (cachedCourses?.length) populateCourses(cachedCourses);

    if (navigator.onLine) {
      const { data: cData } = await db.from('pran_not_courses').select('id, name').eq('archived', false).order('name');
      if (cData) {
        await cacheSet('courses_list', cData);
        populateCourses(cData);
      }
    }
    if (preCourse) await loadUnits(preCourse);
  } catch { /* hors-ligne */ }
})();
