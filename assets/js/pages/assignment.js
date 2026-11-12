/* =====================================================================
   PRAN NÒT - pages/assignment.js
   Atelier de devoir : éditeur, assistant IA méthodologique (plan, pistes,
   cohérence, bibliographie, reformulation), page de couverture et export PDF/Word.
   ===================================================================== */
import '../supabase.js';
import { requireAuth } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, getLang, formatDate } from '../i18n.js';
import {
  icons, icon, esc, getParam, isUuid, toast, handleError, setLoading,
  loadScript, loadStyle, CDN, sanitizeHtml, pageEnter, checkFileSize,
} from '../utils.js';
import { assistAssignment } from '../ai.js';
import { exportAssignmentPdf, exportAssignmentDocx } from '../export.js';

const db = window.db;
let userRef = null;
let profileRef = null;
let assignment = null;
let course = null;
let quill = null;

function renderAiPlan(plan, librarySources = []) {
  const box = document.getElementById('asg-ai-output');
  if (!plan && !librarySources.length) { box.hidden = true; return; }
  box.hidden = false;

  const outline = Array.isArray(plan?.outline) ? plan.outline : [];
  const leads = Array.isArray(plan?.research_leads) ? plan.research_leads : [];
  const sources = Array.isArray(plan?.sources_to_find) ? plan.sources_to_find : [];
  const synthesisNotes = Array.isArray(plan?.synthesis_notes) ? plan.synthesis_notes : [];
  const legalCitations = Array.isArray(plan?.legal_citations) ? plan.legal_citations : [];
  const tips = Array.isArray(plan?.tips) ? plan.tips : [];
  const strengths = Array.isArray(plan?.strengths) ? plan.strengths : [];
  const issues = Array.isArray(plan?.issues) ? plan.issues : [];

  box.innerHTML = `
    <div class="ai-suggestion-label">${icon('sparkles')}<span>Gid metodolojik IA</span></div>
    ${synthesisNotes.length ? `<div class="mt-2"><strong>Sentèz dokimantè (Bibliyotèk san plajya) :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${synthesisNotes.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
    ${legalCitations.length ? `<div class="mt-2"><strong>Referans lwa ak atik egzak :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${legalCitations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
    ${outline.length ? `<div class="mt-2">${outline.map((sec) => `
      <div class="mb-2">
        <strong>${esc(sec.section)}</strong>
        <ul class="text-sm mb-0" style="padding-left:1.3em;">${(sec.points || []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      </div>`).join('')}</div>` : ''}
    ${leads.length ? `<div class="mt-2"><strong>Pis rechèch :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${leads.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : ''}
    ${sources.length ? `<div class="mt-2"><strong>Sous pou chèche :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${sources.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
    ${strengths.length ? `<div class="mt-2"><strong>Pwen fò :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
    ${issues.length ? `<div class="mt-2"><strong>Pwen pou amelyore :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${issues.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
    ${plan?.suggestion ? `<div class="mt-2"><strong>Pwopozisyon refòmilasyon :</strong><p class="text-sm mb-0">${esc(plan.suggestion)}</p></div>` : ''}
    ${tips.length ? `<div class="mt-2"><strong>Konsèy :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${tips.map((tp) => `<li>${esc(tp)}</li>`).join('')}</ul></div>` : ''}
    ${librarySources.length ? `
      <div class="mt-3 pt-3" style="border-top:1px solid var(--c-border);">
        <strong class="text-xs" style="text-transform:uppercase;letter-spacing:0.05em;">${esc(t('assignments.library_sources_title'))}</strong>
        <div class="stack-sm mt-2">
          ${librarySources.map((src, idx) => `
            <div class="card card-sm">
              <div class="row-between" style="flex-wrap:wrap;gap:6px;">
                <strong class="text-sm">${esc(src.book_title)}</strong>
                ${src.section_label ? `<span class="badge">${esc(src.section_label)}</span>` : ''}
              </div>
              <p class="text-xs muted mt-1 mb-2">${esc(src.excerpt)}</p>
              <div class="row-wrap">
                <button type="button" class="btn btn-sm btn-secondary" data-insert-src="${idx}">
                  ${icon('plus')}<span>${esc(t('assignments.insert_citation'))}</span>
                </button>
                <a class="btn btn-sm btn-ghost" href="./library.html?book=${encodeURIComponent(src.book_id)}">
                  ${icon('library')}<span>${esc(t('assignments.open_in_library'))}</span>
                </a>
              </div>
            </div>`).join('')}
        </div>
      </div>` : ''}`;

  box.querySelectorAll('[data-insert-src]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const src = librarySources[Number(btn.dataset.insertSrc)];
      if (!src || !quill) return;
      const cite = `[Sous : ${src.book_title}${src.section_label ? ` — ${src.section_label}` : ''}${src.page_number ? `, p. ${src.page_number}` : ''}] `;
      const idx = quill.getLength() - 1;
      quill.insertText(Math.max(0, idx), `\n${cite}`);
      toast(t('common.saved'), 'success');
    });
  });
  icons(box);
}

async function renderPage() {
  const root = document.getElementById('assignment-root');
  const cov = assignment.cover || {};

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="row-wrap mb-2">
          <a class="btn btn-sm btn-ghost" href="./assignments.html">${icon('arrow-left')}<span>${esc(t('common.back'))}</span></a>
          ${course ? `<span class="badge">${esc(course.name)}</span>` : ''}
          ${assignment.due_at ? `<span class="badge badge-warning">${esc(formatDate(assignment.due_at))}</span>` : ''}
        </div>
        <h1>${esc(assignment.title)}</h1>
      </div>
      <div class="page-head-actions">
        <button type="button" class="btn btn-secondary" id="asg-pdf-btn">${icon('file-text')}<span>${esc(t('assignments.export_pdf'))}</span></button>
        <button type="button" class="btn btn-secondary" id="asg-docx-btn">${icon('file-type')}<span>${esc(t('assignments.export_docx'))}</span></button>
        <button type="button" class="btn btn-primary" id="asg-save-btn">${icon('save')}<span>${esc(t('common.save'))}</span></button>
      </div>
    </div>

    <div class="grid grid-main-side">
      <div class="stack">
        <section class="card">
          <div class="field">
            <label for="asg-inst-ed">${esc(t('assignments.instructions'))}</label>
            <textarea class="textarea" id="asg-inst-ed" rows="3">${esc(assignment.instructions || '')}</textarea>
          </div>

          <div class="mb-3">
            <label class="switch">
              <input type="checkbox" id="asg-use-library" checked>
              <span class="switch-track"></span>
              <span class="text-sm">${esc(t('assignments.use_library'))}</span>
            </label>
          </div>

          <div class="row-wrap mb-4">
            <button type="button" class="btn btn-sm btn-primary" data-assist="plan">${icon('sparkles')}<span>${esc(t('assignments.assist_plan'))}</span></button>
            <button type="button" class="btn btn-sm btn-secondary" data-assist="library_research">${icon('library')}<span>${esc(t('assignments.assist_library'))}</span></button>
            <button type="button" class="btn btn-sm btn-secondary" data-assist="coherence">${esc(t('assignments.assist_coherence'))}</button>
            <button type="button" class="btn btn-sm btn-secondary" data-assist="biblio">${esc(t('assignments.assist_biblio'))}</button>
            <button type="button" class="btn btn-sm btn-secondary" data-assist="rephrase">${esc(t('assignments.assist_rephrase'))}</button>
          </div>

          <div class="ai-suggestion mb-4" id="asg-ai-output" ${assignment.plan ? '' : 'hidden'}></div>

          <div class="field mb-0">
            <label>Redaksyon devwa a</label>
            <div id="asg-quill"></div>
          </div>
        </section>
      </div>

      <aside class="stack">
        <section class="card">
          <h2 class="card-title mb-3">Estati ak fichye</h2>
          <div class="field">
            <label for="asg-status">Estati</label>
            <select class="select" id="asg-status">
              <option value="todo" ${assignment.status === 'todo' ? 'selected' : ''}>${esc(t('assignments.status_todo'))}</option>
              <option value="in_progress" ${assignment.status === 'in_progress' ? 'selected' : ''}>${esc(t('assignments.status_in_progress'))}</option>
              <option value="done" ${assignment.status === 'done' ? 'selected' : ''}>${esc(t('assignments.status_done'))}</option>
              <option value="submitted" ${assignment.status === 'submitted' ? 'selected' : ''}>${esc(t('assignments.status_submitted'))}</option>
            </select>
          </div>
          <div class="field mb-2">
            <label for="asg-file-up">Atache fichye (PDF, imaj)</label>
            <input class="input" id="asg-file-up" type="file" style="padding-top:9px;">
          </div>
          <div id="asg-files-list" class="stack-sm"></div>
        </section>

        <section class="card">
          <h2 class="card-title mb-3">${esc(t('assignments.cover_title'))}</h2>
          <div class="field">
            <label for="cov-tpl">${esc(t('assignments.cover_template'))}</label>
            <select class="select" id="cov-tpl">
              <option value="classic" ${cov.template === 'classic' ? 'selected' : ''}>Klasik ankadre (Inivèsitè)</option>
              <option value="modern" ${cov.template === 'modern' ? 'selected' : ''}>Modèn ak liy oranj</option>
              <option value="minimal" ${cov.template === 'minimal' ? 'selected' : ''}>Senp ak pwòp</option>
            </select>
          </div>
          <div class="field"><label>Inivèsite</label><input class="input" id="cov-uni" value="${esc(cov.university || profileRef?.university || '')}"></div>
          <div class="field"><label>Fakilte</label><input class="input" id="cov-fac" value="${esc(cov.faculty || profileRef?.faculty?.name_fr || '')}"></div>
          <div class="field"><label>Kou</label><input class="input" id="cov-course" value="${esc(cov.course || course?.name || '')}"></div>
          <div class="field"><label>Pwofesè</label><input class="input" id="cov-prof" value="${esc(cov.professor || course?.professor || '')}"></div>
          <div class="field"><label>Etidyan</label><input class="input" id="cov-student" value="${esc(cov.student || profileRef?.full_name || '')}"></div>
          <div class="form-row">
            <div class="field"><label>Nivo</label><input class="input" id="cov-level" value="${esc(cov.level || profileRef?.level || '')}"></div>
            <div class="field"><label>Dat</label><input class="input" id="cov-date" value="${esc(cov.date || formatDate(new Date()))}"></div>
          </div>
        </section>
      </aside>
    </div>`;

  icons(root);

  loadStyle(CDN.quillCss);
  await loadScript(CDN.quillJs);
  quill = new window.Quill('#asg-quill', {
    theme: 'snow',
    placeholder: 'Kòmanse ekri travay ou a... Itilize tit H1/H2 pou jenere tab matyè a otomatikman nan PDF/Word.',
    modules: {
      toolbar: [
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['blockquote', 'clean'],
      ],
    },
  });
  if (assignment.content_html) {
    quill.root.innerHTML = sanitizeHtml(assignment.content_html);
  }
  if (assignment.plan) renderAiPlan(assignment.plan);

  const gatherState = () => ({
    instructions: document.getElementById('asg-inst-ed').value.trim(),
    status: document.getElementById('asg-status').value,
    content_html: sanitizeHtml(quill.root.innerHTML),
    cover: {
      template: document.getElementById('cov-tpl').value,
      university: document.getElementById('cov-uni').value.trim(),
      faculty: document.getElementById('cov-fac').value.trim(),
      course: document.getElementById('cov-course').value.trim(),
      professor: document.getElementById('cov-prof').value.trim(),
      student: document.getElementById('cov-student').value.trim(),
      level: document.getElementById('cov-level').value.trim(),
      date: document.getElementById('cov-date').value.trim(),
    },
  });

  document.getElementById('asg-save-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const patch = gatherState();
      const { data, error } = await db.from('pran_not_assignments').update(patch).eq('id', assignment.id).select().single();
      if (error) throw error;
      assignment = data;
      toast(t('common.saved'), 'success');
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  root.querySelectorAll('[data-assist]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      setLoading(btn, true);
      try {
        const action = btn.dataset.assist;
        const useLibrary = document.getElementById('asg-use-library')?.checked !== false;
        const res = await assistAssignment({
          action,
          title: assignment.title,
          instructions: document.getElementById('asg-inst-ed').value.trim(),
          content: quill.getText().trim(),
          useLibrary,
          language: getLang(),
          faculty: profileRef?.faculty_id,
          level: profileRef?.level,
        });
        renderAiPlan(res.data, res.library_sources || []);
        if (action === 'plan') {
          await db.from('pran_not_assignments').update({ plan: res.data }).eq('id', assignment.id);
        }
      } catch (err) {
        handleError(err);
      } finally {
        setLoading(btn, false);
      }
    });
  });

  document.getElementById('asg-pdf-btn').addEventListener('click', async () => {
    await exportAssignmentPdf({ ...assignment, ...gatherState() }, profileRef, course);
  });
  document.getElementById('asg-docx-btn').addEventListener('click', async () => {
    await exportAssignmentDocx({ ...assignment, ...gatherState() }, profileRef, course);
  });

  await loadAttachedFiles();
  document.getElementById('asg-file-up').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file || !checkFileSize(file, 'assignment')) return;
    const path = `${userRef.id}/${assignment.id}/${Date.now()}-${file.name.replace(/[^a-z0-9.]/gi, '_')}`;
    const { error: upErr } = await db.storage.from('pran-not-assignments').upload(path, file);
    if (upErr) { handleError(upErr); return; }
    await db.from('pran_not_assignment_files').insert({
      user_id: userRef.id, assignment_id: assignment.id, storage_path: path, name: file.name, mime: file.type, size_bytes: file.size,
    });
    toast(t('common.saved'), 'success');
    await loadAttachedFiles();
  });
}

async function loadAttachedFiles() {
  const box = document.getElementById('asg-files-list');
  const { data } = await db.from('pran_not_assignment_files').select('*').eq('assignment_id', assignment.id);
  box.innerHTML = (data || []).map((f) => `<div class="text-xs muted truncate">${esc(f.name)}</div>`).join('');
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  profileRef = profile;

  const id = getParam('id');
  await initAppChrome({ profile, user, active: 'assignments' });
  pageEnter();

  if (!isUuid(id)) {
    document.getElementById('assignment-root').innerHTML = `<div class="alert alert-error">${esc(t('errors.not_found'))}</div>`;
    return;
  }

  const { data, error } = await db.from('pran_not_assignments').select('*').eq('id', id).maybeSingle();
  if (error || !data) {
    document.getElementById('assignment-root').innerHTML = `<div class="alert alert-error">${esc(t('errors.not_found'))}</div>`;
    return;
  }
  assignment = data;

  if (assignment.course_id) {
    const { data: c } = await db.from('pran_not_courses').select('*').eq('id', assignment.course_id).maybeSingle();
    course = c;
  }

  setTutorContext({
    contextType: 'assignment',
    contextId: assignment.id,
    contextTitle: assignment.title,
    contextText: `Devwa: ${assignment.title}\nEnstriksyon: ${assignment.instructions || ''}`,
    courseId: assignment.course_id,
  });

  await renderPage();
})();
