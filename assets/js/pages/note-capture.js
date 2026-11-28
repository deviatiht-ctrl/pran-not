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
import { t, getLang } from '../i18n.js';
const currentLang = () => (typeof getLang === 'function' ? getLang() : (localStorage.getItem('prannot.lang') || 'ht'));
import {
  icons, icon, esc, toast, handleError, setLoading, getParam, uid, isUuid,
  compressImage, blobToBase64, checkFileSize, extractPdfText, renderPdfPageToBlob,
  loadScript, loadStyle, CDN, sanitizeHtml, htmlToText, promptDialog, formatDuration, pageEnter, debounce,
  renderMarkdown, openModal, confirmDialog,
} from '../utils.js';
import { ocrBoard, transcribeAudio, processNote, askTutor, correctRawTextSense, generateProfessorQuestions } from '../ai.js';
import { enqueue, isDataSaver, cacheGet, cacheSet, cacheDel, isNetworkError } from '../offline.js';

const db = window.db;
const SEGMENT_ROTATE_SECONDS = 45;

let currentMode = 'photo';
let profileRef = null;
let userRef = null;
let coursesList = [];
let quill = null;
let structuredData = null;
let suggestedCourseId = null;

// Eta modifikasyon nòt ki egziste deja
let editingNoteId = null;
let editingNoteOriginal = null;
let isEditingExisting = false;
let existingPhotos = [];

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

const DRAFT_STORAGE_KEY = 'prannot_note_capture_draft';
let isNoteSaved = false;

// Gestion du WakeLock pour garder l'écran allumé pendant l'enregistrement d'un cours
let wakeLockSentinel = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLockSentinel) {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
      });
    }
  } catch { /* ignore */ }
}

function releaseWakeLock() {
  try {
    wakeLockSentinel?.release();
    wakeLockSentinel = null;
  } catch { /* ignore */ }
}

/** Sauvegarde tous les clips audio en IndexedDB pour ne jamais perdre un segment */
async function persistAudioClipsToStorage() {
  if (isNoteSaved) return;
  try {
    if (!audioChunksBlobs.length) {
      await cacheDel('prannot_audio_draft_clips');
      return;
    }
    const serializable = audioChunksBlobs.map((c) => ({
      id: c.id,
      blob: c.blob,
      mime: c.mime,
      ext: c.ext,
      duration: c.duration,
      status: c.status,
      transcript: c.transcript,
      liveDraft: c.liveDraft,
      provider: c.provider,
      error: c.error,
    }));
    await cacheSet('prannot_audio_draft_clips', serializable);
  } catch (err) {
    console.warn('[audio] persistAudioClipsToStorage failed:', err);
  }
}

/** Restaure les clips audio sauvegardés en IndexedDB si l'étudiant avait quitté la page */
async function restoreAudioDraftFromStorage() {
  if (isEditingExisting || getParam('id')) return false;
  try {
    const savedClips = await cacheGet('prannot_audio_draft_clips');
    if (Array.isArray(savedClips) && savedClips.length > 0) {
      audioChunksBlobs.length = 0;
      for (const sc of savedClips) {
        if (sc.blob) {
          audioChunksBlobs.push({
            id: sc.id || uid(),
            blob: sc.blob,
            url: URL.createObjectURL(sc.blob),
            mime: sc.mime || 'audio/webm',
            ext: sc.ext || 'webm',
            duration: sc.duration || 1,
            status: sc.status || 'pending',
            transcript: sc.transcript || '',
            liveDraft: sc.liveDraft || '',
            provider: sc.provider || '',
            error: sc.error || '',
          });
        }
      }
      renderAudioClips();
      const chunksBadge = document.getElementById('rec-chunks-badge');
      if (chunksBadge) {
        chunksBadge.textContent = t('capture.segment_count', { count: audioChunksBlobs.length }) || `${audioChunksBlobs.length} segman`;
      }
      return true;
    }
  } catch (err) {
    console.warn('[audio] restoreAudioDraftFromStorage failed:', err);
  }
  return false;
}

/** Extrait l'intégralité du texte en direct (titre, texte brut, notes saisies, audio transcrit, OCR) */
function getLiveNoteText() {
  const title = document.getElementById('note-title')?.value || '';
  const rawText = document.getElementById('raw-text')?.value || '';
  const quillText = quill ? htmlToText(quill.root.innerHTML).trim() : '';
  const audioTexts = audioChunksBlobs
    .map((c, i) => c.transcript ? `[Segman ${i + 1}] ${c.transcript}` : (c.liveDraft ? `[Segman ${i + 1} an dirèk] ${c.liveDraft}` : ''))
    .filter(Boolean)
    .join('\n');
  const photoTexts = photoBlobs
    .map((p, i) => p.ocrText ? `[Foto ${i + 1}] ${p.ocrText}` : '')
    .filter(Boolean)
    .join('\n');

  const parts = [];
  if (title) parts.push(`Tit kou a : ${title}`);
  if (rawText) parts.push(`Tèks nòt brit :\n${rawText}`);
  if (quillText && quillText !== rawText) parts.push(`Nòt estriktire :\n${quillText}`);
  if (audioTexts) parts.push(`Transkripsyon odyo kou a :\n${audioTexts}`);
  if (photoTexts) parts.push(`Tèks ekstrè nan foto tablo yo :\n${photoTexts}`);

  return parts.join('\n\n').trim();
}

/** Synchronise le tuteur IA avec le texte en temps réel */
function syncLiveTutorContext() {
  const liveText = getLiveNoteText();
  const title = document.getElementById('note-title')?.value || t('capture.page_title');
  setTutorContext({
    contextType: 'note_draft',
    contextTitle: title,
    contextText: liveText,
    courseId: document.getElementById('note-course')?.value || null,
  });
}

function saveDraftToStorage() {
  if (isNoteSaved) return;
  try {
    const title = document.getElementById('note-title')?.value || '';
    const rawText = document.getElementById('raw-text')?.value || '';
    const quillHtml = quill?.root?.innerHTML || '';
    const courseId = document.getElementById('note-course')?.value || '';
    const unitId = document.getElementById('note-unit')?.value || '';
    const lang = document.getElementById('note-lang')?.value || 'fr';

    // Si tout vid, pa bezwen sove anyen
    const hasText = title.trim() || rawText.trim() || htmlToText(quillHtml).trim();
    if (!hasText && !structuredData && !audioChunksBlobs.length) {
      if (isEditingExisting && editingNoteId) {
        localStorage.removeItem(`prannot_edit_draft_${editingNoteId}`);
      } else {
        localStorage.removeItem(DRAFT_STORAGE_KEY);
      }
      cacheDel('prannot_audio_draft_clips').catch(() => {});
      return;
    }

    const payload = {
      title,
      rawText,
      quillHtml: htmlToText(quillHtml).trim() ? quillHtml : '',
      courseId,
      unitId,
      lang,
      currentMode,
      structuredData: structuredData || null,
      savedAt: Date.now(),
    };
    if (isEditingExisting && editingNoteId) {
      localStorage.setItem(`prannot_edit_draft_${editingNoteId}`, JSON.stringify(payload));
    } else {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
    }
    persistAudioClipsToStorage();
    syncLiveTutorContext();
  } catch (e) {
    /* ignore storage quota */
  }
}

function clearDraftStorage() {
  try {
    if (isEditingExisting && editingNoteId) {
      localStorage.removeItem(`prannot_edit_draft_${editingNoteId}`);
    }
    const existing = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (existing) {
      try {
        const hist = JSON.parse(localStorage.getItem('prannot.draft_history') || '[]');
        const parsed = JSON.parse(existing);
        if (parsed && (parsed.title || parsed.rawText || parsed.quillHtml)) {
          hist.unshift({ ...parsed, archivedAt: Date.now(), source: 'capture' });
          localStorage.setItem('prannot.draft_history', JSON.stringify(hist.slice(0, 15)));
        }
      } catch {}
    }
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    cacheDel('prannot_audio_draft_clips').catch(() => {});
  } catch { /* ignore */ }
}

async function startFreshNote(skipConfirm = false) {
  const title = document.getElementById('note-title')?.value || '';
  const rawText = document.getElementById('raw-text')?.value || '';
  const quillText = quill ? htmlToText(quill.root.innerHTML).trim() : '';
  const hasContent = Boolean(title.trim() || rawText.trim() || quillText || photoBlobs.length || audioChunksBlobs.length || importedFiles.length || structuredData);

  if (!skipConfirm && hasContent) {
    const ok = await confirmDialog({
      title: t('notes.new_fresh'),
      message: t('notes.discard_fresh_confirm'),
      danger: true,
    });
    if (!ok) return;
  }

  isNoteSaved = true;
  clearDraftStorage();

  const titleInput = document.getElementById('note-title');
  if (titleInput) titleInput.value = '';

  const rawEl = document.getElementById('raw-text');
  if (rawEl) {
    rawEl.value = '';
    updateRawWordCount();
  }

  if (quill?.root) {
    quill.root.innerHTML = '';
  }

  photoBlobs.length = 0;
  renderPhotoThumbs();

  audioChunksBlobs.length = 0;
  renderAudioClips();

  importedFiles.length = 0;
  const impStatus = document.getElementById('import-status');
  if (impStatus) impStatus.textContent = '';

  structuredData = null;
  const structPrev = document.getElementById('structured-preview');
  if (structPrev) {
    structPrev.innerHTML = '';
    structPrev.hidden = true;
  }

  const courseSug = document.getElementById('course-suggestion-box');
  if (courseSug) courseSug.hidden = true;
  suggestedCourseId = null;

  const draftBanner = document.getElementById('draft-alert-banner');
  if (draftBanner) draftBanner.hidden = true;

  // Reyajiste eta modifikasyon nòt ki egziste deja
  isEditingExisting = false;
  editingNoteId = null;
  editingNoteOriginal = null;
  existingPhotos = [];
  const editBanner = document.getElementById('edit-note-banner');
  if (editBanner) editBanner.hidden = true;
  const existBox = document.getElementById('existing-photos-box');
  if (existBox) existBox.hidden = true;
  const hSave = document.getElementById('header-save-note-btn');
  if (hSave?.querySelector('span')) hSave.querySelector('span').textContent = t('capture.save_note') || 'Anrejistre nòt la';
  const mSave = document.getElementById('save-note-btn');
  if (mSave?.querySelector('span')) mSave.querySelector('span').textContent = t('capture.save_note') || 'Anrejistre nòt la';
  try {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('id');
    cleanUrl.searchParams.delete('edit');
    cleanUrl.searchParams.set('new', '1');
    window.history.replaceState({}, '', cleanUrl.toString());
  } catch {}

  setTimeout(() => {
    isNoteSaved = false;
  }, 100);

  toast(t('notes.draft_cleared'), 'info');
}

function restoreDraftFromStorage() {
  if (isEditingExisting || getParam('id')) return false;
  try {
    const restoreParam = getParam('restoreDraft');
    if (!restoreParam && (getParam('new') === '1' || getParam('reset') === '1')) {
      try {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('new');
        cleanUrl.searchParams.delete('reset');
        window.history.replaceState({}, '', cleanUrl.toString());
      } catch {}
      return false;
    }

    let d = null;
    if (restoreParam) {
      if (restoreParam === 'draft:capture') {
        const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
        if (raw) d = JSON.parse(raw);
      } else if (restoreParam.startsWith('draft:hist:')) {
        const idx = parseInt(restoreParam.replace('draft:hist:', ''), 10);
        const hist = JSON.parse(localStorage.getItem('prannot.draft_history') || '[]');
        if (hist[idx]) d = hist[idx];
      } else if (restoreParam.startsWith('draft:other:')) {
        const raw = localStorage.getItem(restoreParam.replace('draft:other:', ''));
        if (raw) d = JSON.parse(raw);
      }
      try {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('restoreDraft');
        window.history.replaceState({}, '', cleanUrl.toString());
      } catch {}
    }

    if (!d) {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return false;
      d = JSON.parse(raw);
    }
    if (!d) return false;

    // Pa restore si draft otomatik la gen plis pase 7 jou (sèlman si se pa yon restoreDraft manyèl)
    if (!restoreParam && Date.now() - (d.savedAt || 0) > 7 * 86400000) {
      clearDraftStorage();
      return false;
    }

    let restored = false;
    if (d.title) {
      const titleInput = document.getElementById('note-title');
      if (titleInput && !titleInput.value.trim()) {
        titleInput.value = d.title;
        restored = true;
      }
    }
    if (d.rawText) {
      const rawEl = document.getElementById('raw-text');
      if (rawEl && !rawEl.value.trim()) {
        rawEl.value = d.rawText;
        updateRawWordCount();
        restored = true;
      }
    }
    if (d.quillHtml && quill) {
      const cur = htmlToText(quill.root.innerHTML).trim();
      if (!cur) {
        quill.root.innerHTML = sanitizeHtml(d.quillHtml);
        restored = true;
      }
    }
    if (d.courseId) {
      const cEl = document.getElementById('note-course');
      if (cEl) {
        cEl.value = d.courseId;
        cEl.dispatchEvent(new Event('change'));
      }
    }
    if (d.lang) {
      const lEl = document.getElementById('note-lang');
      if (lEl) lEl.value = d.lang;
    }
    if (d.structuredData) {
      structuredData = d.structuredData;
      renderStructuredExtras(structuredData);
      restored = true;
    }
    if (d.currentMode && d.currentMode !== currentMode) {
      switchMode(d.currentMode);
    }
    return restored;
  } catch {
    return false;
  }
}

/**
 * Chaje yon nòt ki te deja egziste pou pèmèt etidyan an modifye l,
 * kontinye anrejistre odyo kou a, ajoute nouvo foto tablo, oswa poze IA kesyon.
 */
async function loadExistingNoteForEditing(noteId) {
  if (!noteId) return;
  try {
    let noteData = await cacheGet(`note_${noteId}`);
    if (navigator.onLine && isUuid(noteId)) {
      try {
        const { data, error } = await db.from('pran_not_notes').select('*').eq('id', noteId).single();
        if (!error && data) {
          noteData = data;
          await cacheSet(`note_${noteId}`, data);
        }
      } catch (dbErr) {
        console.warn('[note-capture] DB fetch note error:', dbErr);
      }
    }

    if (!noteData) {
      const cachedNotes = (await cacheGet(`notes_list_${userRef?.id || ''}`)) || (await cacheGet('notes_list')) || [];
      noteData = cachedNotes.find((n) => n.id === noteId);
    }

    if (!noteData) {
      console.warn('[note-capture] Note to edit not found in cache or DB:', noteId);
      return;
    }

    isEditingExisting = true;
    editingNoteId = noteId;
    editingNoteOriginal = noteData;

    const isFr = currentLang() === 'fr';

    // Ranpli chan debaz yo
    const titleInput = document.getElementById('note-title');
    if (titleInput) titleInput.value = noteData.title || '';

    const rawEl = document.getElementById('raw-text');
    if (rawEl) {
      rawEl.value = noteData.raw_text || noteData.content_text || htmlToText(noteData.content_html || '') || '';
      updateRawWordCount();
    }

    if (noteData.course_id) {
      const courseSel = document.getElementById('note-course');
      if (courseSel) {
        courseSel.value = noteData.course_id;
        courseSel.dispatchEvent(new Event('change'));
      }
    }

    if (noteData.unit_id) {
      setTimeout(() => {
        const unitSel = document.getElementById('note-unit');
        if (unitSel) unitSel.value = noteData.unit_id;
      }, 400);
    }

    if (noteData.language) {
      const langSel = document.getElementById('note-lang');
      if (langSel) langSel.value = noteData.language;
    }

    if (noteData.structured) {
      structuredData = noteData.structured;
      renderStructuredExtras(structuredData);
    }

    if (quill?.root) {
      if (noteData.content_html) {
        quill.root.innerHTML = sanitizeHtml(noteData.content_html);
      } else if (noteData.content_text) {
        quill.setText(noteData.content_text);
      }
    }

    // Afiche banner modifikasyon
    const editBanner = document.getElementById('edit-note-banner');
    if (editBanner) {
      editBanner.hidden = false;
      const bTitle = document.getElementById('edit-note-banner-title');
      if (bTitle) bTitle.textContent = isFr
        ? `Mode Modification : ${noteData.title || t('notes.untitled')}`
        : `Mòd Modifikasyon : ${noteData.title || t('notes.untitled')}`;
      const cancelBtn = document.getElementById('edit-cancel-view-btn');
      if (cancelBtn) cancelBtn.href = `./note-view.html?id=${encodeURIComponent(noteId)}`;
      icons(editBanner);
    }

    // Chanje tèks bouton anrejistre yo
    const saveLabel = isFr ? 'Mettre à jour la note' : 'Mete nòt la a jou';
    const headerSaveBtn = document.getElementById('header-save-note-btn');
    if (headerSaveBtn) {
      const sp = headerSaveBtn.querySelector('span');
      if (sp) sp.textContent = saveLabel;
    }
    const mainSaveBtn = document.getElementById('save-note-btn');
    if (mainSaveBtn) {
      const sp = mainSaveBtn.querySelector('span');
      if (sp) sp.textContent = saveLabel;
    }

    // Kache banner bwouyon nòmal la
    const draftBanner = document.getElementById('draft-alert-banner');
    if (draftBanner) draftBanner.hidden = true;

    // Chaje foto ki te deja anrejistre nan nòt sa a
    loadExistingSources(noteId);

    // Chwazi mòd ki mande nan URL la oswa mòd nòt la
    const requestedMode = getParam('mode');
    if (requestedMode) {
      switchMode(requestedMode);
    } else if (getParam('edit') === '1') {
      switchMode('text');
    } else if (noteData.capture_mode) {
      switchMode(noteData.capture_mode);
    } else {
      switchMode('text');
    }

    syncLiveTutorContext();
    toast(isFr ? `Note prête pour modification !` : `Nòt "${noteData.title || ''}" pare pou modifikasyon !`, 'info');
  } catch (err) {
    console.warn('[note-capture] loadExistingNoteForEditing error:', err);
  }
}

/** Chaje sous foto ki te deja nan nòt la */
async function loadExistingSources(noteId) {
  try {
    let sources = [];
    if (navigator.onLine && isUuid(noteId)) {
      const { data } = await db.from('pran_not_note_sources').select('*').eq('note_id', noteId);
      if (Array.isArray(data)) sources = data;
    }
    const imageSources = sources.filter((s) => s.kind === 'image');
    if (!imageSources.length) return;

    existingPhotos = imageSources;
    const box = document.getElementById('existing-photos-box');
    const thumbsGrid = document.getElementById('existing-photo-thumbs');
    const countBadge = document.getElementById('existing-photos-count');

    if (box && thumbsGrid) {
      box.hidden = false;
      if (countBadge) countBadge.textContent = `${imageSources.length} foto`;
      thumbsGrid.innerHTML = imageSources.map((s, idx) => {
        let srcUrl = s.storage_path;
        if (s.storage_path && !s.storage_path.startsWith('http') && !s.storage_path.startsWith('data:')) {
          const { data } = db.storage.from('pran-not-note-images').getPublicUrl(s.storage_path);
          srcUrl = data?.publicUrl || s.storage_path;
        }
        return `
          <div class="thumb" title="Foto #${idx + 1}" style="position:relative;">
            <img src="${esc(srcUrl)}" alt="Foto tablo #${idx + 1}" loading="lazy">
            <span class="badge badge-xs" style="position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,0.65);color:#fff;">#${idx + 1}</span>
          </div>
        `;
      }).join('');
      icons(box);
    }
  } catch (err) {
    console.warn('[note-capture] loadExistingSources error:', err);
  }
}

async function initQuill() {
  try {
    loadStyle(CDN.quillCss);
    await loadScript(CDN.quillJs);
    quill = new window.Quill('#quill-editor', {
      theme: 'snow',
      placeholder: t('capture.mode_text_sub'),
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', { background: [] }],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['blockquote', 'code-block', 'clean'],
        ],
      },
    });
    quill.on('text-change', debounce(saveDraftToStorage, 1500));
  } catch {
    // Repli hors-ligne si Quill CDN n'était pas encore en cache
    const host = document.getElementById('quill-editor');
    if (host && !host.querySelector('textarea')) {
      host.innerHTML = `<textarea class="textarea" id="quill-fallback-ta" rows="10" placeholder="${esc(t('capture.mode_text_sub'))}"></textarea>`;
      host.querySelector('#quill-fallback-ta')?.addEventListener('input', debounce(saveDraftToStorage, 1500));
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
  const hasRawContent = Boolean(document.getElementById('raw-text')?.value?.trim());
  document.getElementById('raw-section').hidden = (currentMode === 'text' && !isEditingExisting && !hasRawContent);

  const hint = document.getElementById('audio-live-hint');
  if (currentMode === 'flash') {
    hint.textContent = t('capture.hint_flash');
    if (!isRecordingSession) setAudioProfile('close');
  } else if (currentMode === 'audio') {
    hint.textContent = t('capture.hint_classroom');
    if (!isRecordingSession) setAudioProfile('classroom');
  }
  if (currentMode === 'audio' || currentMode === 'flash') {
    populateMicDevices();
  }
}

function updateRawWordCount() {
  const txt = document.getElementById('raw-text').value.trim();
  const words = txt ? txt.split(/\s+/).length : 0;
  document.getElementById('raw-count').textContent = t('capture.word_count', { count: words }) || `${words} ${currentLang() === 'fr' ? 'mots' : 'mo'}`;
}

function renderPhotoThumbs() {
  const grid = document.getElementById('photo-thumbs');
  if (!grid) return;
  grid.innerHTML = photoBlobs.map((p, idx) => `
    <div class="thumb" title="${esc(p.name || '')}">
      <img src="${esc(p.url)}" alt="${currentLang() === 'fr' ? 'Photo' : 'Foto'} ${idx + 1}" loading="lazy">
      <button type="button" class="btn-icon" data-rm-photo="${idx}" aria-label="${esc(t('common.delete'))}">${icon('x')}</button>
    </div>`).join('');
  grid.querySelectorAll('[data-rm-photo]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.rmPhoto);
      if (photoBlobs[i]?.url) URL.revokeObjectURL(photoBlobs[i].url);
      photoBlobs.splice(i, 1);
      renderPhotoThumbs();
    });
  });
  const ocrBtn = document.getElementById('ocr-run-btn');
  if (ocrBtn) ocrBtn.disabled = photoBlobs.length === 0;
  icons(grid);
}

async function handlePhotoFiles(fileList) {
  const files = Array.from(fileList || []).slice(0, 10);
  if (!files.length) return;

  const enhance = document.getElementById('opt-enhance')?.checked || false;
  const autoCrop = document.getElementById('opt-autocrop')?.checked || false;
  const maxSize = isDataSaver() ? 1200 : 1600;
  const quality = isDataSaver() ? 0.6 : 0.75;

  const grid = document.getElementById('photo-thumbs');
  const loaderId = `photo-loading-${Date.now()}`;
  if (grid) {
    grid.insertAdjacentHTML('beforeend', `
      <div class="thumb" id="${loaderId}" style="display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--c-surface-2);border:2px dashed var(--c-accent);border-radius:12px;color:var(--c-accent);padding:8px;font-size:0.75rem;text-align:center;">
        <span class="spinner mb-1" style="width:18px;height:18px;border-width:2px;"></span>
        <span>Ap monte...</span>
      </div>`);
  }

  let addedCount = 0;
  try {
    for (const file of files) {
      if (!checkFileSize(file, 'image')) continue;
      try {
        let blob;
        try {
          blob = await compressImage(file, { maxSize, quality, enhance, autoCrop });
        } catch (cErr) {
          console.warn('[handlePhotoFiles] compressImage error, using original file blob:', cErr);
          blob = file;
        }

        const mime = blob.type || file.type || 'image/jpeg';
        const url = URL.createObjectURL(blob);
        photoBlobs.push({
          blob,
          url,
          name: file.name,
          mime,
        });
        addedCount++;
      } catch (err) {
        console.warn('[handlePhotoFiles] failed processing file, trying raw fallback:', err);
        try {
          const url = URL.createObjectURL(file);
          photoBlobs.push({ blob: file, url, name: file.name, mime: file.type || 'image/jpeg' });
          addedCount++;
        } catch (e2) {
          handleError(err);
        }
      }
    }
  } finally {
    const loaderEl = document.getElementById(loaderId);
    if (loaderEl) loaderEl.remove();
    renderPhotoThumbs();
  }

  if (addedCount > 0) {
    toast(currentLang() === 'fr' ? `${addedCount} photo(s) ajoutée(s)` : `${addedCount} foto ajoute avèk siksè`, 'success');
  }
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

    // Profil "Direct" ou mikwofòn ekstèn USB/Wireless (DJI Mic, Rode, etc.) :
    // Si l'utilisateur a choisi direct ou si le flux provient d'un micro dédié,
    // enregistrer directement le flux natif pour éviter les artefacts de resynchronisation Web Audio
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
  // Seule la langue française a un modèle Web Speech standard fiable dans Chrome.
  // Pour le Kreyòl ayisyen, on s'appuie directement sur Whisper large-v3 & Gemini Audio
  // pour éviter que Chrome n'invente des mots français sans queue ni tête.
  if (!SR || !navigator.onLine || !box || !prev || langVal === 'ht') return;
  try {
    speechRecognition = new SR();
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = 'fr-FR';
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

  rec.onerror = (e) => {
    console.warn('[audio] MediaRecorder error event:', e);
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
        status: 'pending',
        transcript: '',
        liveDraft: capturedLiveDraft(),
        provider: '',
        error: '',
      };
      liveSpeechBuffer = '';
      audioChunksBlobs.push(clip);
      const chunksBadge = document.getElementById('rec-chunks-badge');
      if (chunksBadge) chunksBadge.textContent = t('capture.segment_count', { count: audioChunksBlobs.length }) || `${audioChunksBlobs.length} ${currentLang() === 'fr' ? 'segments' : 'segman'}`;
      renderAudioClips();
      saveDraftToStorage();

      // Si l'enregistrement continue, différer la transcription lourde vers la fin ou la traiter en douceur
      // pour éviter de saturer le CPU/mémoire de l'appareil pendant la capture continue
      if (navigator.onLine) {
        enqueueTranscription(clip);
      } else {
        clip.status = 'offline';
        renderAudioClips();
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
  if (!isRecordingSession || !mediaRecorder) return;
  const oldRec = mediaRecorder;
  segmentSeconds = totalSeconds;

  // D'abord forcer la récupération de toutes les données du segman aktyèl la
  try {
    if (oldRec && oldRec.state === 'recording') {
      oldRec.requestData();
    }
  } catch { /* ignore */ }

  try {
    mediaRecorder = spawnSegmentRecorder(recordStream, mime);
  } catch (err) {
    console.warn('[audio] Failed to spawn new segment recorder', err);
  }

  try {
    if (oldRec && oldRec.state !== 'inactive') {
      oldRec.stop();
    }
  } catch { /* ignore */ }
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast(t('notes.mic_unsupported'), 'error');
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

    // Si yon mikwofòn ekstèn (tankou DJI Mic) debranche pandan anrejistreman an ap fèt :
    // Pa kite sesyon an plante ni disparèt ! Rekipere odyo ki deja la a imedyatman.
    rawMicStream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (isRecordingSession) {
          console.warn('[audio] Track ended unexpectedly (mic unplugged or interrupted). Safeguarding audio...');
          toast(t('notes.mic_disconnected_saved'), 'warning');
          stopRecording();
          saveDraftToStorage();
        }
      };
    });
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

  // Garder l'écran et le processus actifs
  acquireWakeLock();
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
  releaseWakeLock();

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

/**
 * Relance automatiquement toutes les transcriptions audio en attente ou en erreur
 * dès que la connexion Internet est rétablie sans que l'étudiant ait besoin de cliquer.
 */
let isAutoRetryingTranscriptions = false;
export async function autoRetryPendingTranscriptions() {
  if (!navigator.onLine || isAutoRetryingTranscriptions) return;
  const pendingClips = audioChunksBlobs.filter((c) => c.status === 'error' || c.status === 'offline' || c.status === 'pending');
  if (!pendingClips.length) return;

  isAutoRetryingTranscriptions = true;
  toast('Koneksyon retounen : retranskripsyon segman odyo yo ap relanse otomatikman...', 'info');

  try {
    for (const clip of pendingClips) {
      if (!navigator.onLine) break;
      await enqueueTranscription(clip, true);
    }
  } catch (err) {
    console.warn('[audio] autoRetryPendingTranscriptions failed:', err);
  } finally {
    isAutoRetryingTranscriptions = false;
  }
}

window.addEventListener('online', () => {
  autoRetryPendingTranscriptions();
});

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
      saveDraftToStorage();
      toast(isRetry ? 'Transkripsyon an mete ajou.' : 'Transkripsyon an ajoute.', 'success');
    } else {
      toast(t('capture.audio_silent_warning'), 'info');
    }
  } catch (err) {
    clip.status = 'error';
    clip.error = err?.userMessage || err?.message || 'error';
    // Si la transcription échoue (ex: réseau faible ou coupure), récupérer le liveDraft pour ne jamais perdre le texte
    if (clip.liveDraft && !clip.transcript) {
      clip.transcript = clip.liveDraft;
      const area = document.getElementById('raw-text');
      if (area) {
        area.value = `${area.value}\n\n${clip.liveDraft}`.trim();
        updateRawWordCount();
      }
      saveDraftToStorage();
      toast('Transkripsyon lokal rekipere pou pa pèdi nòt la.', 'info');
    } else {
      handleError(err);
    }
  }
  renderAudioClips();
  saveDraftToStorage();
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
    const cBadge = document.getElementById('rec-chunks-badge');
    if (cBadge) cBadge.textContent = t('capture.segment_count', { count: audioChunksBlobs.length }) || `${audioChunksBlobs.length} ${currentLang() === 'fr' ? 'segments' : 'segman'}`;
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
    } else if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|bmp|gif)$/i.test(file.name)) {
      await handlePhotoFiles([file]);
      switchMode('photo');
    } else if (file.type.startsWith('audio/') || /\.(mp3|m4a|mp4|wav|ogg|webm|aac|flac|opus)$/i.test(file.name)) {
      await handleAudioFileImport([file]);
      switchMode('audio');
    }
  }
}

/* ------------------------------------------------------------------
   Traitement IA de la note (structuration + harmonisation bilingue)
   ------------------------------------------------------------------ */
async function runStructureAi(mode = 'standard', btnEl = null) {
  let raw = document.getElementById('raw-text').value.trim();
  if (!raw && quill) {
    raw = htmlToText(quill.root.innerHTML).trim();
  }
  if (!raw && editingNoteOriginal?.content_text) {
    raw = editingNoteOriginal.content_text.trim();
  }
  if (!raw && editingNoteOriginal?.content_html) {
    raw = htmlToText(editingNoteOriginal.content_html).trim();
  }
  if (!raw) {
    toast(t('errors.required'), 'warning');
    return;
  }
  setLoading(btnEl, true);
  try {
    const chosenLang = document.getElementById('note-lang').value;
    const res = await processNote({
      rawText: raw,
      language: chosenLang,
      faculty: profileRef?.faculty_id || 'autre',
      level: profileRef?.level || 'L1',
      courses: coursesList,
      mode: mode === 'bilingual' ? 'bilingual' : mode,
    });
    structuredData = {
      ...res,
      content_html_ht: res.content_html_ht || '',
      simple_explanation_fr: res.simple_explanation_fr || '',
      simple_explanation_ht: res.simple_explanation_ht || '',
      exam_qa: Array.isArray(res.exam_qa) ? res.exam_qa : [],
      questions_for_professor: Array.isArray(res.questions_for_professor) ? res.questions_for_professor : [],
    };
    if (res.title) document.getElementById('note-title').value = res.title;
    if (quill) {
      const htmlToSet = (chosenLang === 'ht' && res.content_html_ht) ? res.content_html_ht : (res.content_html || res.content_html_ht);
      if (htmlToSet) quill.root.innerHTML = sanitizeHtml(htmlToSet);
    }

    if (res.suggested_course_id && !document.getElementById('note-course').value) {
      const matched = coursesList.find((c) => c.id === res.suggested_course_id);
      if (matched) {
        suggestedCourseId = matched.id;
        document.getElementById('course-suggestion-text').textContent = t('capture.suggested_course', { course: matched.name });
        document.getElementById('course-suggestion-box').hidden = false;
      }
    }

    renderStructuredExtras(structuredData);
    saveDraftToStorage();
    toast('Nòt la byen estriktire an fòma biling ak tout eksplikasyon ak Q&A!', 'success');
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
  const isFr = currentLang() === 'fr';
  const takeaways = Array.isArray(st.takeaways) ? st.takeaways : [];
  const implied = Array.isArray(st.implied_points) ? st.implied_points : [];
  const keywords = Array.isArray(st.keywords) ? st.keywords : [];
  const examQa = Array.isArray(st.exam_qa) ? st.exam_qa : [];
  const profQ = Array.isArray(st.questions_for_professor) ? st.questions_for_professor : [];

  box.innerHTML = `
    <div class="row-between mb-2">
      <span class="badge badge-primary font-bold">${icon('sparkles')} <span>${isFr ? 'Note Structurée Bilingue & Q&R' : 'Nòt Estriktire Biling & Q&A'}</span></span>
      <span class="badge badge-accent font-bold">${esc(st.provider || 'AI')}</span>
    </div>

    ${st.summary ? `<div class="card card-sm card-muted"><strong>${esc(t('notes.summary'))} (Français)</strong><p class="text-sm mt-1 mb-0">${esc(st.summary)}</p></div>` : ''}
    ${st.summary_ht ? `<div class="card card-sm card-muted mt-2" style="border-left:3px solid var(--c-primary);"><strong>${isFr ? 'Résumé en créole' : 'Rezime an Kreyòl'}</strong><p class="text-sm mt-1 mb-0">${esc(st.summary_ht)}</p></div>` : ''}

    ${(st.simple_explanation_fr || st.simple_explanation_ht) ? `
      <div class="card card-sm mt-2" style="background:var(--c-surface-soft);border-left:4px solid var(--c-accent);">
        <strong>💡 ${isFr ? 'Explication Simple Intégrée (Français & Créole)' : 'Eksplikasyon Senp Entegre (Fransè & Kreyòl)'}</strong>
        ${st.simple_explanation_fr ? `<p class="text-sm mt-1 mb-1"><strong>FR :</strong> ${esc(st.simple_explanation_fr)}</p>` : ''}
        ${st.simple_explanation_ht ? `<p class="text-sm mb-0"><strong>HT :</strong> ${esc(st.simple_explanation_ht)}</p>` : ''}
      </div>` : ''}

    ${examQa.length ? `
      <div class="card card-sm mt-2" style="background:var(--c-surface-soft);border-left:4px solid #10B981;">
        <strong>📝 ${isFr ? `Questions & Réponses Examen (${examQa.length})` : `Kesyon & Repons Egzamen (${examQa.length})`}</strong>
        <ul class="text-sm mt-1 mb-0" style="padding-left:1.2em;">
          ${examQa.slice(0, 3).map(q => `<li><strong>Q :</strong> ${esc(q.question)}</li>`).join('')}
        </ul>
      </div>` : ''}

    ${profQ.length ? `
      <div class="card card-sm mt-2" style="background:var(--c-surface-soft);border-left:4px solid var(--c-primary);">
        <strong>❓ ${isFr ? `Questions à poser au Professeur (${profQ.length})` : `Kesyon pou poze Pwofesè a (${profQ.length})`}</strong>
        <ul class="text-sm mt-1 mb-0" style="padding-left:1.2em;">
          ${profQ.slice(0, 3).map(pq => `<li>${esc(pq.question)}</li>`).join('')}
        </ul>
      </div>` : ''}

    ${takeaways.length ? `<div class="card card-sm mt-2"><strong>${esc(t('notes.takeaways'))}</strong><ul class="text-sm mt-2 mb-0">${takeaways.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${implied.length ? `<div class="ai-suggestion mt-2"><div class="ai-suggestion-label">${icon('sparkles')}<span>${esc(t('notes.implied_title'))} — ${esc(t('notes.implied_badge'))}</span></div><ul class="text-sm mt-1 mb-0">${implied.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${keywords.length ? `<div class="row-wrap mt-2">${keywords.map((k) => `<span class="badge">${esc(k)}</span>`).join('')}</div>` : ''}`;
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

  const targetNoteId = (isEditingExisting && isUuid(editingNoteId)) ? editingNoteId : null;

  if (targetNoteId) {
    const updatePayload = {
      course_id: courseId,
      unit_id: unitId,
      title,
      content_html: finalHtml,
      content_text: finalText,
      raw_text: rawText || null,
      structured: structuredData || editingNoteOriginal?.structured || null,
      summary: structuredData?.summary || finalText.slice(0, 260),
      ai_course_suggestion: !courseId ? suggestedCourseId : null,
      language: lang,
      capture_mode: currentMode,
      updated_at: new Date().toISOString(),
    };

    if (navigator.onLine) {
      try {
        const { error: upErr } = await db.from('pran_not_notes').update(updatePayload).eq('id', targetNoteId);
        if (upErr) throw upErr;

        // Upload nouvo foto si etidyan an te ajoute pandan modifikasyon an
        for (let i = 0; i < photoBlobs.length; i++) {
          const p = photoBlobs[i];
          const rawMime = p.mime || p.blob.type || 'image/jpeg';
          const cleanMime = rawMime.split(';')[0].trim() || 'image/jpeg';
          const ext = cleanMime.includes('png') ? 'png' : cleanMime.includes('webp') ? 'webp' : 'jpg';
          const path = `${userRef.id}/${targetNoteId}/photo-${Date.now()}-${i}.${ext}`;
          let storagePath = path;
          let uploadSuccess = false;
          try {
            const { error: imgUpErr } = await db.storage.from('pran-not-note-images').upload(path, p.blob, {
              contentType: cleanMime,
              upsert: true,
            });
            if (!imgUpErr) uploadSuccess = true;
          } catch {}
          if (!uploadSuccess) {
            try {
              const b64 = await blobToBase64(p.blob);
              if (b64) storagePath = `data:${cleanMime};base64,${b64}`;
            } catch {}
          }
          await db.from('pran_not_note_sources').insert({
            user_id: userRef.id,
            note_id: targetNoteId,
            kind: 'image',
            storage_path: storagePath,
            mime: cleanMime,
            size_bytes: p.blob.size || 0,
            chunk_index: existingPhotos.length + i,
            ocr_text: p.ocrText || null,
            status: 'done',
          }).catch(() => {});
        }

        // Upload nouvo odyo si etidyan an te kontinye anrejistre pandan modifikasyon an
        for (let i = 0; i < audioChunksBlobs.length; i++) {
          const clip = audioChunksBlobs[i];
          const baseMime = (clip.mime || 'audio/webm').split(';')[0].trim() || 'audio/webm';
          const ext = clip.ext || mimeToExt(baseMime);
          const path = `${userRef.id}/${targetNoteId}/audio-${Date.now()}-${i}.${ext}`;
          const cleanBlob = new Blob([clip.blob], { type: baseMime });
          const { error: audUpErr } = await db.storage.from('pran-not-note-audio').upload(path, cleanBlob, { contentType: baseMime });
          if (!audUpErr) {
            await db.from('pran_not_note_sources').insert({
              user_id: userRef.id,
              note_id: targetNoteId,
              kind: 'audio',
              storage_path: path,
              mime: baseMime,
              size_bytes: clip.blob.size,
              chunk_index: i,
              duration_seconds: clip.duration || null,
              transcript: clip.transcript || null,
              status: 'done',
            }).catch(() => {});
          }
        }

        // Upload nouvo dokiman PDF si genyen
        for (let i = 0; i < importedFiles.length; i++) {
          const imp = importedFiles[i];
          const path = `${userRef.id}/${targetNoteId}/doc-${Date.now()}-${i}.pdf`;
          const { error: pdfUpErr } = await db.storage.from('pran-not-syllabi').upload(path, imp.file, { contentType: 'application/pdf' });
          if (!pdfUpErr) {
            await db.from('pran_not_note_sources').insert({
              user_id: userRef.id,
              note_id: targetNoteId,
              kind: 'pdf',
              storage_path: path,
              mime: 'application/pdf',
              size_bytes: imp.file.size,
              chunk_index: i,
              status: 'done',
            }).catch(() => {});
          }
        }

        const mergedNote = { ...(editingNoteOriginal || {}), ...updatePayload, id: targetNoteId };
        await cacheSet(`note_${targetNoteId}`, mergedNote);
        const cachedList = await cacheGet('notes_list');
        if (Array.isArray(cachedList)) {
          await cacheSet('notes_list', cachedList.map((x) => (x.id === targetNoteId ? { ...x, ...updatePayload } : x)));
        }
        localStorage.removeItem(`prannot_edit_draft_${targetNoteId}`);
        await recordActivity();
        isNoteSaved = true;
        toast('Nòt la mete a jou avèk siksè !', 'success');
        location.href = appUrl(`pages/note-view.html?id=${targetNoteId}`);
        return;
      } catch (err) {
        if (!isNetworkError(err)) {
          handleError(err);
          setLoading(btn, false);
          return;
        }
      }
    }

    // Offline update fallback
    const mergedNote = { ...(editingNoteOriginal || {}), ...updatePayload, id: targetNoteId };
    await cacheSet(`note_${targetNoteId}`, mergedNote);
    const cachedList = await cacheGet('notes_list');
    if (Array.isArray(cachedList)) {
      await cacheSet('notes_list', cachedList.map((x) => (x.id === targetNoteId ? { ...x, ...updatePayload } : x)));
    }
    await enqueue('note_update', { id: targetNoteId, ...updatePayload });
    localStorage.removeItem(`prannot_edit_draft_${targetNoteId}`);
    isNoteSaved = true;
    toast(t('offline.saved_locally') || 'Nòt la mete a jou lokalman (offline) !', 'success');
    location.href = appUrl(`pages/note-view.html?id=${targetNoteId}`);
    return;
  }

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
    isNoteSaved = true;
    clearDraftStorage();
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
      const p = photoBlobs[i];
      const rawMime = p.mime || p.blob.type || 'image/jpeg';
      const cleanMime = rawMime.split(';')[0].trim() || 'image/jpeg';
      const ext = cleanMime.includes('png') ? 'png' : cleanMime.includes('webp') ? 'webp' : 'jpg';
      const path = `${userRef.id}/${saved.id}/photo-${Date.now()}-${i}.${ext}`;

      let storagePath = path;
      let uploadSuccess = false;

      try {
        const { error: imgUpErr } = await db.storage.from('pran-not-note-images').upload(path, p.blob, {
          contentType: cleanMime,
          upsert: true,
        });
        if (!imgUpErr) {
          uploadSuccess = true;
        } else {
          console.warn('[saveNote] photo storage upload warning:', imgUpErr);
        }
      } catch (stEx) {
        console.warn('[saveNote] photo storage upload exception:', stEx);
      }

      // Si le stockage distant échoue (ex: bucket privé, permissions ou hors-ligne partiel),
      // encoder en Base64 Data URL afin de ne JAMAIS perdre la photo de l'étudiant.
      if (!uploadSuccess) {
        try {
          const b64 = await blobToBase64(p.blob);
          if (b64) storagePath = `data:${cleanMime};base64,${b64}`;
        } catch (b64Err) {
          console.warn('[saveNote] fallback base64 error:', b64Err);
        }
      }

      try {
        await db.from('pran_not_note_sources').insert({
          user_id: userRef.id,
          note_id: saved.id,
          kind: 'image',
          storage_path: storagePath,
          mime: cleanMime,
          size_bytes: p.blob.size || 0,
          chunk_index: i,
          ocr_text: rawText || null,
          status: 'done',
        });
      } catch (srcErr) {
        console.warn('[saveNote] insert pran_not_note_sources warning:', srcErr);
      }
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
    isNoteSaved = true;
    clearDraftStorage();
    toast(t('common.saved'), 'success');
    location.href = appUrl(`pages/note-view.html?id=${saved.id}`);
  } catch (err) {
    isNoteSaved = false;
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

function insertTextIntoQuill(text) {
  if (!quill) {
    insertTextIntoRaw(text);
    return;
  }
  const sel = quill.getSelection();
  const idx = sel ? sel.index : quill.getLength();
  quill.insertText(idx, '\n' + text + '\n');
  quill.setSelection(idx + text.length + 2);
  saveDraftToStorage();
}

function insertTextIntoRaw(text) {
  const rawEl = document.getElementById('raw-text');
  if (rawEl) {
    rawEl.value = (rawEl.value ? rawEl.value + '\n\n' : '') + text;
    rawEl.dispatchEvent(new Event('input'));
    saveDraftToStorage();
    rawEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/** Correction et harmonisation du sens du texte brut */
async function triggerFixRawSense() {
  const rawEl = document.getElementById('raw-text');
  const textToFix = (rawEl?.value || '').trim() || audioChunksBlobs.map(c => c.transcript || c.liveDraft || '').filter(Boolean).join('\n').trim();
  if (!textToFix) {
    toast('Tape oswa anrejistre kèk nòt anvan pou IA a ka analize epi korije sans lan.', 'warning');
    rawEl?.focus();
    return;
  }

  const btn = document.getElementById('btn-fix-raw-sense');
  if (btn) setLoading(btn, true);

  try {
    const lang = document.getElementById('note-lang')?.value || 'fr';
    const res = await correctRawTextSense({
      rawText: textToFix,
      language: lang,
      faculty: profileRef?.faculty_id,
      level: profileRef?.level,
    });

    if (!res.ok || !res.correctedText) {
      throw new Error(res.message || 'Echèk koreksyon sans la');
    }

    const m = openModal({
      title: 'Koreksyon & Clarifikasyon Sans Tèks la',
      body: `
        <div class="stack py-2">
          <p class="text-sm muted mb-3">IA a analize nòt ou yo, li repare fraz ki te koupe oswa mal fòmile yo, epi li fè tout lide yo vin klè e lojik pandan li konsève tout non moun ak konsèp yo.</p>
          <div class="field mb-3">
            <label class="label font-bold text-xs uppercase text-muted">Tèks korije e klè</label>
            <div class="card p-3" style="max-height:280px;overflow-y:auto;background:var(--c-surface);font-size:0.95rem;line-height:1.6;white-space:pre-wrap;" id="corrected-sense-preview">${esc(res.correctedText)}</div>
          </div>
        </div>
      `,
      footer: `
        <button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn-primary" id="btn-apply-corrected-sense">
          ${icon('check')}<span>${esc('Aplike nan tèks brit la')}</span>
        </button>
      `,
    });

    m.el.querySelector('#btn-apply-corrected-sense')?.addEventListener('click', () => {
      if (rawEl) {
        rawEl.value = res.correctedText;
        rawEl.dispatchEvent(new Event('input'));
        saveDraftToStorage();
        updateRawWordCount();
      }
      m.close();
      toast('Tèks la korije avèk siksè !', 'success');
    });
  } catch (err) {
    handleError(err);
  } finally {
    if (btn) setLoading(btn, false);
  }
}

/** Génération de questions stratégiques pour le professeur */
async function triggerGenerateProfQuestions() {
  const liveText = getLiveNoteText();
  const title = document.getElementById('note-title')?.value || t('capture.page_title');
  if (!liveText && !title) {
    toast('Tape oswa anrejistre kèk nòt anvan pou IA ka jenere kesyon pou pwofesè a.', 'warning');
    return;
  }

  const btn = document.getElementById('btn-capture-prof-questions');
  if (btn) setLoading(btn, true);

  try {
    const lang = document.getElementById('note-lang')?.value || 'fr';
    const res = await generateProfessorQuestions({
      content: liveText,
      title,
      faculty: profileRef?.faculty_id,
      level: profileRef?.level,
      language: lang,
    });

    if (!res.ok || !res.questions?.length) {
      throw new Error('Echèk jenerasyon kesyon pou pwofesè a');
    }

    renderProfQuestionsModal(res.questions, title);
  } catch (err) {
    handleError(err);
  } finally {
    if (btn) setLoading(btn, false);
  }
}

function renderProfQuestionsModal(questions = [], title = '') {
  const m = openModal({
    title: `Kesyon pou poze pwofesè a — ${title}`,
    body: `
      <div class="stack py-2">
        <p class="text-sm muted mb-3">Men kesyon akademik ki pi pètinan e estratejik ou ka poze pwofesè a nan klas oswa nan fen kou a pou klarifye pwen ki difisil yo epi prepare egzamen an :</p>
        <div class="stack" style="gap:12px;">
          ${questions.map((q, idx) => `
            <div class="card p-3" style="background:var(--c-surface);border:1px solid var(--c-border);border-left:4px solid var(--c-primary);">
              <div class="row-between mb-2">
                <span class="badge badge-primary font-bold">Kesyon #${idx + 1}</span>
                <button type="button" class="btn btn-xs btn-ghost" data-copy-q="${esc(q.question)}">
                  ${icon('copy')}<span>Kopye</span>
                </button>
              </div>
              <h3 class="text-base font-bold mb-2" style="color:var(--c-text);">${esc(q.question)}</h3>
              ${q.purpose ? `<p class="text-xs muted mb-1"><strong>Poukisa poze l :</strong> ${esc(q.purpose)}</p>` : ''}
              ${q.hint ? `<p class="text-xs text-accent mb-0"><strong>Sa pou w koute :</strong> ${esc(q.hint)}</p>` : ''}
              <div class="row-wrap mt-2" style="gap:6px;">
                <button type="button" class="btn btn-xs btn-outline" data-insert-q="${esc(q.question)}">
                  ${icon('plus')}<span>Mete nan nòt la</span>
                </button>
                <button type="button" class="btn btn-xs btn-secondary" data-ask-tutor-q="${esc(q.question)}">
                  ${icon('message-square')}<span>Mande Tuteur IA</span>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `,
    footer: `<button type="button" class="btn btn-primary" data-close>${esc(t('common.close') || 'Fèmen')}</button>`,
  });

  m.el.querySelectorAll('[data-copy-q]').forEach((b) => {
    b.addEventListener('click', () => {
      navigator.clipboard?.writeText(b.dataset.copyQ);
      toast('Kesyon kopye !', 'success');
    });
  });

  m.el.querySelectorAll('[data-insert-q]').forEach((b) => {
    b.addEventListener('click', () => {
      const qText = `\n\n### Kesyon pou Pwofesè a :\n- ${b.dataset.insertQ}\n`;
      const rawEl = document.getElementById('raw-text');
      if (rawEl) {
        rawEl.value = (rawEl.value ? rawEl.value + '\n' : '') + qText;
        rawEl.dispatchEvent(new Event('input'));
        saveDraftToStorage();
      }
      toast('Ajoute nan nòt la !', 'success');
    });
  });

  m.el.querySelectorAll('[data-ask-tutor-q]').forEach((b) => {
    b.addEventListener('click', () => {
      m.close();
      import('../navbar.js').then(({ toggleTutorDrawer }) => {
        toggleTutorDrawer(true, `Eksplike m an detay repons pwofesè a gen chans bay sou kesyon sa a : "${b.dataset.askTutorQ}"`);
      });
    });
  });
}

function initQuickAiModule() {
  const card = document.getElementById('note-quick-ai-card');
  if (!card) return;

  const btnGlobal = document.getElementById('note-ai-scope-global');
  const btnFaculty = document.getElementById('note-ai-scope-faculty');
  const facNameSpan = document.getElementById('note-ai-fac-name');
  const input = document.getElementById('note-quick-ai-input');
  const askBtn = document.getElementById('note-quick-ai-btn');
  const chipsContainer = document.getElementById('note-quick-ai-chips');
  const resultBox = document.getElementById('note-quick-ai-result');

  let currentScope = localStorage.getItem('prannot.note_ai_scope') || 'global';

  const updateScopeUI = () => {
    if (currentScope === 'global') {
      btnGlobal?.classList.add('active');
      btnFaculty?.classList.remove('active');
    } else {
      btnFaculty?.classList.add('active');
      btnGlobal?.classList.remove('active');
    }
  };

  const facName = profileRef?.faculty?.name_fr || profileRef?.faculty_id || t('capture.scope_faculty') || 'Fakilte';
  if (facNameSpan) facNameSpan.textContent = facName;
  updateScopeUI();

  btnGlobal?.addEventListener('click', () => {
    currentScope = 'global';
    localStorage.setItem('prannot.note_ai_scope', 'global');
    updateScopeUI();
    toast(t('tutor.scope_switched_global'), 'info');
  });

  btnFaculty?.addEventListener('click', () => {
    currentScope = 'faculty';
    localStorage.setItem('prannot.note_ai_scope', 'faculty');
    updateScopeUI();
    toast(t('tutor.scope_switched_faculty'), 'info');
  });

  chipsContainer?.querySelectorAll('[data-quick-action]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const act = chip.dataset.quickAction;
      if (act === 'fix_sense') {
        triggerFixRawSense();
      } else if (act === 'prof_questions') {
        triggerGenerateProfQuestions();
      }
    });
  });

  chipsContainer?.querySelectorAll('[data-quick-prompt]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prefix = chip.dataset.quickPrompt || '';
      if (input) {
        input.value = prefix + (input.value ? input.value.replace(/^[^:]+:\s*/, '') : '');
        input.focus();
      }
    });
  });

  const runQuickAi = async () => {
    const q = input?.value?.trim();
    if (!q) {
      toast(t('errors.required'), 'warning');
      input?.focus();
      return;
    }

    setLoading(askBtn, true);
    resultBox.hidden = false;
    resultBox.innerHTML = `
      <div class="card card-sm text-center p-3" style="background:var(--c-surface);">
        <div class="spinner mb-2" style="margin:0 auto;"></div>
        <p class="text-xs muted mb-0">${esc(t('capture.quick_ai_searching'))}</p>
      </div>
    `;

    try {
      const lang = document.getElementById('note-lang')?.value || profileRef?.language || 'fr';
      const courseId = document.getElementById('note-course')?.value || null;
      const effectiveFaculty = currentScope === 'global' ? 'general' : (profileRef?.faculty_id || 'general');
      const liveText = getLiveNoteText();

      const res = await askTutor({
        message: q,
        mode: 'simple',
        scope: currentScope,
        faculty: effectiveFaculty,
        level: profileRef?.level || 'L1',
        language: lang,
        courseId,
        contextType: 'note_draft',
        contextTitle: document.getElementById('note-title')?.value || t('capture.page_title'),
        contextText: liveText,
      });

      const reply = res?.reply || '';
      if (!reply) throw new Error('No answer received');

      resultBox.innerHTML = `
        <div class="card card-sm" style="background:var(--c-surface);border:1px solid var(--c-primary-soft, #cbd5e1);">
          <div class="row-between mb-2" style="flex-wrap:wrap;gap:6px;">
            <div class="ai-suggestion-label">${icon('sparkles')}<span>${esc(q.length > 50 ? q.slice(0, 50) + '...' : q)}</span></div>
            <div class="row-wrap" style="gap:4px;">
              <button type="button" class="btn btn-xs btn-primary" id="note-ai-insert-quill">
                ${icon('plus')}<span>${esc(t('capture.insert_in_note'))}</span>
              </button>
              <button type="button" class="btn btn-xs btn-secondary" id="note-ai-insert-raw">
                ${icon('file-text')}<span>${esc(t('capture.insert_in_raw'))}</span>
              </button>
              <button type="button" class="btn btn-xs btn-ghost" id="note-ai-copy-btn">
                ${icon('copy')}<span>${esc(t('common.copy') || 'Kopye')}</span>
              </button>
              <button type="button" class="btn-icon" id="note-ai-close-btn" aria-label="${esc(t('common.close'))}">
                ${icon('x')}
              </button>
            </div>
          </div>
          <div class="prose text-sm" style="max-height:260px;overflow-y:auto;padding:8px;background:var(--c-surface-soft);border-radius:var(--r-card);">
            ${renderMarkdown(reply)}
          </div>
        </div>
      `;
      icons(resultBox);

      resultBox.querySelector('#note-ai-insert-quill')?.addEventListener('click', () => {
        insertTextIntoQuill(reply);
        toast(t('capture.insert_in_note') + ' !', 'success');
      });

      resultBox.querySelector('#note-ai-insert-raw')?.addEventListener('click', () => {
        insertTextIntoRaw(reply);
        toast(t('capture.insert_in_raw') + ' !', 'success');
      });

      resultBox.querySelector('#note-ai-copy-btn')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(reply);
          toast(t('common.copied') || 'Kopye !', 'success');
        } catch {
          toast('Kopye echwe', 'error');
        }
      });

      resultBox.querySelector('#note-ai-close-btn')?.addEventListener('click', () => {
        resultBox.hidden = true;
      });

    } catch (err) {
      handleError(err);
      resultBox.innerHTML = `<div class="alert alert-error text-xs">${esc(err.message || 'Erè pandan repons IA')}</div>`;
    } finally {
      setLoading(askBtn, false);
    }
  };

  askBtn?.addEventListener('click', runQuickAi);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runQuickAi();
    }
  });
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
  const onPhotoSelect = (e) => {
    if (e.target?.files?.length) {
      handlePhotoFiles(e.target.files);
    }
    e.target.value = ''; // Réinitialiser pour permettre de ré-uploader le même fichier si besoin
  };
  document.getElementById('photo-input')?.addEventListener('change', onPhotoSelect);
  document.getElementById('photo-camera-input')?.addEventListener('change', onPhotoSelect);
  document.getElementById('photo-gallery-input')?.addEventListener('change', onPhotoSelect);

  document.getElementById('photo-camera-btn')?.addEventListener('click', () => {
    const camInp = document.getElementById('photo-camera-input') || document.getElementById('photo-input');
    camInp?.click();
  });
  document.getElementById('photo-upload-gallery-btn')?.addEventListener('click', () => {
    document.getElementById('photo-gallery-input')?.click();
  });

  const dropZone = document.getElementById('photo-drop');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('is-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('is-over');
      if (e.dataTransfer?.files?.length) {
        handlePhotoFiles(e.dataTransfer.files);
      }
    });
  }

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
  document.getElementById('raw-text').addEventListener('input', () => {
    updateRawWordCount();
    syncLiveTutorContext();
  });
  document.getElementById('ai-structure-btn').addEventListener('click', (e) => runStructureAi('standard', e.currentTarget));
  document.getElementById('btn-structure-bilingual')?.addEventListener('click', (e) => runStructureAi('bilingual', e.currentTarget));
  document.getElementById('btn-re-structure-banner')?.addEventListener('click', (e) => runStructureAi('bilingual', e.currentTarget));
  document.getElementById('ai-ht-btn').addEventListener('click', (e) => runStructureAi('harmonize_ht', e.currentTarget));
  document.getElementById('ai-fr-btn').addEventListener('click', (e) => runStructureAi('harmonize_fr', e.currentTarget));
  document.getElementById('btn-fix-raw-sense')?.addEventListener('click', triggerFixRawSense);
  document.getElementById('btn-capture-prof-questions')?.addEventListener('click', triggerGenerateProfQuestions);

  document.getElementById('confirm-course-btn').addEventListener('click', () => {
    if (suggestedCourseId) {
      document.getElementById('note-course').value = suggestedCourseId;
      document.getElementById('note-course').dispatchEvent(new Event('change'));
      document.getElementById('course-suggestion-box').hidden = true;
    }
  });

  document.getElementById('save-note-btn').addEventListener('click', saveNote);
  document.getElementById('header-save-note-btn')?.addEventListener('click', saveNote);
  document.getElementById('banner-save-note-btn')?.addEventListener('click', saveNote);
  document.getElementById('editor-save-note-btn')?.addEventListener('click', saveNote);
  document.body.dataset.captureReady = '1';

  // Fournir le contexte en temps réel au tuteur dans la barre de navigation
  window.__getLiveNoteContext = () => ({
    text: getLiveNoteText(),
    title: document.getElementById('note-title')?.value || t('capture.page_title'),
    contextType: 'note_draft',
    courseId: document.getElementById('note-course')?.value || null,
  });

  // Inisyalize Asistan IA Kou & Definisyon Rapid
  initQuickAiModule();

  // Charger l'éditeur Quill et la liste des cours en parallèle sans bloquer la capture vocale/photo
  initQuill().then(async () => {
    if (isEditingExisting && editingNoteOriginal) {
      if (quill?.root) {
        if (editingNoteOriginal.content_html) {
          quill.root.innerHTML = sanitizeHtml(editingNoteOriginal.content_html);
        } else if (editingNoteOriginal.content_text) {
          quill.setText(editingNoteOriginal.content_text);
        }
      }
    } else {
      // Si yon draft te egziste nan localStorage oswa kach odyo, restore l
      const didRestore = restoreDraftFromStorage();
      const didRestoreAudio = await restoreAudioDraftFromStorage();
      if (didRestore || didRestoreAudio) {
        const banner = document.getElementById('draft-alert-banner');
        if (banner) {
          banner.hidden = false;
          icons(banner);
        }
        toast(t('notes.draft_restored') || 'Bwouyon nòt ou t ap pran an retabli otomatikman !', 'info');
        if (navigator.onLine && didRestoreAudio) {
          setTimeout(autoRetryPendingTranscriptions, 1000);
        }
      }
    }
    syncLiveTutorContext();
  }).catch(() => {});

  document.getElementById('discard-draft-btn')?.addEventListener('click', () => startFreshNote(false));
  document.getElementById('header-new-note-btn')?.addEventListener('click', () => startFreshNote(false));

  // Otoprezèvasyon / Sauvegarde automatique bwouyon an (Debounce chak 1.5s sou saisie epi sou pagehide/visibilitychange)
  const autoSaveHandler = debounce(() => {
    saveDraftToStorage();
    syncLiveTutorContext();
  }, 1500);
  document.getElementById('note-title')?.addEventListener('input', autoSaveHandler);
  document.getElementById('raw-text')?.addEventListener('input', autoSaveHandler);
  document.getElementById('note-course')?.addEventListener('change', autoSaveHandler);
  document.getElementById('note-unit')?.addEventListener('change', autoSaveHandler);
  document.getElementById('note-lang')?.addEventListener('change', autoSaveHandler);

  // Sou mobil oswa òdinatè si etidyan an soti sou paj la oswa minimize navigatè a
  const handlePageExit = () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      try { mediaRecorder.requestData(); } catch { /* ignore */ }
    }
    saveDraftToStorage();
    persistAudioClipsToStorage();
  };
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') handlePageExit();
  });
  window.addEventListener('pagehide', handlePageExit);
  window.addEventListener('beforeunload', handlePageExit);

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

    const userCoursesKey = `courses_list_${user.id}`;
    const cachedCourses = (await cacheGet(userCoursesKey)) || (await cacheGet('courses_list'));
    if (cachedCourses?.length) {
      populateCourses(cachedCourses.filter((c) => !c.user_id || c.user_id === user.id));
    }

    if (navigator.onLine) {
      const { data: cData } = await db
        .from('pran_not_courses')
        .select('id, name')
        .eq('user_id', user.id)
        .eq('archived', false)
        .order('name');
      if (cData) {
        await cacheSet(userCoursesKey, cData);
        await cacheSet('courses_list', cData);
        populateCourses(cData);
      }
    }
    if (preCourse) await loadUnits(preCourse);
  } catch { /* hors-ligne */ }

  // Si etidyan an ouvri yon nòt ki egziste deja pou modifikasyon
  const urlNoteId = getParam('id');
  if (urlNoteId) {
    await loadExistingNoteForEditing(urlNoteId);
  }
})();
