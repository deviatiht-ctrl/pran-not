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
import { cacheGet, cacheSet, cacheDel } from '../offline.js';

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

  unitsBox.innerHTML = `
    <p class="text-xs muted mb-3">Ou ka modifye tit, semèn oswa pwa chak chapit dirèkteman anvan ou anrejistre :</p>
    <div class="stack-sm mb-3" id="editable-units-container">
      ${units.map((u, i) => `
        <div class="card card-sm editable-unit-item" data-unit-idx="${i}" style="border:1px solid var(--c-border);">
          <div class="row-between mb-2">
            <span class="badge badge-accent">Chapit ${i + 1}</span>
            <div class="row" style="gap:8px;flex-wrap:wrap;">
              <span class="text-xs muted">Semèn :</span>
              <input type="number" class="input unit-week" value="${esc(u.planned_week || (i + 1))}" style="width:65px;min-height:28px;padding:2px 6px;font-size:12px;">
              <span class="text-xs muted">Pwa % :</span>
              <input type="number" class="input unit-weight" value="${esc(u.weight || 15)}" style="width:65px;min-height:28px;padding:2px 6px;font-size:12px;">
              <button type="button" class="btn-icon text-error btn-remove-unit" title="Retire chapit sa" aria-label="Supprimer">
                <i data-lucide="trash-2"></i>
              </button>
            </div>
          </div>
          <div class="field mb-2">
            <input class="input unit-title" value="${esc(u.title || `Chapit ${i + 1}`)}" placeholder="Tit chapit la" style="font-weight:600;">
          </div>
          <div class="field mb-2">
            <textarea class="textarea unit-desc" rows="2" placeholder="Eksplikasyon ak nosyon chapit la">${esc(u.description || '')}</textarea>
          </div>
          ${Array.isArray(u.keywords) && u.keywords.length ? `<div class="row-wrap mb-1">${u.keywords.map((k) => `<span class="badge">${esc(typeof k === 'string' ? k : (k?.term || ''))}</span>`).join('')}</div>` : ''}
        </div>
      `).join('')}
    </div>
    <button type="button" class="btn btn-sm btn-secondary mb-3" id="btn-add-unit">
      <i data-lucide="plus"></i><span>Ajoute yon lòt chapit</span>
    </button>
  `;

  unitsBox.querySelectorAll('.btn-remove-unit').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.currentTarget.closest('.editable-unit-item')?.remove();
    });
  });

  unitsBox.querySelector('#btn-add-unit')?.addEventListener('click', () => {
    const container = unitsBox.querySelector('#editable-units-container');
    const count = container.querySelectorAll('.editable-unit-item').length;
    const newIdx = count + 1;
    const div = document.createElement('div');
    div.className = 'card card-sm editable-unit-item';
    div.style.border = '1px solid var(--c-border)';
    div.innerHTML = `
      <div class="row-between mb-2">
        <span class="badge badge-accent">Chapit ${newIdx}</span>
        <div class="row" style="gap:8px;flex-wrap:wrap;">
          <span class="text-xs muted">Semèn :</span>
          <input type="number" class="input unit-week" value="${newIdx}" style="width:65px;min-height:28px;padding:2px 6px;font-size:12px;">
          <span class="text-xs muted">Pwa % :</span>
          <input type="number" class="input unit-weight" value="15" style="width:65px;min-height:28px;padding:2px 6px;font-size:12px;">
          <button type="button" class="btn-icon text-error btn-remove-unit" title="Retire chapit sa" aria-label="Supprimer">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </div>
      <div class="field mb-2">
        <input class="input unit-title" value="Nouvo Chapit ${newIdx}" placeholder="Tit chapit la" style="font-weight:600;">
      </div>
      <div class="field mb-2">
        <textarea class="textarea unit-desc" rows="2" placeholder="Eksplikasyon ak nosyon chapit la"></textarea>
      </div>
    `;
    div.querySelector('.btn-remove-unit')?.addEventListener('click', () => div.remove());
    container.appendChild(div);
    icons(div);
  });

  const objs = Array.isArray(analysis?.objectives) ? analysis.objectives : [];
  document.getElementById('syl-objectives').innerHTML = objs.map((o) => `<li class="list-item text-sm">${esc(typeof o === 'string' ? o : (o?.text || String(o)))}</li>`).join('');
  document.getElementById('syl-eval').textContent = analysis?.evaluation || t('common.none');

  const order = Array.isArray(analysis?.study_order) ? analysis.study_order : [];
  document.getElementById('syl-order').innerHTML = order.map((o) => `<li class="mb-1">${esc(typeof o === 'string' ? o : String(o))}</li>`).join('');
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
  const userCoursesKey = `courses_list_${user.id}`;
  const [cachedUserCourses, cachedGlobalCourses] = await Promise.all([
    cacheGet(userCoursesKey),
    cacheGet('courses_list'),
  ]);
  let availableCourses = (cachedUserCourses || cachedGlobalCourses || []).filter((c) => !c.user_id || c.user_id === user.id);

  const populateCourseSelect = (list) => {
    if (!list?.length) {
      sel.innerHTML = `<option value="">${esc(t('syllabus.create_course_first') || 'Kreye yon kou dabò...')}</option>`;
    } else {
      sel.innerHTML = list.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
      const pre = getParam('course');
      if (pre && list.some((c) => c.id === pre)) sel.value = pre;
    }
  };

  populateCourseSelect(availableCourses);

  if (navigator.onLine) {
    try {
      const { data: cData } = await db
        .from('pran_not_courses')
        .select('id, name')
        .eq('user_id', user.id)
        .eq('archived', false)
        .order('name');
      if (cData?.length) {
        availableCourses = cData;
        populateCourseSelect(availableCourses);
      }
    } catch {}
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
      toast(t('syllabus.photo_ready'), 'info');
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
    if (!courseId) {
      toast('Tanpri chwazi yon kou anvan ou anrejistre silabis la.', 'warning');
      return;
    }

    setLoading(btn, true);
    try {
      if (!lastAnalysis) {
        const text = document.getElementById('syl-text').value.trim();
        if (text || pendingImageB64) {
          toast('Ap analize silabis la ak IA...', 'info');
          try {
            const res = await processSyllabus({
              text,
              imageBase64: pendingImageB64,
              language: getLang(),
              faculty: profileRef?.faculty_id,
              level: profileRef?.level,
              courseId,
            });
            if (res?.analysis) {
              lastAnalysis = res.analysis;
              renderAnalysis(res.analysis);
            }
          } catch (aErr) {
            console.warn('[syllabus] auto-analysis error, using fallback:', aErr);
          }
        }
      }

      let storagePath = null;
      if (pendingFile && userRef?.id) {
        try {
          storagePath = `${userRef.id}/syl-${Date.now()}-${pendingFile.name.replace(/[^a-z0-9.]/gi, '_')}`;
          const { error: upErr } = await db.storage.from('pran-not-syllabi').upload(storagePath, pendingFile, {
            contentType: pendingFile.type || 'application/pdf',
            upsert: true,
          });
          if (upErr) {
            console.warn('[syllabus] storage upload warning:', upErr);
            storagePath = null;
          }
        } catch (stErr) {
          console.warn('[syllabus] storage upload exception:', stErr);
          storagePath = null;
        }
      }

      let sylRow = null;
      try {
        const { data, error: sErr } = await db.from('pran_not_syllabi').insert({
          user_id: userRef.id,
          course_id: courseId,
          source_type: pendingFile?.type === 'application/pdf' ? 'pdf' : pendingImageB64 ? 'image' : 'text',
          storage_path: storagePath,
          raw_text: document.getElementById('syl-text').value.trim() || null,
          analysis: lastAnalysis,
          status: 'done',
        }).select().maybeSingle();
        if (sErr) console.warn('[syllabus] insert pran_not_syllabi warning:', sErr);
        else sylRow = data;
      } catch (insertSylErr) {
        console.warn('[syllabus] insert pran_not_syllabi exception:', insertSylErr);
      }

      let rawUnits = [];
      const editableItems = document.querySelectorAll('.editable-unit-item');
      if (editableItems.length > 0) {
        editableItems.forEach((item, idx) => {
          const tVal = item.querySelector('.unit-title')?.value.trim() || `Chapit ${idx + 1}`;
          const dVal = item.querySelector('.unit-desc')?.value.trim() || null;
          const wVal = parseInt(item.querySelector('.unit-week')?.value, 10) || (idx + 1);
          const wtVal = parseFloat(item.querySelector('.unit-weight')?.value) || 15;
          const origUnit = Array.isArray(lastAnalysis?.units) ? lastAnalysis.units[idx] : null;
          rawUnits.push({
            title: tVal,
            description: dVal,
            planned_week: wVal,
            weight: wtVal,
            objectives: origUnit?.objectives || [],
            keywords: origUnit?.keywords || [],
          });
        });
      } else if (Array.isArray(lastAnalysis?.units) && lastAnalysis.units.length) {
        rawUnits = lastAnalysis.units;
      }

      if (!rawUnits.length) {
        const textFallback = document.getElementById('syl-text')?.value?.trim();
        rawUnits = [
          {
            title: textFallback ? textFallback.slice(0, 60) : 'Chapit 1 - Entwodiksyon ak Plan Kou',
            description: textFallback ? textFallback.slice(0, 300) : 'Plan jeneral kou a',
            planned_week: 1,
            weight: 100,
            objectives: ['Konprann prensip jeneral yo'],
            keywords: [],
          },
        ];
      }

      const units = rawUnits.map((u, idx) => {
        const rawWeek = parseInt(String(u.planned_week || '').replace(/\D+/g, ''), 10);
        const plannedWeek = !isNaN(rawWeek) && rawWeek > 0 ? rawWeek : (idx + 1);

        let weight = null;
        if (u.weight !== undefined && u.weight !== null && u.weight !== '') {
          const numWeight = parseFloat(String(u.weight).replace(/[^0-9.]/g, ''));
          if (!isNaN(numWeight)) weight = Math.min(100, Math.max(0, numWeight));
        }

        const safeObjectives = (Array.isArray(u.objectives) ? u.objectives : [])
          .map((o) => (typeof o === 'string' ? o : (o?.text || o?.title || String(o || ''))))
          .map((s) => s.trim())
          .filter(Boolean);

        const safeKeywords = (Array.isArray(u.keywords) ? u.keywords : [])
          .map((k) => (typeof k === 'string' ? k : (k?.keyword || k?.term || String(k || ''))))
          .map((s) => s.trim())
          .filter(Boolean);

        return {
          user_id: userRef.id,
          course_id: courseId,
          syllabus_id: sylRow?.id || null,
          position: idx + 1,
          title: String(u.title || `Chapit ${idx + 1}`).trim(),
          description: u.description || null,
          objectives: safeObjectives,
          keywords: safeKeywords,
          planned_week: plannedWeek,
          weight: weight,
          status: 'todo',
        };
      });

      if (units.length && navigator.onLine && db) {
        try {
          await db.from('pran_not_syllabus_units').delete().eq('course_id', courseId).eq('user_id', userRef.id);
        } catch (delErr) {
          console.warn('[syllabus] netwaye ansyen chapit:', delErr);
        }

        try {
          const { error: uErr } = await db.from('pran_not_syllabus_units').insert(units);
          if (uErr) {
            console.warn('[syllabus] insert units warning, retry sans syllabus_id:', uErr);
            const fallbackUnits = units.map((x) => ({ ...x, syllabus_id: null }));
            const { error: retryErr } = await db.from('pran_not_syllabus_units').insert(fallbackUnits);
            if (retryErr) throw retryErr;
          }
        } catch (dbErr) {
          console.warn('[syllabus] insert units exception:', dbErr);
        }
      }

      await cacheSet(`course_units_${courseId}`, units);
      const existingDetail = (await cacheGet(`course_detail_${courseId}`)) || {};
      existingDetail.units = units;
      existingDetail.syllabus = sylRow || lastAnalysis;
      await cacheSet(`course_detail_${courseId}`, existingDetail);

      toast(t('common.saved'), 'success');
      setTimeout(() => {
        location.href = appUrl(`pages/course.html?id=${courseId}`);
      }, 250);
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });
})();
