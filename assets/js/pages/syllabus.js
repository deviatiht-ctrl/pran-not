/* =====================================================================
   PRAN NÒT - pages/syllabus.js
   Import et analyse IA d'un syllabus (PDF, image, texte) -> syllabus_units.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, appUrl } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, getLang } from '../i18n.js';
import {
  icons, esc, toast, handleError, setLoading, getParam, checkFileSize,
  extractPdfText, compressImage, blobToBase64, renderPdfPageToBlob, pageEnter,
} from '../utils.js';
import { processSyllabus } from '../ai.js';

const db = window.db;
let userRef = null;
let profileRef = null;
let pendingImageB64 = '';
let pendingFile = null;
let lastAnalysis = null;

function renderAnalysis(analysis) {
  lastAnalysis = analysis;
  const resultCard = document.getElementById('syl-result-card');
  const unitsBox = document.getElementById('syl-units-preview');
  const aside = document.getElementById('syl-meta-aside');

  const units = Array.isArray(analysis?.units) ? analysis.units : [];
  resultCard.hidden = false;
  aside.hidden = false;

  unitsBox.innerHTML = units.map((u, i) => `
    <div class="card card-sm">
      <div class="row-between">
        <strong>${i + 1}. ${esc(u.title)}</strong>
        <div class="row" style="gap:6px;">
          ${u.planned_week ? `<span class="badge">Semèn ${esc(u.planned_week)}</span>` : ''}
          ${u.weight ? `<span class="badge badge-accent">${esc(u.weight)}%</span>` : ''}
        </div>
      </div>
      ${u.description ? `<p class="text-sm muted mt-1 mb-2">${esc(u.description)}</p>` : ''}
      ${Array.isArray(u.keywords) && u.keywords.length ? `<div class="row-wrap">${u.keywords.map((k) => `<span class="badge">${esc(k)}</span>`).join('')}</div>` : ''}
    </div>`).join('');

  const objs = Array.isArray(analysis?.objectives) ? analysis.objectives : [];
  document.getElementById('syl-objectives').innerHTML = objs.map((o) => `<li class="list-item text-sm">${esc(o)}</li>`).join('');
  document.getElementById('syl-eval').textContent = analysis?.evaluation || t('common.none');

  const order = Array.isArray(analysis?.study_order) ? analysis.study_order : [];
  document.getElementById('syl-order').innerHTML = order.map((o) => `<li class="mb-1">${esc(o)}</li>`).join('');
  icons(resultCard);
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  profileRef = profile;

  await initAppChrome({ profile, user, active: 'courses' });
  setTutorContext({ contextType: 'general', contextTitle: t('syllabus.title') });
  pageEnter();

  const sel = document.getElementById('syl-course');
  const { data: cData } = await db.from('pran_not_courses').select('id, name').eq('archived', false).order('name');
  if (!cData?.length) {
    sel.innerHTML = `<option value="">Kreye yon kou anvan nan Kou</option>`;
  } else {
    sel.innerHTML = cData.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const pre = getParam('course');
    if (pre) sel.value = pre;
  }

  document.getElementById('syl-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    pendingFile = file;
    pendingImageB64 = '';

    if (file.type === 'application/pdf') {
      if (!checkFileSize(file, 'pdf')) return;
      toast('Ap li fichye PDF la...', 'info');
      const { text } = await extractPdfText(file);
      if (text && text.length > 40) {
        document.getElementById('syl-text').value = text;
      } else {
        const blob = await renderPdfPageToBlob(file, 1);
        if (blob) pendingImageB64 = await blobToBase64(blob);
      }
    } else if (file.type.startsWith('image/')) {
      if (!checkFileSize(file, 'image')) return;
      const blob = await compressImage(file, { maxSize: 1600, quality: 0.8, enhance: true });
      pendingImageB64 = await blobToBase64(blob);
      toast('Foto silabis la pare pou analiz.', 'info');
    } else {
      document.getElementById('syl-text').value = await file.text();
    }
  });

  document.getElementById('syl-analyze-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const text = document.getElementById('syl-text').value.trim();
    if (!text && !pendingImageB64) {
      toast(t('errors.required'), 'warning');
      return;
    }
    setLoading(btn, true);
    try {
      const res = await processSyllabus({
        text,
        imageBase64: pendingImageB64,
        language: getLang(),
        faculty: profileRef?.faculty_id,
        level: profileRef?.level,
        courseId: sel.value || null,
      });
      renderAnalysis(res.analysis);
      toast(t('common.saved'), 'success');
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  document.getElementById('syl-save-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const courseId = sel.value;
    if (!courseId || !lastAnalysis) {
      toast(t('errors.required'), 'warning');
      return;
    }
    setLoading(btn, true);
    try {
      let storagePath = null;
      if (pendingFile) {
        storagePath = `${userRef.id}/syl-${Date.now()}-${pendingFile.name.replace(/[^a-z0-9.]/gi, '_')}`;
        await db.storage.from('pran-not-syllabi').upload(storagePath, pendingFile);
      }

      const { data: sylRow, error: sErr } = await db.from('pran_not_syllabi').insert({
        user_id: userRef.id,
        course_id: courseId,
        source_type: pendingFile?.type === 'application/pdf' ? 'pdf' : pendingImageB64 ? 'image' : 'text',
        storage_path: storagePath,
        raw_text: document.getElementById('syl-text').value.trim() || null,
        analysis: lastAnalysis,
        status: 'done',
      }).select().single();
      if (sErr) throw sErr;

      const units = (lastAnalysis.units || []).map((u, idx) => ({
        user_id: userRef.id,
        course_id: courseId,
        syllabus_id: sylRow.id,
        position: idx + 1,
        title: String(u.title || `Chapit ${idx + 1}`),
        description: u.description || null,
        objectives: Array.isArray(u.objectives) ? u.objectives : [],
        keywords: Array.isArray(u.keywords) ? u.keywords : [],
        planned_week: Number(u.planned_week || idx + 1),
        weight: u.weight ? Number(u.weight) : null,
        status: 'todo',
      }));

      if (units.length) {
        const { error: uErr } = await db.from('pran_not_syllabus_units').insert(units);
        if (uErr) throw uErr;
      }

      toast(t('common.saved'), 'success');
      location.href = appUrl(`pages/course.html?id=${courseId}`);
    } catch (err) {
      handleError(err);
      setLoading(btn, false);
    }
  });
})();
