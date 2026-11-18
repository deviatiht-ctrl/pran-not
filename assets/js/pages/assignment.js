/* =====================================================================
   PRAN NÒT - pages/assignment.js
   Atelier de devoir : éditeur, assistant IA de rédaction et méthodologie
   (résolution complète, plan, pistes, cohérence, bibliographie, reformulation),
   page de couverture et export PDF/Word.
   ===================================================================== */
import '../supabase.js';
import { requireAuth } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, getLang, formatDate } from '../i18n.js';
import {
  icons, icon, esc, getParam, isUuid, toast, handleError, setLoading,
  loadScript, loadStyle, CDN, sanitizeHtml, pageEnter, checkFileSize,
  openModal,
} from '../utils.js';
import { assistAssignment } from '../ai.js';
import { exportAssignmentPdf, exportAssignmentDocx } from '../export.js';
import { cacheSet, cacheGet, enqueue, isNetworkError } from '../offline.js';

const db = window.db;
let userRef = null;
let profileRef = null;
let assignment = null;
let course = null;
let quill = null;
let currentScope = localStorage.getItem('prannot.assignment_scope') || 'global';

function insertTextInEditor(textToInsert) {
  if (!textToInsert) return;
  if (quill?.insertText && quill?.getLength) {
    const idx = Math.max(0, quill.getLength() - 1);
    quill.insertText(idx, `\n\n${textToInsert}\n`);
  } else {
    const fb = document.getElementById('asg-quill-fallback');
    if (fb) {
      fb.value = `${fb.value}\n\n${textToInsert}\n`.trim();
    }
  }
  toast(t('common.saved'), 'success');
}

function replaceTextInEditor(textToReplace) {
  if (!textToReplace) return;
  const confirmMsg = t('assignments.replace_confirm') || 'Èske ou vle ranplase tout tèks devwa a nèt ak nouvo vèsyon sa a?';
  if (!window.confirm(confirmMsg)) return;
  if (quill?.setText) {
    quill.setText(`${textToReplace}\n`);
  } else if (quill?.root) {
    quill.root.innerHTML = `<p>${esc(textToReplace).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
  } else {
    const fb = document.getElementById('asg-quill-fallback');
    if (fb) fb.value = textToReplace;
  }
  toast(t('common.saved'), 'success');
}

async function copyTextToClipboard(text) {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(t('assignments.copied') || 'Kopye!', 'success');
  } catch {
    toast('Echèk kopye', 'warning');
  }
}

function syncPageScopeUI() {
  const btnG = document.getElementById('asg-scope-btn-global');
  const btnF = document.getElementById('asg-scope-btn-faculty');
  if (btnG && btnF) {
    if (currentScope === 'global') {
      btnG.classList.add('active');
      btnF.classList.remove('active');
    } else {
      btnF.classList.add('active');
      btnG.classList.remove('active');
    }
  }
}

function renderAiPlan(plan, librarySources = []) {
  const box = document.getElementById('asg-ai-output');
  if (!box) return;
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
  const corrections = Array.isArray(plan?.corrections) ? plan.corrections : [];

  let contentHtml = '';

  if (plan?.content_proposal) {
    contentHtml += `
      <div class="row-between mb-2" style="flex-wrap:wrap;gap:8px;">
        <div class="ai-suggestion-label">${icon('sparkles')}<span>Pwopozisyon Redaksyon IA</span></div>
        <div class="row-wrap" style="gap:6px;">
          <button type="button" class="btn btn-sm btn-primary" id="asg-insert-proposal-btn">${icon('plus')}<span>${esc(t('assignments.insert_in_draft'))}</span></button>
          <button type="button" class="btn btn-sm btn-warning" id="asg-replace-proposal-btn">${icon('check')}<span>${esc(t('assignments.replace_all'))}</span></button>
          <button type="button" class="btn btn-sm btn-secondary" id="asg-copy-proposal-btn">${icon('copy')}<span>${esc(t('assignments.copy') || 'Kopye')}</span></button>
        </div>
      </div>
      <div class="card card-sm mb-3" style="background:var(--c-surface);"><p class="text-sm mb-0" id="asg-proposal-text" style="white-space:pre-wrap;">${esc(plan.content_proposal)}</p></div>
      ${plan.explanation ? `<div class="mb-2"><strong>Demach & Esplikasyon :</strong><p class="text-sm mb-0">${esc(plan.explanation)}</p></div>` : ''}
    `;
  } else if (plan?.detailed_breakdown || plan?.global_summary) {
    contentHtml += `
      <div class="ai-suggestion-label mb-2">${icon('book-open')}<span>${esc(t('assignments.explain_details_title'))}</span></div>
      ${plan.global_summary ? `<div class="card card-sm mb-3" style="background:var(--c-surface);"><strong class="text-xs" style="text-transform:uppercase;">Rezime Jeneral :</strong><p class="text-sm mt-1 mb-0">${esc(plan.global_summary)}</p></div>` : ''}
      ${Array.isArray(plan.detailed_breakdown) ? `
        <div class="stack-sm mb-3">
          ${plan.detailed_breakdown.map((item) => `
            <div class="card card-sm" style="border-left:3px solid var(--c-primary,#1B2A4A);">
              <strong>${esc(item.part || 'Pati')}</strong>
              <p class="text-sm mt-1 mb-0" style="white-space:pre-wrap;">${esc(item.explanation || '')}</p>
            </div>
          `).join('')}
        </div>
      ` : ''}
      ${Array.isArray(plan.key_learnings) && plan.key_learnings.length ? `<div class="mt-2"><strong>Konsèp kle pou metrize :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${plan.key_learnings.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></div>` : ''}
      ${Array.isArray(plan.oral_defense_tips) && plan.oral_defense_tips.length ? `<div class="mt-2"><strong>Konsèy pou defann devwa a devan pwofesè a :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${plan.oral_defense_tips.map((tip) => `<li>${esc(tip)}</li>`).join('')}</ul></div>` : ''}
    `;
  } else if (plan?.verdict || plan?.score_estimate) {
    contentHtml += `
      <div class="row-between mb-2">
        <div class="ai-suggestion-label">${icon('award')}<span>Rezilta Verifikasyon Devoir</span></div>
        ${plan.score_estimate ? `<span class="badge badge-success font-bold text-sm">${esc(plan.score_estimate)}</span>` : ''}
      </div>
      ${plan.verdict ? `<div class="mb-2"><strong>Konklizyon :</strong> <span class="badge">${esc(plan.verdict)}</span></div>` : ''}
    `;
  } else if (plan?.answer) {
    contentHtml += `
      <div class="row-between mb-2" style="flex-wrap:wrap;gap:8px;">
        <div class="ai-suggestion-label">${icon('sparkles')}<span>Repons IA Dirèk</span></div>
        <div class="row-wrap" style="gap:6px;">
          <button type="button" class="btn btn-sm btn-primary" id="asg-insert-answer-btn">${icon('plus')}<span>${esc(t('assignments.insert_in_draft'))}</span></button>
          <button type="button" class="btn btn-sm btn-warning" id="asg-replace-answer-btn">${icon('check')}<span>${esc(t('assignments.replace_all'))}</span></button>
          <button type="button" class="btn btn-sm btn-secondary" id="asg-copy-answer-btn">${icon('copy')}<span>${esc(t('assignments.copy') || 'Kopye')}</span></button>
        </div>
      </div>
      <div class="card card-sm mb-2" style="background:var(--c-surface);"><p class="text-sm mb-0" id="asg-answer-text" style="white-space:pre-wrap;">${esc(plan.answer)}</p></div>
    `;
  } else {
    contentHtml += `<div class="ai-suggestion-label">${icon('sparkles')}<span>Gid metodolojik IA</span></div>`;
  }

  if (synthesisNotes.length) contentHtml += `<div class="mt-2"><strong>Sentèz dokimantè (Bibliyotèk san plajya) :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${synthesisNotes.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
  if (legalCitations.length) contentHtml += `<div class="mt-2"><strong>Referans lwa ak atik egzak :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${legalCitations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
  if (outline.length) {
    contentHtml += `<div class="mt-2">${outline.map((sec) => `
      <div class="mb-2">
        <strong>${esc(sec.section)}</strong>
        <ul class="text-sm mb-0" style="padding-left:1.3em;">${(sec.points || []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      </div>`).join('')}</div>`;
  }
  if (leads.length) contentHtml += `<div class="mt-2"><strong>Pis rechèch :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${leads.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
  if (sources.length) contentHtml += `<div class="mt-2"><strong>Sous pou chèche :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${sources.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
  if (strengths.length) contentHtml += `<div class="mt-2"><strong>Pwen fò ki byen fèt :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
  if (issues.length) contentHtml += `<div class="mt-2"><strong>Pwen pou amelyore oswa erè :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`;
  if (corrections.length) contentHtml += `<div class="mt-2"><strong>Koreksyon egzakt :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${corrections.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`;
  if (plan?.suggestion) contentHtml += `<div class="mt-2"><strong>Pwopozisyon refòmilasyon :</strong><p class="text-sm mb-0">${esc(plan.suggestion)}</p></div>`;
  if (tips.length) contentHtml += `<div class="mt-2"><strong>Konsèy :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${tips.map((tp) => `<li>${esc(tp)}</li>`).join('')}</ul></div>`;

  if (librarySources.length) {
    contentHtml += `
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
      </div>`;
  }

  box.innerHTML = contentHtml;

  box.querySelector('#asg-insert-proposal-btn')?.addEventListener('click', () => {
    insertTextInEditor(plan?.content_proposal);
  });
  box.querySelector('#asg-replace-proposal-btn')?.addEventListener('click', () => {
    replaceTextInEditor(plan?.content_proposal);
  });
  box.querySelector('#asg-copy-proposal-btn')?.addEventListener('click', () => {
    copyTextToClipboard(plan?.content_proposal);
  });

  box.querySelector('#asg-insert-answer-btn')?.addEventListener('click', () => {
    insertTextInEditor(plan?.answer);
  });
  box.querySelector('#asg-replace-answer-btn')?.addEventListener('click', () => {
    replaceTextInEditor(plan?.answer);
  });
  box.querySelector('#asg-copy-answer-btn')?.addEventListener('click', () => {
    copyTextToClipboard(plan?.answer);
  });

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

function openAiWriterModal({ initialQuestion = '', initialAction = 'solve', autoRun = false } = {}) {
  const facName = profileRef?.faculty?.name_fr || profileRef?.faculty_id || t('assignments.domain_faculty');
  const existingInst = document.getElementById('asg-inst-ed')?.value?.trim() || assignment?.instructions || '';
  const defaultPrompt = initialQuestion || existingInst || '';

  const modalBody = `
    <div class="stack" style="gap:14px;">
      <div>
        <label class="text-xs font-bold muted mb-1" style="display:block;text-transform:uppercase;">${esc(t('assignments.domain_label'))}</label>
        <div class="segmented" style="display:flex;width:100%;">
          <button type="button" class="btn btn-sm ${currentScope === 'global' ? 'active' : ''}" id="modal-scope-global" style="flex:1;">
            ${icon('sparkles')}<span>${esc(t('assignments.domain_general'))}</span>
          </button>
          <button type="button" class="btn btn-sm ${currentScope === 'faculty' ? 'active' : ''}" id="modal-scope-faculty" style="flex:1;">
            ${icon('book-open')}<span>${esc(facName)}</span>
          </button>
        </div>
      </div>

      <div class="field mb-0">
        <label for="modal-work-type" class="text-xs font-bold muted" style="text-transform:uppercase;">${esc(t('assignments.work_type_label'))}</label>
        <select class="select" id="modal-work-type">
          <option value="solve" ${initialAction === 'solve' ? 'selected' : ''}>${esc(t('assignments.work_type_full'))}</option>
          <option value="exercise" ${initialAction === 'exercise' ? 'selected' : ''}>${esc(t('assignments.work_type_exercise'))}</option>
          <option value="conjugation" ${initialAction === 'conjugation' ? 'selected' : ''}>${esc(t('assignments.work_type_conjugation'))}</option>
          <option value="develop" ${initialAction === 'develop' ? 'selected' : ''}>${esc(t('assignments.work_type_develop'))}</option>
          <option value="plan" ${initialAction === 'plan' ? 'selected' : ''}>${esc(t('assignments.work_type_plan'))}</option>
          <option value="qa" ${initialAction === 'qa' ? 'selected' : ''}>${esc(t('assignments.work_type_qa'))}</option>
        </select>
      </div>

      <div class="field mb-0">
        <label for="modal-prompt" class="text-xs font-bold muted" style="text-transform:uppercase;">${esc(t('assignments.prompt_instructions_label'))}</label>
        <textarea class="textarea" id="modal-prompt" rows="4" placeholder="${esc(t('assignments.prompt_instructions_ph'))}">${esc(defaultPrompt)}</textarea>
      </div>

      <div class="row-between" style="flex-wrap:wrap;gap:8px;">
        <label class="switch">
          <input type="checkbox" id="modal-use-draft" ${quill?.getText()?.trim()?.length > 10 ? 'checked' : ''}>
          <span class="switch-track"></span>
          <span class="text-sm">Mete kòmansman tèks devwa a kòm referans</span>
        </label>
        <button type="button" class="btn btn-primary" id="modal-run-btn" style="min-width:170px;">
          ${icon('sparkles')}<span>${esc(t('assignments.run_generation'))}</span>
        </button>
      </div>

      <div id="modal-result-box" hidden class="mt-3 pt-3" style="border-top:1px solid var(--c-border);"></div>
    </div>
  `;

  const m = openModal({
    title: t('assignments.ai_writer_title'),
    body: modalBody,
    size: 'lg',
  });

  const modalEl = m.el;
  const btnGlobal = modalEl.querySelector('#modal-scope-global');
  const btnFaculty = modalEl.querySelector('#modal-scope-faculty');
  const workTypeSelect = modalEl.querySelector('#modal-work-type');
  const promptInput = modalEl.querySelector('#modal-prompt');
  const useDraftCb = modalEl.querySelector('#modal-use-draft');
  const runBtn = modalEl.querySelector('#modal-run-btn');
  const resultBox = modalEl.querySelector('#modal-result-box');

  let modalScope = currentScope;

  const syncModalScopeUI = () => {
    if (modalScope === 'global') {
      btnGlobal?.classList.add('active');
      btnFaculty?.classList.remove('active');
    } else {
      btnFaculty?.classList.add('active');
      btnGlobal?.classList.remove('active');
    }
  };

  btnGlobal?.addEventListener('click', () => {
    modalScope = 'global';
    currentScope = 'global';
    localStorage.setItem('prannot.assignment_scope', 'global');
    syncModalScopeUI();
    syncPageScopeUI();
  });

  btnFaculty?.addEventListener('click', () => {
    modalScope = 'faculty';
    currentScope = 'faculty';
    localStorage.setItem('prannot.assignment_scope', 'faculty');
    syncModalScopeUI();
    syncPageScopeUI();
  });

  const executeGeneration = async () => {
    const q = promptInput?.value?.trim();
    if (!q) {
      toast(t('errors.required'), 'warning');
      promptInput?.focus();
      return;
    }

    setLoading(runBtn, true);
    resultBox.hidden = false;
    resultBox.innerHTML = `
      <div class="card card-sm text-center p-4">
        <div class="spinner mb-2" style="margin:0 auto;"></div>
        <p class="text-sm muted mb-0">IA ap trete devwa a nan mòd <strong>${modalScope === 'global' ? esc(t('assignments.domain_general')) : esc(facName)}</strong>... Tanpri tann kèk segond.</p>
      </div>
    `;

    try {
      const selectedType = workTypeSelect.value;
      let action = 'solve';
      if (selectedType === 'plan') action = 'plan';
      else if (selectedType === 'qa') action = 'qa';
      else if (selectedType === 'exercise' || selectedType === 'conjugation' || selectedType === 'develop') action = 'instruct';

      const draftContent = useDraftCb?.checked ? (quill?.getText()?.trim() || '') : '';
      const useLibrary = modalScope === 'faculty';

      const res = await assistAssignment({
        action,
        title: assignment.title,
        instructions: q,
        content: draftContent,
        question: q,
        scope: modalScope,
        useLibrary,
        language: getLang(),
        faculty: modalScope === 'global' ? 'general' : profileRef?.faculty_id,
        level: profileRef?.level,
      });

      const plan = res.data || {};
      const generatedText = plan.content_proposal || plan.answer || plan.suggestion || (Array.isArray(plan.outline) ? plan.outline.map((o) => `${o.section}:\n${(o.points || []).map((p) => `- ${p}`).join('\n')}`).join('\n\n') : '');

      resultBox.innerHTML = `
        <div class="card card-sm" style="background:var(--c-surface);border:1.5px solid var(--c-primary-soft, #cbd5e1);">
          <div class="row-between mb-2" style="flex-wrap:wrap;gap:8px;">
            <div class="ai-suggestion-label">${icon('sparkles')}<span>Rezilta Redaksyon IA</span></div>
            <div class="row-wrap" style="gap:6px;">
              <button type="button" class="btn btn-sm btn-primary" id="modal-asg-insert-btn">${icon('plus')}<span>${esc(t('assignments.insert_in_draft'))}</span></button>
              <button type="button" class="btn btn-sm btn-warning" id="modal-asg-replace-btn">${icon('check')}<span>${esc(t('assignments.replace_all'))}</span></button>
              <button type="button" class="btn btn-sm btn-secondary" id="modal-asg-copy-btn">${icon('copy')}<span>${esc(t('assignments.copy') || 'Kopye')}</span></button>
            </div>
          </div>
          <div class="prose text-sm" style="white-space:pre-wrap;max-height:360px;overflow-y:auto;padding:10px;background:var(--c-surface-soft);border-radius:var(--r-card);">${esc(generatedText || 'Pa gen tèks jenere.')}</div>
          ${plan.explanation ? `<div class="mt-2 text-xs muted"><strong>Demach & Esplikasyon :</strong> ${esc(plan.explanation)}</div>` : ''}
        </div>
      `;
      icons(resultBox);

      resultBox.querySelector('#modal-asg-insert-btn')?.addEventListener('click', () => {
        insertTextInEditor(generatedText);
        m.close();
      });

      resultBox.querySelector('#modal-asg-replace-btn')?.addEventListener('click', () => {
        replaceTextInEditor(generatedText);
        m.close();
      });

      resultBox.querySelector('#modal-asg-copy-btn')?.addEventListener('click', () => {
        copyTextToClipboard(generatedText);
      });

      assignment.plan = plan;
      renderAiPlan(plan, res.library_sources || []);

    } catch (err) {
      handleError(err);
      resultBox.innerHTML = `<div class="alert alert-error text-sm">${esc(err.message || 'Erè pandan jenerasyon an')}</div>`;
    } finally {
      setLoading(runBtn, false);
    }
  };

  runBtn?.addEventListener('click', executeGeneration);
  icons(modalEl);

  if (autoRun && defaultPrompt) {
    executeGeneration();
  }
}

async function renderPage() {
  const root = document.getElementById('assignment-root');
  const cov = assignment.cover || {};
  const facName = profileRef?.faculty?.name_fr || profileRef?.faculty_id || t('assignments.domain_faculty');

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
        <!-- Onglets Editeur / Aperçu / Verifikasyon IA -->
        <div class="segmented mb-2" role="tablist">
          <button type="button" class="btn btn-sm" role="tab" id="tab-btn-editor" aria-selected="true">
            ${icon('edit-3')}<span>${esc(t('assignments.tab_editor'))}</span>
          </button>
          <button type="button" class="btn btn-sm" role="tab" id="tab-btn-preview" aria-selected="false">
            ${icon('eye')}<span>${esc(t('assignments.tab_preview'))}</span>
          </button>
          <button type="button" class="btn btn-sm" role="tab" id="tab-btn-critique" aria-selected="false">
            ${icon('check-circle-2')}<span>${esc(t('assignments.tab_critique'))}</span>
          </button>
        </div>

        <!-- Section 1 : Editeur -->
        <section class="card" id="pane-editor">
          <!-- Hero IA Redaksyon Card -->
          <div class="card mb-4" style="background:linear-gradient(135deg, rgba(27,42,74,0.06), rgba(224,90,43,0.08));border:1.5px solid var(--c-primary-soft, #cbd5e1);">
            <div class="row-between" style="flex-wrap:wrap;gap:12px;align-items:center;">
              <div style="max-width:540px;">
                <div class="row-wrap" style="gap:8px;align-items:center;margin-bottom:6px;">
                  <span class="badge badge-primary font-bold">${icon('sparkles')} ${esc(t('assignments.ai_writer_title'))}</span>
                  <div class="segmented" id="asg-page-scope-segment" style="display:inline-flex;">
                    <button type="button" class="btn btn-xs ${currentScope === 'global' ? 'active' : ''}" id="asg-scope-btn-global" title="${esc(t('assignments.domain_general'))}">
                      ${esc(t('assignments.domain_general'))}
                    </button>
                    <button type="button" class="btn btn-xs ${currentScope === 'faculty' ? 'active' : ''}" id="asg-scope-btn-faculty" title="${esc(facName)}">
                      ${esc(facName)}
                    </button>
                  </div>
                </div>
                <p class="text-sm muted mb-0">${esc(t('assignments.ai_writer_subtitle'))}</p>
              </div>
              <button type="button" class="btn btn-primary" id="btn-open-ai-writer" style="font-weight:600;padding:10px 18px;">
                ${icon('sparkles')}<span>${esc(t('assignments.ai_writer_btn'))}</span>
              </button>
            </div>
          </div>

          <div class="field mb-3">
            <label for="asg-inst-ed">${esc(t('assignments.instructions'))}</label>
            <textarea class="textarea" id="asg-inst-ed" rows="3">${esc(assignment.instructions || '')}</textarea>
          </div>

          <!-- Quick Actions & Pills -->
          <div class="row-wrap mb-3">
            <button type="button" class="btn btn-sm btn-primary" data-assist="solve">${icon('sparkles')}<span>${esc(t('assignments.assist_solve'))}</span></button>
            <button type="button" class="btn btn-sm btn-secondary" data-assist="plan">${icon('layers')}<span>${esc(t('assignments.assist_plan'))}</span></button>
            <button type="button" class="btn btn-sm btn-secondary" data-assist="explain_details">${icon('book-open')}<span>${esc(t('assignments.assist_explain_details'))}</span></button>
            <button type="button" class="btn btn-sm btn-secondary" data-assist="library_research">${icon('library')}<span>${esc(t('assignments.assist_library'))}</span></button>
            <button type="button" class="btn btn-sm btn-secondary" data-assist="coherence">${esc(t('assignments.assist_coherence'))}</button>
            <button type="button" class="btn btn-sm btn-secondary" data-assist="biblio">${esc(t('assignments.assist_biblio'))}</button>
            <button type="button" class="btn btn-sm btn-secondary" data-assist="rephrase">${esc(t('assignments.assist_rephrase'))}</button>
          </div>

          <!-- Single Quick Prompt Bar -->
          <div class="input-group mb-3">
            <input class="input" id="asg-quick-ai-input" type="text" placeholder="${esc(t('assignments.quick_ai_placeholder'))}">
            <button type="button" class="btn btn-secondary" id="asg-quick-ai-btn">
              ${icon('sparkles')}<span>${esc(t('assignments.custom_instruction_btn'))}</span>
            </button>
          </div>

          <div class="mb-3">
            <label class="switch">
              <input type="checkbox" id="asg-use-library" ${currentScope === 'faculty' ? 'checked' : ''}>
              <span class="switch-track"></span>
              <span class="text-sm">${esc(t('assignments.use_library'))}</span>
            </label>
          </div>

          <div class="ai-suggestion mb-4" id="asg-ai-output" ${assignment.plan ? '' : 'hidden'}></div>

          <div class="field mb-0">
            <label>Redaksyon devwa a</label>
            <div id="asg-quill"></div>
          </div>
        </section>

        <!-- Section 2 : Aperçu / Preview -->
        <section class="card" id="pane-preview" hidden>
          <div class="page-head mb-4 pb-2" style="border-bottom:1px solid var(--c-border);">
            <div>
              <span class="badge badge-info">${esc(t('assignments.tab_preview'))}</span>
              <h2 class="mt-2" id="preview-title">${esc(assignment.title)}</h2>
              <div class="text-sm muted" id="preview-meta">
                ${esc(course?.name || '')} • ${esc(profileRef?.full_name || '')} • ${esc(formatDate(new Date()))}
              </div>
            </div>
          </div>
          <div class="mb-4 p-3" style="background:var(--c-surface-soft);border-radius:var(--r-card);">
            <strong>Enstriksyon :</strong>
            <p class="text-sm mb-0 mt-1" id="preview-inst">${esc(assignment.instructions || 'Pa gen enstriksyon.')}</p>
          </div>
          <div id="preview-body" class="prose" style="min-height:240px;line-height:1.6;"></div>
        </section>

        <!-- Section 3 : Verifikasyon / Critique soumission fèt deja sou lòt IA -->
        <section class="card" id="pane-critique" hidden>
          <div class="row-between mb-2">
            <div>
              <h2 class="card-title">${icon('award')} <span>${esc(t('assignments.critique_title'))}</span></h2>
              <p class="text-sm muted mb-0">${esc(t('assignments.critique_desc'))}</p>
            </div>
          </div>

          <div class="field mt-3">
            <label for="asg-critique-text">${esc(t('assignments.critique_paste_label'))}</label>
            <textarea class="textarea" id="asg-critique-text" rows="8" placeholder="Kole tèks devwa a isit la pou IA a analize tout repons yo ak estrikti a..."></textarea>
          </div>

          <div class="row-wrap mb-4">
            <label class="btn btn-secondary btn-sm" style="cursor:pointer;">
              ${icon('upload')}<span>${esc(t('assignments.critique_upload_btn'))}</span>
              <input type="file" id="asg-critique-file" accept=".txt,.md,.pdf,.doc,.docx" style="display:none;">
            </label>
            <button type="button" class="btn btn-primary btn-sm" id="asg-critique-run-btn">
              ${icon('sparkles')}<span>${esc(t('assignments.critique_btn'))}</span>
            </button>
          </div>

          <div class="ai-suggestion" id="asg-critique-output" hidden></div>
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

  try {
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
  } catch {
    const host = document.getElementById('asg-quill');
    if (host) {
      const tmp = document.createElement('div');
      tmp.innerHTML = sanitizeHtml(assignment.content_html || '');
      const plain = tmp.innerText || tmp.textContent || '';
      host.innerHTML = `<textarea class="textarea" id="asg-quill-fallback" rows="12" placeholder="Kòmanse ekri travay ou a...">${esc(plain)}</textarea>`;
      const getTa = () => host.querySelector('#asg-quill-fallback');
      quill = {
        getText: () => getTa()?.value || '',
        getLength: () => (getTa()?.value || '').length + 1,
        setText: (txt) => {
          const ta = getTa();
          if (ta) ta.value = txt;
        },
        insertText: (_idx, txt) => {
          const ta = getTa();
          if (ta) ta.value += txt;
        },
        root: {
          get innerHTML() {
            const val = getTa()?.value || '';
            return `<p>${esc(val).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
          },
          set innerHTML(html) {
            const ta = getTa();
            if (!ta) return;
            const d = document.createElement('div');
            d.innerHTML = html;
            ta.value = d.innerText || d.textContent || '';
          },
        },
      };
    }
  }

  if (assignment.plan) renderAiPlan(assignment.plan);

  const gatherState = () => ({
    instructions: document.getElementById('asg-inst-ed').value.trim(),
    status: document.getElementById('asg-status').value,
    content_html: sanitizeHtml(quill?.root?.innerHTML || ''),
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

  // Gestion des onglets Editeur / Aperçu / Verifikasyon IA
  const tabEditorBtn = document.getElementById('tab-btn-editor');
  const tabPreviewBtn = document.getElementById('tab-btn-preview');
  const tabCritiqueBtn = document.getElementById('tab-btn-critique');
  const paneEditor = document.getElementById('pane-editor');
  const panePreview = document.getElementById('pane-preview');
  const paneCritique = document.getElementById('pane-critique');

  function switchTab(target) {
    if (tabEditorBtn) tabEditorBtn.setAttribute('aria-selected', target === 'editor' ? 'true' : 'false');
    if (tabPreviewBtn) tabPreviewBtn.setAttribute('aria-selected', target === 'preview' ? 'true' : 'false');
    if (tabCritiqueBtn) tabCritiqueBtn.setAttribute('aria-selected', target === 'critique' ? 'true' : 'false');

    if (paneEditor) paneEditor.hidden = target !== 'editor';
    if (panePreview) panePreview.hidden = target !== 'preview';
    if (paneCritique) paneCritique.hidden = target !== 'critique';

    if (target === 'preview') {
      const previewTitle = document.getElementById('preview-title');
      const previewInst = document.getElementById('preview-inst');
      const previewBody = document.getElementById('preview-body');
      if (previewTitle) previewTitle.textContent = assignment.title || '';
      if (previewInst) previewInst.textContent = document.getElementById('asg-inst-ed')?.value || 'Pa gen enstriksyon.';
      if (previewBody) {
        const html = sanitizeHtml(quill?.root?.innerHTML || '');
        previewBody.innerHTML = html || '<p class="muted">Devwa a poko gen tèks redaksyon.</p>';
      }
    }
  }

  tabEditorBtn?.addEventListener('click', () => switchTab('editor'));
  tabPreviewBtn?.addEventListener('click', () => switchTab('preview'));
  tabCritiqueBtn?.addEventListener('click', () => switchTab('critique'));

  // Scope switcher on assignment page
  document.getElementById('asg-scope-btn-global')?.addEventListener('click', () => {
    currentScope = 'global';
    localStorage.setItem('prannot.assignment_scope', 'global');
    syncPageScopeUI();
    const libCb = document.getElementById('asg-use-library');
    if (libCb) libCb.checked = false;
    toast(t('tutor.scope_switched_global'), 'info');
  });

  document.getElementById('asg-scope-btn-faculty')?.addEventListener('click', () => {
    currentScope = 'faculty';
    localStorage.setItem('prannot.assignment_scope', 'faculty');
    syncPageScopeUI();
    const libCb = document.getElementById('asg-use-library');
    if (libCb) libCb.checked = true;
    toast(t('tutor.scope_switched_faculty'), 'info');
  });

  // Hero AI Writer Button
  document.getElementById('btn-open-ai-writer')?.addEventListener('click', () => {
    openAiWriterModal({ initialAction: 'solve' });
  });

  // Quick Prompt AI bar
  const quickAiInput = document.getElementById('asg-quick-ai-input');
  const quickAiBtn = document.getElementById('asg-quick-ai-btn');
  const handleQuickAi = () => {
    const q = quickAiInput?.value?.trim();
    openAiWriterModal({ initialQuestion: q, initialAction: 'solve', autoRun: !!q });
  };
  quickAiBtn?.addEventListener('click', handleQuickAi);
  quickAiInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleQuickAi();
    }
  });

  // Quick assist actions
  root.querySelectorAll('[data-assist]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.assist;
      if (action === 'solve') {
        openAiWriterModal({ initialAction: 'solve' });
        return;
      }
      setLoading(btn, true);
      try {
        const useLibrary = currentScope === 'faculty' && document.getElementById('asg-use-library')?.checked !== false;
        const res = await assistAssignment({
          action,
          title: assignment.title,
          instructions: document.getElementById('asg-inst-ed')?.value?.trim() || '',
          content: quill?.getText()?.trim() || '',
          scope: currentScope,
          useLibrary,
          language: getLang(),
          faculty: currentScope === 'global' ? 'general' : profileRef?.faculty_id,
          level: profileRef?.level,
        });
        renderAiPlan(res.data, res.library_sources || []);
        if (action === 'plan') {
          assignment.plan = res.data;
          await db.from('pran_not_assignments').update({ plan: res.data }).eq('id', assignment.id);
        }
      } catch (err) {
        handleError(err);
      } finally {
        setLoading(btn, false);
      }
    });
  });

  // Verifikasyon & Critique soumission fèt deja sou lòt IA
  const critiqueRunBtn = document.getElementById('asg-critique-run-btn');
  const critiqueText = document.getElementById('asg-critique-text');
  const critiqueFile = document.getElementById('asg-critique-file');
  const critiqueOut = document.getElementById('asg-critique-output');

  critiqueFile?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type.includes('text') || file.name.endsWith('.txt') || file.name.endsWith('.md')) {
      const txt = await file.text();
      if (critiqueText) critiqueText.value = txt;
      toast(t('common.saved'), 'success');
    } else {
      toast('Fichye tèks chaje', 'info');
      if (critiqueText && !critiqueText.value.trim()) {
        critiqueText.value = `[Fichye : ${file.name}]`;
      }
    }
  });

  critiqueRunBtn?.addEventListener('click', async () => {
    const submittedContent = critiqueText?.value?.trim() || quill?.getText()?.trim();
    if (!submittedContent) {
      toast(t('errors.required'), 'warning');
      return;
    }
    setLoading(critiqueRunBtn, true);
    try {
      const res = await assistAssignment({
        action: 'critique_submission',
        title: assignment.title,
        instructions: document.getElementById('asg-inst-ed')?.value?.trim(),
        content: submittedContent,
        scope: currentScope,
        language: getLang(),
        faculty: currentScope === 'global' ? 'general' : profileRef?.faculty_id,
        level: profileRef?.level,
      });
      if (critiqueOut) {
        critiqueOut.hidden = false;
        const plan = res.data || {};
        const strengths = Array.isArray(plan.strengths) ? plan.strengths : [];
        const issues = Array.isArray(plan.issues) ? plan.issues : [];
        const corrections = Array.isArray(plan.corrections) ? plan.corrections : [];
        const tips = Array.isArray(plan.tips) ? plan.tips : [];

        critiqueOut.innerHTML = `
          <div class="row-between mb-2">
            <div class="ai-suggestion-label">${icon('award')}<span>Rezilta Analiz & Verifikasyon</span></div>
            ${plan.score_estimate ? `<span class="badge badge-success font-bold">${esc(plan.score_estimate)}</span>` : ''}
          </div>
          ${plan.verdict ? `<div class="mb-2"><strong>Konklizyon :</strong> <span class="badge">${esc(plan.verdict)}</span></div>` : ''}
          ${strengths.length ? `<div class="mt-2"><strong>Pwen ki kòrèk :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
          ${issues.length ? `<div class="mt-2"><strong>Erè oswa pwen ki manke :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>` : ''}
          ${corrections.length ? `<div class="mt-2"><strong>Koreksyon egzat pou aplike :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${corrections.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
          ${tips.length ? `<div class="mt-2"><strong>Konsèy :</strong><ul class="text-sm mb-0" style="padding-left:1.3em;">${tips.map((tp) => `<li>${esc(tp)}</li>`).join('')}</ul></div>` : ''}
        `;
        icons(critiqueOut);
      }
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(critiqueRunBtn, false);
    }
  });

  document.getElementById('asg-save-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    const patch = gatherState();
    const saveOffline = async () => {
      assignment = { ...assignment, ...patch };
      await cacheSet(`assignment_${assignment.id}`, { assignment, course });
      await enqueue('assignment_update', { assignment_id: assignment.id, patch });
      toast(t('offline.saved_locally'), 'info');
    };
    if (!navigator.onLine) {
      try { await saveOffline(); } finally { setLoading(btn, false); }
      return;
    }
    try {
      const { data, error } = await db.from('pran_not_assignments').update(patch).eq('id', assignment.id).select().single();
      if (error) throw error;
      assignment = data;
      await cacheSet(`assignment_${assignment.id}`, { assignment, course });
      toast(t('common.saved'), 'success');
    } catch (err) {
      if (isNetworkError(err)) await saveOffline();
      else handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  document.getElementById('asg-pdf-btn')?.addEventListener('click', async () => {
    await exportAssignmentPdf({ ...assignment, ...gatherState() }, profileRef, course);
  });
  document.getElementById('asg-docx-btn')?.addEventListener('click', async () => {
    await exportAssignmentDocx({ ...assignment, ...gatherState() }, profileRef, course);
  });

  await loadAttachedFiles();
  document.getElementById('asg-file-up')?.addEventListener('change', async (e) => {
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
  if (!box) return;
  if (!navigator.onLine) {
    const cachedFiles = await cacheGet(`assignment_files_${assignment.id}`);
    box.innerHTML = (cachedFiles || []).map((f) => `<div class="text-xs muted truncate">${esc(f.name)}</div>`).join('');
    return;
  }
  const { data } = await db.from('pran_not_assignment_files').select('*').eq('assignment_id', assignment.id);
  if (data) await cacheSet(`assignment_files_${assignment.id}`, data);
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

  const cachedAsg = await cacheGet(`assignment_${id}`);
  if (cachedAsg?.assignment && !navigator.onLine) {
    assignment = cachedAsg.assignment;
    course = cachedAsg.course || null;
  } else {
    try {
      const { data, error } = await db.from('pran_not_assignments').select('*').eq('id', id).maybeSingle();
      if (error || !data) throw error || new Error('not_found');
      assignment = data;

      if (assignment.course_id) {
        const { data: c } = await db.from('pran_not_courses').select('*').eq('id', assignment.course_id).maybeSingle();
        course = c;
      }
      await cacheSet(`assignment_${id}`, { assignment, course });
    } catch {
      if (cachedAsg?.assignment) {
        assignment = cachedAsg.assignment;
        course = cachedAsg.course || null;
      } else {
        document.getElementById('assignment-root').innerHTML = `<div class="alert alert-error">${esc(t('errors.not_found'))}</div>`;
        return;
      }
    }
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
