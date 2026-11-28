/* =====================================================================
   PRAN NÒT - pages/note-view.js
   Affichage d'une note propre + sources originales + actions IA :
   flashcards, quiz, simplification, tuteur, export PDF/Word/MD, partage.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, appUrl, recordActivity, awardXp } from '../auth.js';
import { initAppChrome, setTutorContext, toggleTutorDrawer } from '../navbar.js';
import { t, getLang, formatDate } from '../i18n.js';
import {
  icons, icon, esc, sanitizeHtml, renderMarkdown, openModal, confirmDialog,
  toast, handleError, setLoading, getParam, isUuid, pageEnter, promptDialog,
  htmlToText, uid,
} from '../utils.js';
import { generateFlashcards, generateTest, explainText, processNote, askTutor, correctRawTextSense, generateProfessorQuestions, kreyolizeTextOrHtml, makeSimpleCreoleSummary } from '../ai.js';
import { exportNotePdf, exportNoteDocx, exportNoteMarkdown, batchPrintNotes } from '../export.js';
import {
  cacheSet, cacheGet, cacheEntriesByPrefix, isDataSaver, enqueue,
  getQueueItems, updateQueuedNotePayload, removeQueueItem, isNetworkError,
} from '../offline.js';
import { openSendTransferModal, openReceiveTransferModal } from '../live-transfer.js';
import { playNotificationSound } from '../notifications.js';

const db = window.db;
let note = null;
let course = null;
let suggestedCourse = null;
let sources = [];
let profileRef = null;
let userRef = null;

function getFullNoteContent() {
  if (!note) return '';
  const parts = [];
  if (note.title) parts.push(`Tit: ${note.title}`);
  if (note.summary) parts.push(`Rezime: ${note.summary}`);
  if (note.content_text) {
    parts.push(note.content_text);
  } else if (note.content_html) {
    parts.push(htmlToText(note.content_html));
  }
  if (note.raw_text && note.raw_text !== note.content_text) {
    parts.push(`Tèks brit:\n${note.raw_text}`);
  }
  return parts.join('\n\n').trim();
}

async function renderNote() {
  const root = document.getElementById('note-root');
  if (!note) return;

  const isFr = getLang() === 'fr';
  const st = note.structured || {};
  const takeaways = Array.isArray(st.takeaways) ? st.takeaways : [];
  const implied = Array.isArray(st.implied_points) ? st.implied_points : [];
  const keywords = Array.isArray(st.keywords) ? st.keywords : [];
  const corrections = Array.isArray(st.corrections) ? st.corrections : [];
  const homework = Array.isArray(st.homework) ? st.homework : [];
  const researchTopics = Array.isArray(st.research_topics) ? st.research_topics : [];
  const verbatimRaw = st.verbatim_raw || '';
  const profQuestions = Array.isArray(st.questions_for_professor) ? st.questions_for_professor : (Array.isArray(note.questions_for_professor) ? note.questions_for_professor : []);

  const getFullNoteContent = () => {
    const parts = [];
    if (note.title) parts.push(`Tit: ${note.title}`);
    if (note.summary) parts.push(`Rezime: ${note.summary}`);
    if (note.content_text) {
      parts.push(note.content_text);
    } else if (note.content_html) {
      parts.push(htmlToText(note.content_html));
    }
    if (note.raw_text && note.raw_text !== note.content_text) {
      parts.push(`Tèks brit:\n${note.raw_text}`);
    }
    return parts.join('\n\n').trim();
  };

  // Bay kontèks nòt la an tan reyèl bay tuteur IA nan ba navigasyon an
  window.__getLiveNoteContext = () => ({
    text: getFullNoteContent(),
    title: note?.title || t('notes.untitled'),
    contextType: 'note',
    contextId: note?.id,
    courseId: note?.course_id || null,
  });

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="row-wrap mb-2">
          <a class="btn btn-sm btn-ghost" href="./notes.html">${icon('arrow-left')}<span>${esc(t('common.back'))}</span></a>
          ${course
            ? `<a class="badge badge-outline" href="./course.html?id=${esc(course.id)}"><span class="course-dot" style="background:${esc(course.color || '#F97316')}"></span><span>${esc(course.name)}</span></a>`
            : ''}
          <button type="button" class="btn btn-sm ${course ? 'btn-ghost' : 'btn-secondary'}" id="btn-assign-course">
            ${icon('folder-plus')}<span>${esc(course ? t('notes.change_course') : t('notes.assign_course'))}</span>
          </button>
          <span class="badge">${esc(formatDate(note.updated_at || note.created_at))}</span>
        </div>
        <h1>${esc(note.title || t('notes.untitled'))}</h1>
      </div>
      <div class="page-head-actions">
        ${note.is_local_draft ? `
          <button type="button" class="btn btn-primary btn-sm" id="btn-header-finalize-draft" style="font-weight:700;">
            ${icon('check-circle')}<span>${esc(t('notes.btn_finalize_draft') || 'Fini & Anrejistre')}</span>
          </button>
        ` : ''}
        <button type="button" class="btn btn-secondary btn-sm" id="btn-live-transfer" title="${esc(t('transfer.send_title'))}">
          ${icon('share-2')}<span>${esc(t('notes.btn_transfer'))}</span>
        </button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-translate-note" title="${esc(t('live.translate_btn'))}">
          ${icon('languages')}<span>${esc(t('notes.btn_translate'))}</span>
        </button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-continue-recording" title="${esc(t('capture.btn_continue_rec_title') || 'Continuer à enregistrer le cours')}">
          ${icon('mic')}<span>${esc(t('capture.continue_recording') || 'Kontinye anrejistre')}</span>
        </button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-add-board-photo" title="${esc(t('capture.btn_add_board_photo_title') || 'Ajouter une photo du tableau')}">
          ${icon('camera')}<span>${esc(t('capture.add_board_photo') || 'Ajoute foto tablo')}</span>
        </button>
        <button type="button" class="btn btn-primary btn-sm" id="btn-edit-note" title="${esc(t('capture.btn_edit_title') || 'Ouvri nan estidyo kaptire pou modifye nòt la')}">
          ${icon('edit-3')}<span>${esc(t('common.edit'))}</span>
        </button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-print-note" title="${esc(t('notes.btn_print_title') || 'Imprimer cette note (PDF)')}">
          ${icon('printer')}<span>${esc(t('notes.btn_print') || 'Imprimer')}</span>
        </button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-share-note">${icon('users')}<span>${esc(t('notes.btn_share_group'))}</span></button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-export-note">${icon('download')}<span>${esc(t('notes.btn_export'))}</span></button>
        <button type="button" class="btn btn-danger btn-sm" id="btn-delete-note">${icon('trash-2')}<span>${esc(t('common.delete'))}</span></button>
      </div>
    </div>

    ${note.is_local_draft ? `
      <div class="alert alert-warning row-between mb-4" style="border-left:4px solid var(--c-warning,#f59e0b);flex-wrap:wrap;gap:12px;">
        <div class="row" style="gap:10px;">
          ${icon('file-edit')}
          <div>
            <strong>${esc(t('notes.local_draft') || 'Bwouyon lokal')}</strong>
            <p class="text-sm mb-0">${esc(t('notes.draft_banner_text') || 'Sa se yon bwouyon ki poko anrejistre definitivman.')}</p>
          </div>
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-success" id="btn-banner-finalize-draft" style="font-weight:700;">
            ${icon('check-circle')}<span>${esc(t('notes.btn_finalize_draft') || 'Fini & Anrejistre nòt sa')}</span>
          </button>
          <a href="${esc(note.draft_target || './note-capture.html')}" class="btn btn-sm btn-primary">
            ${icon('pencil')}<span>${esc(t('notes.continue_draft') || 'Kontinye ekri')}</span>
          </a>
        </div>
      </div>` : ''}

    ${(!note.course_id && suggestedCourse) ? `
      <div class="ai-suggestion mb-6 row-between">
        <div>
          <div class="ai-suggestion-label">${icon('sparkles')}<span>IA</span></div>
          <div>${esc(t('capture.suggested_course', { course: suggestedCourse.name }))}</div>
        </div>
        <button type="button" class="btn btn-sm btn-primary" id="btn-confirm-course">${esc(t('capture.confirm_course'))}</button>
      </div>` : ''}

    <!-- Barre d'actions IA sur la note -->
    <div class="row-wrap mb-4">
      <button type="button" class="btn btn-primary" id="btn-view-re-structure" title="${isFr ? 'Générer la version bilingue complète avec explications simples et Q&R' : 'Mete nòt la an biling konplè ak eksplikasyon senp ak Q&A'}">
        ${icon('sparkles')}<span>${isFr ? 'Structurer en Bilingue (FR + HT + Q&R)' : 'Estriktire an Biling (FR + HT + Q&A)'}</span>
      </button>
      <button type="button" class="btn btn-secondary" id="btn-gen-cards">${icon('layers')}<span>${esc(t('notes.btn_flashcards'))}</span></button>
      <button type="button" class="btn btn-dark" id="btn-gen-quiz">${icon('check-circle-2')}<span>${esc(t('notes.btn_quiz'))}</span></button>
      <button type="button" class="btn btn-secondary" id="btn-prof-questions" title="${esc(t('notes.prof_questions_btn_title') || 'Jenere kesyon pètinan pou poze pwofesè a')}">
        ${icon('help-circle')}<span>${esc(t('notes.prof_questions_btn') || 'Kesyon pou Pwofesè a')}</span>
      </button>
      <button type="button" class="btn btn-secondary" id="btn-points-summary" title="${esc(t('notes.bullet_summary_title'))}">
        ${icon('list-checks')}<span>${esc(t('notes.btn_points_summary'))}</span>
      </button>
      <button type="button" class="btn btn-secondary" id="btn-simpler">${icon('sparkles')}<span>${esc(t('notes.btn_simpler'))}</span></button>
      <button type="button" class="btn btn-secondary" id="btn-ask-tutor">${icon('message-square')}<span>${esc(t('notes.btn_tutor'))}</span></button>
      ${note.raw_text ? `<button type="button" class="btn btn-secondary" id="btn-fix-raw-sense" title="${esc(t('capture.fix_raw_sense_title') || 'Kore sans tèks la')}">${icon('wand-2')}<span>${esc(t('capture.fix_raw_sense') || 'Kore sans & koerans')}</span></button>` : ''}
      ${!note.structured && note.raw_text ? `<button type="button" class="btn btn-secondary" id="btn-ai-clean">${icon('wand-2')}<span>${esc(t('capture.structure_ai'))}</span></button>` : ''}
    </div>

    <!-- Modil Asistan IA Kou & Definisyon Rapid -->
    <section class="card mb-6" id="note-view-quick-ai-card" style="background:linear-gradient(135deg, rgba(27,42,74,0.04), rgba(224,90,43,0.06));border:1.5px solid var(--c-primary-soft, #cbd5e1);">
      <div class="row-between mb-2" style="flex-wrap:wrap;gap:8px;align-items:center;">
        <div class="row" style="gap:8px;align-items:center;">
          <span class="badge badge-primary font-bold">${icon('sparkles')} <span>${esc(t('capture.quick_ai_title'))}</span></span>
          <span class="text-xs muted">${esc(t('capture.quick_ai_sub'))}</span>
        </div>
        <div class="segmented" id="nv-ai-scope-segment" style="display:inline-flex;">
          <button type="button" class="btn btn-xs active" id="nv-ai-scope-global" title="Reponn selon konesans inivèsèl">
            <span>${esc(t('capture.scope_general') || 'Jeneral')}</span>
          </button>
          <button type="button" class="btn btn-xs" id="nv-ai-scope-faculty" title="Reponn selon fakilte w la">
            <span id="nv-ai-fac-name">${esc(profileRef?.faculty?.name_fr || profileRef?.faculty_id || t('capture.scope_faculty') || 'Fakilte')}</span>
          </button>
        </div>
      </div>

      <div class="input-group mb-2">
        <input type="text" class="input" id="nv-quick-ai-input" placeholder="${esc(t('capture.quick_ai_ph'))}">
        <button type="button" class="btn btn-primary" id="nv-quick-ai-btn" style="min-width:110px;">
          ${icon('sparkles')}
          <span>${esc(t('capture.quick_ai_ask_btn'))}</span>
        </button>
      </div>

      <div class="row-wrap mb-2" style="gap:6px;" id="nv-quick-ai-chips">
        <button type="button" class="btn btn-xs btn-outline" data-quick-prompt="Defini byen klè epi bay yon egzanp konkrè : ">${esc(t('capture.chip_def_example'))}</button>
        <button type="button" class="btn btn-xs btn-outline" data-quick-prompt="Eksplike nosyon sa a senpleman an 2 fraz : ">${esc(t('capture.chip_short_explain'))}</button>
        <button type="button" class="btn btn-xs btn-outline" data-quick-prompt="Bay fòmil, prensip oswa atik lwa ki gen rapò ak : ">${esc(t('capture.chip_formula_law'))}</button>
        <button type="button" class="btn btn-xs btn-outline" data-quick-prompt="Ki diferans ki genyen ant : ">${esc(t('capture.chip_comparison'))}</button>
      </div>

      <div id="nv-quick-ai-result" class="mt-3" hidden></div>
    </section>

    <div class="grid grid-main-side">
      <div class="stack">
        ${st.content_html_ht ? `
          <div class="card card-sm mb-3" style="background:var(--c-surface-soft);border:1px solid var(--c-border);">
            <div class="row-between" style="flex-wrap:wrap;gap:8px;align-items:center;">
              <div class="row" style="gap:6px;align-items:center;">
                <span class="badge badge-primary font-bold">${icon('languages')} <span>${esc(t('notes.note_version_title') || 'Vèsyon Nòt')}</span></span>
                <span class="text-xs muted">${esc(t('notes.note_version_sub') || 'Chwazi fòma w vle li a :')}</span>
              </div>
              <div class="segmented" id="note-lang-toggle" style="display:inline-flex;">
                <button type="button" class="btn btn-xs active" data-lang-view="both">
                  ${icon('layers')}<span>${esc(t('notes.note_version_both') || 'Tout 2 (FR + HT)')}</span>
                </button>
                <button type="button" class="btn btn-xs" data-lang-view="fr">
                  <span>${esc(t('notes.note_version_fr') || 'Français')}</span>
                </button>
                <button type="button" class="btn btn-xs" data-lang-view="ht">
                  <span>${esc(t('notes.note_version_ht') || 'Kreyòl')}</span>
                </button>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- Conteneur Vèsyon Fransè -->
        <div id="note-section-fr" class="stack" style="gap:12px;">
          ${note.summary ? `
            <section class="card card-accent">
              <div class="row-between mb-1">
                <h2 class="card-title text-sm">${esc(t('notes.summary'))} (Français)</h2>
                <span class="badge badge-xs">FR</span>
              </div>
              <p class="mb-0 text-sm">${esc(note.summary)}</p>
            </section>` : ''}

          <article class="card prose" id="note-article-fr">
            ${st.content_html_ht ? `<div class="mb-3 pb-2" style="border-bottom:1px solid var(--c-border);display:flex;align-items:center;gap:6px;"><span class="badge badge-primary">🇫🇷 Français Académique</span><span class="text-xs muted">${isFr ? 'Note universitaire officielle' : 'Nòt ofisyèl inivèsitè'}</span></div>` : ''}
            ${note.content_html ? sanitizeHtml(note.content_html) : `<p>${esc(note.content_text || note.raw_text || '')}</p>`}
          </article>
        </div>

        <!-- Conteneur Vèsyon Kreyòl -->
        ${st.content_html_ht ? `
          <div id="note-section-ht" class="stack mt-4" style="gap:12px;">
            ${st.summary_ht ? `
              <section class="card card-accent" style="border-left:4px solid var(--c-primary);">
                <div class="row-between mb-1">
                  <h2 class="card-title text-sm">${isFr ? 'Résumé clair en créole' : 'Rezime Senp Kou a (Kreyòl Ayisyen)'}</h2>
                  <span class="badge badge-xs badge-primary">HT</span>
                </div>
                <div class="prose text-sm mt-1" style="line-height:1.6;white-space:pre-wrap;">${renderMarkdown(st.summary_ht)}</div>
              </section>` : ''}

            <article class="card prose" id="note-article-ht">
              <div class="row-between mb-3 pb-2" style="border-bottom:1px solid var(--c-border);flex-wrap:wrap;gap:8px;align-items:center;">
                <div class="row" style="gap:6px;align-items:center;">
                  <span class="badge badge-accent">🇭🇹 Kreyòl Ayisyen</span>
                  <span class="text-xs muted">${isFr ? 'Explications et structure 100% en créole' : 'Eksplikasyon ak estrikti 100% an Kreyòl'}</span>
                </div>
                <button type="button" class="btn btn-xs btn-outline" id="btn-re-kreyolize" title="${isFr ? 'Régénérer et clarifier la version créole' : 'Re-jenere epi fè vèsyon Kreyòl la pi klè'}">
                  ${icon('wand-2')}<span>${isFr ? 'Clarifier en Kreyòl' : 'Fè Kreyòl la pi klè'}</span>
                </button>
              </div>
              ${sanitizeHtml(st.content_html_ht)}
            </article>
          </div>
        ` : ''}

        <!-- Seksyon Eksplikasyon Senp Entegre (Fransè & Kreyòl) -->
        ${(st.simple_explanation_fr || st.simple_explanation_ht || st.simple_explanation) ? `
          <section class="card mb-4" id="note-section-simple-exp" style="background:var(--c-surface-2);border-left:4px solid var(--c-primary,#F97316);">
            <div class="row-between mb-2">
              <h3 class="card-title mb-0 text-sm font-bold" style="color:var(--c-primary,#F97316);">
                ${icon('sparkles')}<span>${esc(t('notes.integrated_simple_exp_title') || (isFr ? 'Explication Simple Intégrée (Bilingue)' : 'Eksplikasyon Senp Entegre (Biling)'))}</span>
              </h3>
            </div>
            <div class="stack" style="gap:10px;">
              ${(st.simple_explanation_fr || (!st.simple_explanation_ht && st.simple_explanation)) ? `
                <div class="p-3" style="background:var(--c-surface);border-radius:var(--r-card);border:1px solid var(--c-border);">
                  <strong class="text-xs font-bold" style="color:var(--c-primary);">🇫🇷 ${isFr ? 'En résumé simple (Français) :' : 'An rezime senp (Fransè) :'}</strong>
                  <div class="prose text-sm mt-1">${renderMarkdown(st.simple_explanation_fr || st.simple_explanation)}</div>
                </div>` : ''}
              ${st.simple_explanation_ht ? `
                <div class="p-3" style="background:var(--c-surface);border-radius:var(--r-card);border:1px solid var(--c-border);">
                  <strong class="text-xs font-bold" style="color:var(--c-primary);">🇭🇹 ${isFr ? 'Ce que le professeur a voulu dire en clair (Créole) :' : 'Sa pwofesè a te vle di an senp (Kreyòl) :'}</strong>
                  <div class="prose text-sm mt-1">${renderMarkdown(st.simple_explanation_ht)}</div>
                </div>` : ''}
            </div>
          </section>` : ''}

        <!-- Seksyon Kesyon & Repons Egzamen Entegre -->
        ${(Array.isArray(st.exam_qa) && st.exam_qa.length) ? `
          <section class="card mb-4" id="note-section-exam-qa" style="background:var(--c-surface-2);border-left:4px solid #10B981;">
            <div class="row-between mb-3">
              <h3 class="card-title mb-0 text-sm font-bold" style="color:#10B981;">
                ${icon('check-circle-2')}<span>${esc(t('notes.exam_qa_title') || 'Questions & Réponses Modèles d\'Examen')} (${st.exam_qa.length})</span>
              </h3>
              <span class="badge badge-success font-bold">${isFr ? 'Q&R Examen' : 'Q&A Egzamen'}</span>
            </div>
            <div class="stack" style="gap:10px;">
              ${st.exam_qa.map((qa, qIdx) => `
                <div class="card p-3" style="background:var(--c-bg);border:1px solid var(--c-border);">
                  <div class="row-between mb-1">
                    <span class="badge badge-xs badge-success font-bold">${isFr ? `Question #${qIdx + 1}` : `Kesyon #${qIdx + 1}`}</span>
                  </div>
                  <p class="font-bold mb-2 text-sm" style="color:var(--c-text);">${esc(qa.question)}</p>
                  <details style="cursor:pointer;">
                    <summary class="text-xs font-bold" style="color:#10B981;user-select:none;">${esc(t('notes.exam_qa_reveal') || 'Cliquer pour voir la réponse modèle et les critères')}</summary>
                    <div class="mt-2 p-2 text-sm" style="background:var(--c-surface);border-radius:var(--r-card);border-left:3px solid #10B981;">
                      <strong class="text-xs" style="color:var(--c-text);">${esc(t('notes.exam_qa_answer_label') || 'Réponse Modèle :')}</strong>
                      <p class="text-sm mt-1 mb-1">${esc(qa.answer)}</p>
                      ${qa.explanation ? `<p class="text-xs muted mb-0"><strong>${esc(t('notes.exam_qa_criteria_label') || 'Critères d\'évaluation :')}</strong> ${esc(qa.explanation)}</p>` : ''}
                    </div>
                  </details>
                </div>
              `).join('')}
            </div>
          </section>` : ''}

        ${corrections.length ? `
          <section class="card card-accent mb-4">
            <div class="row-between mb-2">
              <h3 class="card-title mb-0 text-sm font-bold" style="color:var(--c-accent);">
                ${icon('check-check')}<span>${esc(t('notes.corrections_title'))} (${corrections.length})</span>
              </h3>
              <span class="text-xs muted">${esc(t('notes.corrections_subtitle'))}</span>
            </div>
            <div class="stack-sm">
              ${corrections.map((c) => `
                <div class="card card-sm card-muted">
                  <div class="text-xs" style="text-decoration:line-through;color:var(--c-muted);">${esc(t('notes.original_label'))} "${esc(c.original)}"</div>
                  <div class="text-sm font-bold text-success">${esc(t('notes.corrected_label'))} "${esc(c.corrected)}"</div>
                  ${c.reason ? `<div class="text-xs muted">${esc(c.reason)}</div>` : ''}
                </div>
              `).join('')}
            </div>
          </section>` : ''}

        ${homework.length ? `
          <section class="card card-accent mb-4">
            <div class="row-between mb-2">
              <h3 class="card-title mb-0 text-sm font-bold">
                ${icon('calendar-check')}<span>${esc(t('notes.detected_homework_title'))} (${homework.length})</span>
              </h3>
            </div>
            <div class="stack-sm">
              ${homework.map((hw, idx) => `
                <div class="card card-sm card-muted row-between">
                  <div>
                    <strong>${esc(hw.title)}</strong>
                    ${hw.due_hint ? `<div class="text-xs text-warning">Échéance : ${esc(hw.due_hint)}</div>` : ''}
                    ${hw.description ? `<div class="text-xs muted">${esc(hw.description)}</div>` : ''}
                  </div>
                  <button type="button" class="btn btn-sm btn-primary add-detected-hw-btn" data-hw-idx="${idx}">
                    ${icon('plus')}<span>${esc(t('common.add'))}</span>
                  </button>
                </div>
              `).join('')}
            </div>
          </section>` : ''}

        ${verbatimRaw ? `
          <details class="card card-sm card-muted mb-4">
            <summary class="font-bold text-sm cursor-pointer">${icon('file-text')} ${esc(t('notes.verbatim_title'))}</summary>
            <div class="text-xs whitespace-pre-wrap mt-3 pt-3" style="border-top:1px solid var(--c-border);max-height:300px;overflow-y:auto;">
              ${esc(verbatimRaw)}
            </div>
          </details>` : ''}

        ${researchTopics.length ? `
          <section class="card mb-4">
            <h3 class="card-title text-sm mb-2">${icon('book-open')} ${esc(t('notes.research_topics_title'))}</h3>
            <ul class="list stack-sm">
              ${researchTopics.map((rt) => `<li class="list-item text-xs">${icon('search')}<span>${esc(rt)}</span></li>`).join('')}
            </ul>
          </section>` : ''}

        ${implied.length ? `
          <section class="ai-suggestion">
            <div class="ai-suggestion-label">${icon('sparkles')}<span>${esc(t('notes.implied_title'))} — ${esc(t('notes.implied_badge'))}</span></div>
            <ul class="mt-2 mb-0" style="padding-left:1.3em;">
              ${implied.map((item) => `<li>${esc(item)}</li>`).join('')}
            </ul>
          </section>` : ''}

        ${profQuestions.length ? `
          <section class="card mb-4" style="border-left:4px solid var(--c-primary);background:var(--c-surface);">
            <div class="row-between mb-3">
              <h2 class="card-title mb-0" style="font-size:1.05rem;">${icon('help-circle')} <span style="margin-left:6px;">${esc(t('notes.prof_questions_title') || 'Questions à poser au Professeur')}</span></h2>
              <span class="badge badge-primary font-bold">${profQuestions.length} ${isFr ? 'questions' : 'kesyon'}</span>
            </div>
            <div class="stack" style="gap:10px;">
              ${profQuestions.map((pq, idx) => `
                <div class="card p-3" style="background:var(--c-bg);border:1px solid var(--c-border);">
                  <div class="row-between mb-1">
                    <span class="text-xs font-bold text-accent">#${idx + 1}</span>
                    <button type="button" class="btn btn-xs btn-ghost" data-copy-prof-q="${esc(pq.question)}">
                      ${icon('copy')}<span>${esc(t('notes.copy_prof_q') || 'Copier')}</span>
                    </button>
                  </div>
                  <p class="font-bold mb-1" style="font-size:0.95rem;color:var(--c-text);">${esc(pq.question)}</p>
                  ${pq.purpose ? `<p class="text-xs muted mb-1"><strong>${isFr ? 'Objectif :' : 'Objektif :'}</strong> ${esc(pq.purpose)}</p>` : ''}
                  ${pq.hint ? `<p class="text-xs text-accent mb-0"><strong>${isFr ? 'Ce qu\'il faut écouter :' : 'Sa pou w koute :'}</strong> ${esc(pq.hint)}</p>` : ''}
                </div>
              `).join('')}
            </div>
          </section>` : ''}

        ${sources.length ? `
          <section class="card">
            <h2 class="card-title mb-3">${esc(t('notes.originals'))}</h2>
            <div id="sources-box" class="stack-sm"></div>
          </section>` : ''}
      </div>

      <aside class="stack">
        ${takeaways.length ? `
          <section class="card">
            <h2 class="card-title mb-3">${esc(t('notes.takeaways'))}</h2>
            <ul class="list">${takeaways.map((x) => `<li class="list-item">${icon('check-circle-2')}<span class="text-sm">${esc(x)}</span></li>`).join('')}</ul>
          </section>` : ''}

        ${keywords.length ? `
          <section class="card">
            <h2 class="card-title mb-3">${esc(t('notes.keywords'))}</h2>
            <div class="row-wrap">${keywords.map((k) => `<span class="badge badge-accent">${esc(k)}</span>`).join('')}</div>
          </section>` : ''}

        <section class="card card-sm card-muted">
          <button type="button" class="btn btn-ghost btn-sm" id="btn-report-note">
            ${icon('flag')}<span>${esc(t('notes.report_ai_error'))}</span>
          </button>
        </section>
      </aside>
    </div>`;

  icons(root);
  await renderSources();
  bindActions();
}

async function renderSources() {
  const box = document.getElementById('sources-box');
  if (!box || !sources.length) return;

  const saver = isDataSaver();
  const itemsHtml = [];

  for (const s of sources) {
    let url = null;
    if (s.storage_path?.startsWith('data:') || s.storage_path?.startsWith('http://') || s.storage_path?.startsWith('https://') || s.storage_path?.startsWith('blob:')) {
      url = s.storage_path;
    } else if (navigator.onLine) {
      const bucket = s.kind === 'audio' ? 'pran-not-note-audio' : s.kind === 'pdf' ? 'pran-not-syllabi' : 'pran-not-note-images';
      try {
        const { data } = await db.storage.from(bucket).createSignedUrl(s.storage_path, 3600);
        url = data?.signedUrl;
        if (!url) {
          const pub = db.storage.from(bucket).getPublicUrl(s.storage_path);
          url = pub?.data?.publicUrl;
        }
      } catch (stErr) {
        console.warn('[renderSources] storage url error:', stErr);
      }
    }

    if (!url) {
      if (!navigator.onLine) {
        itemsHtml.push(`<p class="text-xs muted mb-1">${icon('wifi-off')} <span>Fichye disponib sèlman sou entènèt</span></p>`);
      }
      continue;
    }

    if (s.kind === 'image') {
      if (saver) {
        itemsHtml.push(`<button type="button" class="btn btn-sm btn-secondary mb-2" data-load-img="${esc(url)}">${icon('image')}<span>Chaje foto orijinal (ekonomi done)</span></button>`);
      } else {
        itemsHtml.push(`
          <div class="note-image-wrap mb-3" style="max-width:100%;">
            <img src="${esc(url)}" alt="Foto orijinal tablo" loading="lazy" style="max-width:100%;height:auto;border-radius:12px;border:1px solid var(--c-border);display:block;box-shadow:var(--shadow-sm);">
          </div>`);
      }
    } else if (s.kind === 'audio') {
      itemsHtml.push(`<div class="card card-sm card-muted mb-2"><div class="text-xs muted mb-1">Odyo orijinal</div><audio controls src="${esc(url)}" style="width:100%;"></audio></div>`);
    } else {
      itemsHtml.push(`<a class="btn btn-sm btn-secondary mb-2" href="${esc(url)}" target="_blank" rel="noopener">${icon('file-text')}<span>PDF orijinal</span></a>`);
    }
  }

  box.innerHTML = itemsHtml.length ? itemsHtml.join('') : (navigator.onLine ? '' : `<p class="text-sm muted mb-0">${esc(t('errors.offline'))}</p>`);
  box.querySelectorAll('[data-load-img]').forEach((b) => {
    b.addEventListener('click', () => {
      b.outerHTML = `<div class="note-image-wrap mb-3"><img src="${esc(b.dataset.loadImg)}" alt="Foto orijinal" loading="lazy" style="max-width:100%;height:auto;border-radius:12px;border:1px solid var(--c-border);display:block;"></div>`;
    });
  });
  icons(box);
}

async function loadAvailableCourses() {
  const userCoursesKey = userRef ? `courses_list_${userRef.id}` : 'courses_list';
  let coursesList = (await cacheGet(userCoursesKey)) || (await cacheGet('courses_list')) || [];
  if (userRef?.id) {
    coursesList = coursesList.filter((c) => !c.user_id || c.user_id === userRef.id);
  }
  if (navigator.onLine && userRef?.id) {
    try {
      const { data } = await db
        .from('pran_not_courses')
        .select('*')
        .eq('user_id', userRef.id)
        .eq('archived', false)
        .order('name');
      if (data?.length) {
        coursesList = data;
        await cacheSet(userCoursesKey, data);
        await cacheSet('courses_list', data);
      }
    } catch { /* fallback cache */ }
  }
  return coursesList;
}

async function applyNoteCourseAssignment(courseId, unitId, coursesList = []) {
  const cleanCourseId = courseId || null;
  const cleanUnitId = unitId || null;
  const matchedCourse = cleanCourseId ? coursesList.find((c) => c.id === cleanCourseId) || null : null;

  const updateCaches = async () => {
    note.course_id = cleanCourseId;
    note.unit_id = cleanUnitId;
    course = matchedCourse;
    suggestedCourse = null;
    if (!note.is_local_pending) {
      await cacheSet(`note_${note.id}`, note);
    }
    const listCached = await cacheGet('notes_list');
    if (Array.isArray(listCached)) {
      await cacheSet('notes_list', listCached.map((x) => (x.id === note.id ? { ...x, course_id: cleanCourseId } : x)));
    }
    setTutorContext({
      contextType: 'note',
      contextId: note.id,
      contextTitle: note.title,
      contextText: `${note.title}\n${note.summary || ''}\n${note.content_text || ''}`,
      courseId: note.course_id,
    });
  };

  if (note.is_local_draft) {
    saveDraftPatchById(note.id, { course_id: cleanCourseId, unit_id: cleanUnitId });
    await updateCaches();
    toast(t('notes.course_assigned'), 'success');
    renderNote();
    return;
  }

  if (note.is_local_pending) {
    const qId = note.id.slice('local:'.length);
    await updateQueuedNotePayload(qId, { course_id: cleanCourseId, unit_id: cleanUnitId });
    await updateCaches();
    toast(t('notes.course_assigned'), 'success');
    renderNote();
    return;
  }

  if (!navigator.onLine) {
    await updateCaches();
    await enqueue('note_update', { note_id: note.id, course_id: cleanCourseId, unit_id: cleanUnitId });
    toast(t('offline.saved_locally'), 'info');
    renderNote();
    return;
  }

  try {
    const { error } = await db
      .from('pran_not_notes')
      .update({ course_id: cleanCourseId, unit_id: cleanUnitId })
      .eq('id', note.id);
    if (error) throw error;
    await updateCaches();
    toast(t('notes.course_assigned'), 'success');
    renderNote();
  } catch (err) {
    if (isNetworkError(err)) {
      await updateCaches();
      await enqueue('note_update', { note_id: note.id, course_id: cleanCourseId, unit_id: cleanUnitId });
      toast(t('offline.saved_locally'), 'info');
      renderNote();
    } else {
      throw err;
    }
  }
}

async function openAssignCourseModal() {
  const coursesList = await loadAvailableCourses();
  if (!coursesList.length) {
    toast(t('courses.empty_title'), 'info', {
      action: { label: t('courses.new'), onClick: () => { location.href = appUrl('pages/courses.html?new=1'); } },
    });
    return;
  }

  const m = openModal({
    title: t('notes.assign_course_title'),
    body: `
      <div class="field">
        <label for="assign-course-sel">${esc(t('capture.course'))}</label>
        <select class="select" id="assign-course-sel">
          <option value="">${esc(t('common.no_course'))}</option>
          ${coursesList.map((c) => `<option value="${esc(c.id)}" ${note.course_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="assign-unit-sel">${esc(t('notes.unit_optional'))}</label>
        <select class="select" id="assign-unit-sel">
          <option value="">${esc(t('common.none'))}</option>
        </select>
      </div>`,
    footer: `<button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
             <button type="button" class="btn btn-primary" id="assign-course-save">${esc(t('common.save'))}</button>`,
  });

  const cSel = m.el.querySelector('#assign-course-sel');
  const uSel = m.el.querySelector('#assign-unit-sel');

  const refreshUnits = async (cid) => {
    uSel.innerHTML = `<option value="">${esc(t('common.none'))}</option>`;
    if (!cid) return;
    let unitsList = [];
    const cachedDetail = await cacheGet(`course_detail_${cid}`);
    if (cachedDetail?.units?.length) unitsList = cachedDetail.units;
    if (navigator.onLine) {
      try {
        const { data } = await db.from('pran_not_syllabus_units').select('id, title, position').eq('course_id', cid).order('position');
        if (data?.length) unitsList = data;
      } catch { /* ignore */ }
    }
    unitsList.forEach((u) => {
      uSel.insertAdjacentHTML('beforeend', `<option value="${esc(u.id)}" ${note.unit_id === u.id ? 'selected' : ''}>${esc(u.title)}</option>`);
    });
  };

  cSel.addEventListener('change', () => refreshUnits(cSel.value));
  await refreshUnits(cSel.value);

  const saveBtn = m.el.querySelector('#assign-course-save');
  saveBtn.addEventListener('click', async () => {
    setLoading(saveBtn, true);
    try {
      await applyNoteCourseAssignment(cSel.value, uSel.value, coursesList);
      m.close();
    } catch (err) {
      handleError(err);
      setLoading(saveBtn, false);
    }
  });
}

async function finalizeDraftNote(draft) {
  if (!draft || !userRef) return;
  const clientId = uid();
  const title = draft.title || t('notes.untitled');
  const rawText = draft.raw_text || draft.content_text || '';
  const contentText = draft.content_text || rawText || '';
  const contentHtml = draft.content_html || (contentText ? `<p>${esc(contentText).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>` : '');
  const summary = draft.summary || contentText.slice(0, 240);
  const captureMode = draft.capture_mode || 'text';
  const courseId = draft.course_id || null;
  const unitId = draft.unit_id || null;

  const saveOfflineQueue = async () => {
    const item = await enqueue('note', {
      client_id: clientId,
      course_id: courseId,
      unit_id: unitId,
      title,
      content_html: contentHtml,
      content_text: contentText,
      raw_text: rawText,
      language: getLang(),
      capture_mode: captureMode,
      status: 'ready',
      process_ai: false,
    });
    deleteDraftById(draft.id);
    playNotificationSound('success');
    toast(t('offline.saved_locally') || 'Nòt la anrejistre lokalman !', 'success');
    setTimeout(() => {
      location.replace(appUrl(`pages/note-view.html?id=${encodeURIComponent(`local:${item.id}`)}`));
    }, 300);
  };

  if (!navigator.onLine || userRef.is_offline_guest || !db) {
    await saveOfflineQueue();
    return;
  }

  try {
    const { data: noteRow, error } = await db.from('pran_not_notes').upsert({
      user_id: userRef.id,
      client_id: clientId,
      course_id: courseId,
      unit_id: unitId,
      title,
      summary,
      content_html: contentHtml,
      content_text: contentText,
      raw_text: rawText,
      structured: draft.structured || null,
      language: getLang(),
      capture_mode: captureMode,
      status: 'ready',
    }, { onConflict: 'user_id,client_id' }).select().single();

    if (error) throw error;

    await cacheSet(`note_${noteRow.id}`, noteRow);
    deleteDraftById(draft.id);
    playNotificationSound('success');
    await Promise.all([recordActivity(), awardXp(15, 'finalize_draft', noteRow.id)]);
    toast(t('notes.saved') || 'Nòt la anrejistre definitivman !', 'success');
    location.replace(appUrl(`pages/note-view.html?id=${encodeURIComponent(noteRow.id)}`));
  } catch (err) {
    console.warn('[note-view] finalizeDraft fallback offline:', err);
    await saveOfflineQueue();
  }
}

function bindActions() {
  const root = document.getElementById('note-root') || document;
  const isFr = getLang() === 'fr';

  document.getElementById('btn-view-re-structure')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const srcText = (typeof getFullNoteContent === 'function' ? getFullNoteContent() : '') || note.content_text || note.raw_text || '';
      if (!srcText) {
        toast(t('errors.required'), 'warning');
        return;
      }
      const res = await processNote({
        rawText: srcText,
        language: 'mix',
        mode: 'bilingual',
        faculty: profileRef?.faculty_id || 'autre',
        level: profileRef?.level || 'L1',
        noteId: note.id,
      });

      if (!res || (!res.content_html && !res.summary)) {
        throw new Error(isFr ? 'Échec de la structuration bilingue' : 'Echèk estriktirasyon biling la');
      }

      note.title = res.title || note.title;
      note.summary = res.summary || note.summary;
      note.content_html = res.content_html || note.content_html;
      note.content_text = res.content_text || note.content_text;
      note.structured = {
        ...(note.structured || {}),
        ...res,
        content_html_ht: res.content_html_ht || '',
        simple_explanation_fr: res.simple_explanation_fr || '',
        simple_explanation_ht: res.simple_explanation_ht || '',
        exam_qa: Array.isArray(res.exam_qa) ? res.exam_qa : [],
        questions_for_professor: Array.isArray(res.questions_for_professor) ? res.questions_for_professor : [],
      };

      if (navigator.onLine && isUuid(note.id)) {
        await db.from('pran_not_notes').update({
          title: note.title,
          summary: note.summary,
          content_html: note.content_html,
          content_text: note.content_text,
          structured: note.structured,
          updated_at: new Date().toISOString(),
        }).eq('id', note.id);
      }
      await cacheSet(`note_${note.id}`, note);

      toast(isFr ? 'Note parfaitement structurée en format bilingue avec explications !' : 'Nòt la byen estriktire an fòma biling ak tout eksplikasyon ak Q&A !', 'success');
      await renderNote();
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  root.querySelector('#btn-re-kreyolize')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const srcText = getFullNoteContent();
      const newCreoleHtml = await kreyolizeTextOrHtml(note.content_html || srcText, note.title);
      const newCreoleSummary = makeSimpleCreoleSummary(newCreoleHtml || srcText, note.title);

      note.structured = {
        ...(note.structured || {}),
        content_html_ht: newCreoleHtml,
        summary_ht: newCreoleSummary,
      };

      if (navigator.onLine && isUuid(note.id)) {
        await db.from('pran_not_notes').update({
          structured: note.structured,
          updated_at: new Date().toISOString(),
        }).eq('id', note.id);
      }
      await cacheSet(`note_${note.id}`, note);
      toast(isFr ? 'Version créole clarifiée et mise à jour !' : 'Vèsyon Kreyòl la rann pi klè epi mete ajou !', 'success');
      await renderNote();
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  const onFinalizeClick = async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      await finalizeDraftNote(note);
    } catch (err) {
      handleError(err);
      setLoading(btn, false);
    }
  };

  document.getElementById('btn-header-finalize-draft')?.addEventListener('click', onFinalizeClick);
  document.getElementById('btn-banner-finalize-draft')?.addEventListener('click', onFinalizeClick);

  document.getElementById('btn-assign-course')?.addEventListener('click', openAssignCourseModal);

  document.getElementById('btn-confirm-course')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const { error } = await db.from('pran_not_notes').update({ course_id: suggestedCourse.id }).eq('id', note.id);
      if (error) throw error;
      course = suggestedCourse;
      note.course_id = suggestedCourse.id;
      toast(t('common.saved'), 'success');
      renderNote();
    } catch (err) {
      handleError(err);
      setLoading(btn, false);
    }
  });

  document.getElementById('btn-gen-cards')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const sourcesText = (sources || [])
        .map((s) => s.ocr_text || s.transcript || '')
        .filter(Boolean)
        .join('\n\n');
      const content = (note.content_text || note.raw_text || note.summary || sourcesText || note.title || '').trim();

      const res = await generateFlashcards({
        content,
        title: note.title || 'Kat memwa',
        language: getLang(),
        faculty: profileRef?.faculty_id,
        level: profileRef?.level,
        count: 8,
        courseId: isUuid(note.course_id) ? note.course_id : null,
        unitId: isUuid(note.unit_id) ? note.unit_id : null,
        noteId: isUuid(note.id) ? note.id : null,
      });
      toast(isFr ? `${res.cards?.length || 0} cartes mémoire créées.` : `${res.cards?.length || 0} kat memwa kreye.`, 'success', {
        action: {
          label: t('nav.review'),
          onClick: () => { location.href = appUrl(`pages/flashcards.html?deck=${res.deckId || ''}`); },
        },
      });
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  document.getElementById('btn-gen-quiz')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const sourcesText = (sources || [])
        .map((s) => s.ocr_text || s.transcript || '')
        .filter(Boolean)
        .join('\n\n');
      const content = (note.content_text || note.raw_text || note.summary || sourcesText || note.title || '').trim();

      const res = await generateTest({
        content,
        title: note.title || 'Tès Pran Nòt',
        difficulty: 'medium',
        language: getLang(),
        faculty: profileRef?.faculty_id,
        level: profileRef?.level,
        count: 5,
      });

      const fallbackTestId = uid();
      let testRow = {
        id: fallbackTestId,
        user_id: userRef?.id || 'guest',
        course_id: isUuid(note.course_id) ? note.course_id : null,
        unit_id: isUuid(note.unit_id) ? note.unit_id : null,
        note_id: isUuid(note.id) ? note.id : null,
        title: res.title || note.title || 'Tès Pran Nòt',
        difficulty: 'medium',
        kind: 'standard',
        source: 'ai',
      };

      if (navigator.onLine && isUuid(userRef?.id)) {
        try {
          const { data: dbTest, error: tErr } = await db.from('pran_not_tests').insert({
            user_id: userRef.id,
            course_id: isUuid(note.course_id) ? note.course_id : null,
            unit_id: isUuid(note.unit_id) ? note.unit_id : null,
            note_id: isUuid(note.id) ? note.id : null,
            title: res.title || note.title || 'Tès Pran Nòt',
            difficulty: 'medium',
            kind: 'standard',
            source: 'ai',
          }).select().single();
          if (!tErr && dbTest) {
            testRow = dbTest;
          }
        } catch (saveErr) {
          console.warn('[note-view] test db save error, using offline cache:', saveErr);
        }
      }

      const qRows = (res.questions || []).map((q, idx) => ({
        id: uid(),
        test_id: testRow.id,
        user_id: userRef?.id || 'guest',
        unit_id: testRow.unit_id,
        position: idx + 1,
        type: q.type || 'mcq',
        prompt: q.prompt,
        options: q.options || [],
        answer: q.answer,
        explanation: q.explanation || '',
        keyword: q.keyword || '',
        points: q.points || 1,
      }));

      if (navigator.onLine && isUuid(userRef?.id) && isUuid(testRow.id) && qRows.length) {
        try {
          await db.from('pran_not_test_questions').insert(qRows.map((q) => ({
            test_id: testRow.id,
            user_id: userRef.id,
            unit_id: testRow.unit_id,
            position: q.position,
            type: q.type,
            prompt: q.prompt,
            options: q.options,
            answer: q.answer,
            explanation: q.explanation,
            keyword: q.keyword,
            points: q.points,
          })));
        } catch (qErr) {
          console.warn('[note-view] questions db save error, using offline cache:', qErr);
        }
      }

      // Toujours cacher la session pour chargement instantané
      await cacheSet(`test_session_${testRow.id}`, { testRow, questions: qRows });
      location.href = appUrl(`pages/test-session.html?id=${testRow.id}`);
    } catch (err) {
      handleError(err);
      setLoading(btn, false);
    }
  });

  root.querySelectorAll('[data-copy-prof-q]').forEach((b) => {
    b.addEventListener('click', () => {
      navigator.clipboard?.writeText(b.dataset.copyProfQ || '');
      toast(isFr ? 'Question copiée !' : 'Kesyon kopye !', 'success');
    });
  });

  document.getElementById('btn-prof-questions')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const fullText = getFullNoteContent();
      const res = await generateProfessorQuestions({
        content: fullText,
        title: note.title,
        faculty: profileRef?.faculty_id,
        level: profileRef?.level,
        language: getLang(),
      });
      if (!res.ok || !res.questions?.length) {
        throw new Error('Echèk jenerasyon kesyon pou pwofesè a');
      }

      if (!note.structured) note.structured = {};
      note.structured.questions_for_professor = res.questions;
      if (navigator.onLine && isUuid(note.id)) {
        await db.from('pran_not_notes').update({
          structured: note.structured,
          updated_at: new Date().toISOString(),
        }).eq('id', note.id);
      }
      await cacheSet(`note_${note.id}`, note);

      renderProfQuestionsModal(res.questions, note.title, async (qText) => {
        const insertionHtml = `<div class="card card-sm card-muted mt-3 mb-3" style="border-left:4px solid var(--c-primary,#F97316);background:var(--c-surface-2);">
          <h4 class="text-xs font-bold text-uppercase muted mb-1">Kesyon pou Pwofesè a</h4>
          <p class="text-sm font-bold mb-0">${esc(qText)}</p>
        </div>`;
        note.content_html = (note.content_html || '') + insertionHtml;
        note.content_text = (note.content_text || '') + `\n\n### Kesyon pou Pwofesè a :\n- ${qText}\n`;
        if (navigator.onLine && isUuid(note.id)) {
          await db.from('pran_not_notes').update({
            content_html: note.content_html,
            content_text: note.content_text,
            updated_at: new Date().toISOString(),
          }).eq('id', note.id);
        }
        await cacheSet(`note_${note.id}`, note);
        toast(isFr ? 'Question ajoutée à la note !' : 'Kesyon ajoute nan nòt la !', 'success');
        renderNote();
      });
      renderNote();
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  document.getElementById('btn-fix-raw-sense')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const textToFix = (note.raw_text || getFullNoteContent()).trim();
    if (!textToFix) {
      toast(isFr ? 'Aucun texte brut dans cette note.' : 'Pa gen tèks brit nan nòt sa a.', 'info');
      return;
    }
    setLoading(btn, true);
    try {
      const res = await correctRawTextSense({
        rawText: textToFix,
        language: getLang(),
        faculty: profileRef?.faculty_id,
        level: profileRef?.level,
      });
      if (!res.ok || !res.correctedText) {
        throw new Error(isFr ? 'Échec de la correction du texte' : 'Echèk koreksyon sans la');
      }

      const m = openModal({
        title: isFr ? 'Correction & Clarification du Sens' : 'Koreksyon & Clarifikasyon Sans Tèks la',
        body: `
          <div class="stack py-2">
            <p class="text-sm muted mb-3">${isFr ? 'Voici le texte de la note rendu clair, logique avec des phrases bien structurées tout en préservant tous les noms et concepts :' : 'Men tèks nòt la rann klè, lojik ak fraz byen estriktire pandan tout non ak konsèp yo konsève :'}</p>
            <div class="card p-3" style="max-height:280px;overflow-y:auto;background:var(--c-surface);font-size:0.95rem;line-height:1.6;white-space:pre-wrap;">${esc(res.correctedText)}</div>
          </div>
        `,
        footer: `
          <button type="button" class="btn btn-secondary" data-close>${esc(t('common.close'))}</button>
          <button type="button" class="btn btn-primary" id="btn-copy-corrected-raw">${icon('copy')}<span>${esc(isFr ? 'Copier le texte corrigé' : 'Kopye tèks korije a')}</span></button>
        `,
      });

      m.el.querySelector('#btn-copy-corrected-raw')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(res.correctedText);
        toast(isFr ? 'Texte corrigé copié !' : 'Tèks korije a kopye !', 'success');
      });
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  document.getElementById('btn-simpler')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;

    // Chwazi lang eksplikasyon an (Kreyòl oswa Fransè)
    const curLang = getLang();
    const chooseModal = openModal({
      title: t('notes.btn_simpler') || 'Eksplikasyon Senp',
      body: `
        <div class="stack py-2">
          <p class="text-sm muted mb-3">${esc(t('notes.explain_modal_sub'))}</p>
          <div class="field mb-3">
            <label for="explain-lang-select">${esc(t('notes.explain_lang_label'))}</label>
            <select class="select" id="explain-lang-select">
              <option value="ht" ${curLang === 'ht' ? 'selected' : ''}>Kreyòl Ayisyen</option>
              <option value="fr" ${curLang === 'fr' ? 'selected' : ''}>Français</option>
            </select>
          </div>
          <div class="field mb-3">
            <label for="explain-style-select">Fòma eksplikasyon</label>
            <select class="select" id="explain-style-select">
              <option value="simple">Senp, etap pa etap (San jagon)</option>
              <option value="haiti">${esc(t('notes.explain_opt_haiti'))}</option>
              <option value="child">${esc(t('notes.explain_opt_child'))}</option>
            </select>
          </div>
          <button type="button" class="btn btn-primary btn-block" id="btn-run-explanation">
            ${icon('sparkles')}<span>Jenere eksplikasyon</span>
          </button>
        </div>
      `,
    });

    const runBtn = chooseModal.el.querySelector('#btn-run-explanation');
    runBtn.addEventListener('click', async () => {
      const selectedLang = chooseModal.el.querySelector('#explain-lang-select').value || 'ht';
      const selectedStyle = chooseModal.el.querySelector('#explain-style-select').value || 'simple';
      setLoading(runBtn, true);
      chooseModal.close();
      setLoading(btn, true);

      try {
        const res = await explainText({
          text: `${note.title}\n\n${note.content_text || note.raw_text || ''}`,
          mode: selectedStyle,
          language: selectedLang,
          faculty: profileRef?.faculty_id,
          level: profileRef?.level,
        });

        const explanationText = res?.result?.text || '';
        if (!explanationText) throw new Error('Eksplikasyon an vid');

        const m = openModal({
          title: selectedLang === 'fr' ? 'Explication Simple' : 'Eksplikasyon Senp',
          size: 'lg',
          body: `
            <div class="prose mb-4">${renderMarkdown(explanationText)}</div>
            <div class="card card-sm card-accent">
              <div class="row-between" style="flex-wrap:wrap;gap:8px;">
                <div>
                  <strong>${esc(t('notes.insert_in_note'))}</strong>
                  <div class="text-xs muted">Ou ka sove eksplikasyon sa a dirèkteman nan espas nòt la pou tout tan.</div>
                </div>
                <button type="button" class="btn btn-sm btn-primary" id="btn-insert-explanation-to-note">
                  ${icon('plus')}<span>Ajoute nan nòt sa a</span>
                </button>
              </div>
            </div>
          `,
        });

        m.el.querySelector('#btn-insert-explanation-to-note')?.addEventListener('click', async (ev) => {
          const insertBtn = ev.currentTarget;
          setLoading(insertBtn, true);
          try {
            if (!note.structured) note.structured = {};
            note.structured.simple_explanation = explanationText;
            if (selectedLang === 'fr') {
              note.structured.simple_explanation_fr = explanationText;
            } else {
              note.structured.simple_explanation_ht = explanationText;
            }
            const patch = { structured: note.structured, updated_at: new Date().toISOString() };

            if (navigator.onLine && !note.is_local_pending && isUuid(note.id)) {
              await db.from('pran_not_notes').update(patch).eq('id', note.id);
            } else if (note.is_local_pending) {
              await updateQueuedNotePayload(note.id.slice('local:'.length), patch);
            }
            await cacheSet(`note_${note.id}`, note);
            toast(isFr ? 'Explication simple ajoutée à la note !' : 'Eksplikasyon senp lan ajoute nan nòt la !', 'success');
            m.close();
            await renderNote();
          } catch (err) {
            handleError(err);
          } finally {
            setLoading(insertBtn, false);
          }
        });

      } catch (err) {
        handleError(err);
      } finally {
        setLoading(btn, false);
      }
    });
  });

  // Bouton Rezime pa Ti Pwen Kle (Bullet points kout e rapid)
  document.getElementById('btn-points-summary')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const curLang = getLang();

    const mChoose = openModal({
      title: 'Rezime pa Ti Pwen Kle',
      body: `
        <div class="stack py-2">
          <p class="text-sm muted mb-3">Chwazi lang pou lis ti pwen kle yo :</p>
          <div class="field mb-3">
            <label for="bullet-lang-select">Lang rezime a</label>
            <select class="select" id="bullet-lang-select">
              <option value="ht" ${curLang === 'ht' ? 'selected' : ''}>Kreyòl Ayisyen</option>
              <option value="fr" ${curLang === 'fr' ? 'selected' : ''}>Français</option>
            </select>
          </div>
          <button type="button" class="btn btn-primary btn-block" id="btn-run-bullet">
            ${icon('list-checks')}<span>Fè rezime pa pwen kounye a</span>
          </button>
        </div>
      `,
    });

    const runBulletBtn = mChoose.el.querySelector('#btn-run-bullet');
    runBulletBtn.addEventListener('click', async () => {
      const selectedLang = mChoose.el.querySelector('#bullet-lang-select').value || 'ht';
      mChoose.close();
      setLoading(btn, true);

      try {
        const langDirective = selectedLang === 'fr'
          ? 'Donne un résumé ultra-concis sous forme de liste de points clés (bullet points). Chaque point doit être court (1 à 2 phrases max), très clair et direct pour comprendre la note rapidement.'
          : 'Bay yon rezime trè kout sou fòm lis ti pwen kle (bullet points). Chak pwen dwe kout (1 a 2 fraz maksimòm), trè klè e dirèk pou konprann nòt la fasilman san lekti long.';

        const prompt = `${langDirective}\n\nNòt :\n${note.title}\n\n${note.content_text || note.raw_text || ''}`;
        const res = await askTutor({
          message: prompt,
          mode: 'simple',
          contextType: 'note',
          contextId: note.id,
          contextText: `${note.title}\n${note.content_text || note.raw_text || ''}`,
          useLibrary: false,
          faculty: profileRef?.faculty_id,
          level: profileRef?.level,
          language: selectedLang,
        });

        const bulletText = res?.reply || res?.answer || res?.text || '';
        if (!bulletText) throw new Error('Rezime a vid');

        const m = openModal({
          title: selectedLang === 'fr' ? 'Résumé par Points Clés' : 'Rezime pa Ti Pwen Kle',
          size: 'lg',
          body: `
            <div class="prose mb-4">${renderMarkdown(bulletText)}</div>
            <div class="card card-sm card-accent">
              <div class="row-between" style="flex-wrap:wrap;gap:8px;">
                <div>
                  <strong>Mete nan nòt la</strong>
                  <div class="text-xs muted">Ou ka sove lis pwen kle sa a dirèkteman nan nòt la.</div>
                </div>
                <button type="button" class="btn btn-sm btn-primary" id="btn-insert-bullet-to-note">
                  ${icon('plus')}<span>Ajoute nan nòt la</span>
                </button>
              </div>
            </div>
          `,
        });

        m.el.querySelector('#btn-insert-bullet-to-note')?.addEventListener('click', async (ev) => {
          const insertBtn = ev.currentTarget;
          setLoading(insertBtn, true);
          try {
            if (!note.structured) note.structured = {};
            note.structured.bullet_summary = bulletText;
            const patch = { structured: note.structured };

            if (navigator.onLine && !note.is_local_pending && isUuid(note.id)) {
              await db.from('pran_not_notes').update(patch).eq('id', note.id);
            } else if (note.is_local_pending) {
              await updateQueuedNotePayload(note.id.slice('local:'.length), patch);
            }
            await cacheSet(`note_${note.id}`, note);
            toast(isFr ? 'Résumé par points ajouté à la note !' : 'Rezime pa pwen an ajoute nan nòt la!', 'success');
            m.close();
            await renderNote();
          } catch (err) {
            handleError(err);
          } finally {
            setLoading(insertBtn, false);
          }
        });
      } catch (err) {
        handleError(err);
      } finally {
        setLoading(btn, false);
      }
    });
  });

  // Retire rezime pa pwen an si etidyan an vle
  document.getElementById('btn-remove-bullet-summary')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Retire rezime pa pwen',
      message: 'Èske ou vle retire seksyon rezime pa pwen an nan nòt sa a ?',
    });
    if (!ok) return;
    try {
      if (note.structured) {
        delete note.structured.bullet_summary;
      }
      const patch = { structured: note.structured || null };
      if (navigator.onLine && !note.is_local_pending && isUuid(note.id)) {
        await db.from('pran_not_notes').update(patch).eq('id', note.id);
      } else if (note.is_local_pending) {
        await updateQueuedNotePayload(note.id.slice('local:'.length), patch);
      }
      await cacheSet(`note_${note.id}`, note);
      toast(isFr ? 'Résumé par points retiré de la note.' : 'Rezime pa pwen retire nan nòt la.', 'info');
      renderNote();
    } catch (err) {
      handleError(err);
    }
  });

  // Retire eksplikasyon senp lan si etidyan an vle
  document.getElementById('btn-remove-simple-exp')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: isFr ? 'Retirer l\'explication simple' : 'Retire eksplikasyon senp',
      message: isFr ? 'Voulez-vous retirer la section explication simple de cette note ?' : 'Èske ou vle retire seksyon eksplikasyon senp lan nan nòt la ?',
    });
    if (!ok) return;
    try {
      if (note.structured) {
        delete note.structured.simple_explanation;
        delete note.structured.simple_explanation_fr;
        delete note.structured.simple_explanation_ht;
      }
      const patch = { structured: note.structured || null };
      if (navigator.onLine && !note.is_local_pending && isUuid(note.id)) {
        await db.from('pran_not_notes').update(patch).eq('id', note.id);
      } else if (note.is_local_pending) {
        await updateQueuedNotePayload(note.id.slice('local:'.length), patch);
      }
      await cacheSet(`note_${note.id}`, note);
      toast(isFr ? 'Explication retirée de la note.' : 'Eksplikasyon retire nan nòt la.', 'info');
      renderNote();
    } catch (err) {
      handleError(err);
    }
  });

  document.getElementById('btn-ask-tutor')?.addEventListener('click', () => {
    toggleTutorDrawer(true);
  });

  document.getElementById('btn-ai-clean')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const curLang = getLang();

    const m = openModal({
      title: t('capture.structure_ai') || 'Netwaye epi estriktire ak IA',
      body: `
        <div class="stack py-2">
          <p class="text-sm muted mb-3">Chwazi kijan ou vle IA a trete epi estriktire nòt la :</p>
          <div class="field mb-3">
            <label for="ai-clean-lang">Lang rezilta a</label>
            <select class="select" id="ai-clean-lang">
              <option value="ht" ${curLang === 'ht' ? 'selected' : ''}>Kreyòl Ayisyen</option>
              <option value="fr" ${curLang === 'fr' ? 'selected' : ''}>Français</option>
            </select>
          </div>
          <div class="field mb-3">
            <label for="ai-clean-mode">${isFr ? 'Méthode de structuration' : 'Metòd tretman'}</label>
            <select class="select" id="ai-clean-mode">
              <option value="bilingual" selected>${isFr ? 'Bilingue complet (Français + Créole + Explications + Q&R)' : 'Biling konplè (Fransè + Kreyòl + Eksplikasyon + Q&A)'}</option>
              <option value="harmonize_fr">${isFr ? 'Harmoniser en Français universitaire' : 'Tradui ak amonize tout nòt la an Fransè'}</option>
              <option value="harmonize_ht">${isFr ? 'Harmoniser en Créole haïtien' : 'Tradui ak amonize tout nòt la an Kreyòl'}</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="btn-start-clean">
            ${icon('wand-2')}<span>${isFr ? 'Lancer la structuration IA' : 'Kòmanse analiz IA'}</span>
          </button>
        </div>
      `,
    });

    m.el.querySelector('#btn-start-clean')?.addEventListener('click', async () => {
      const selectedLang = m.el.querySelector('#ai-clean-lang').value || 'fr';
      const selectedMode = m.el.querySelector('#ai-clean-mode').value || 'bilingual';
      m.close();
      setLoading(btn, true);

      try {
        const srcText = getFullNoteContent() || note.content_text || note.raw_text || '';
        const res = await processNote({
          rawText: srcText,
          language: selectedLang,
          mode: selectedMode,
          faculty: profileRef?.faculty_id,
          level: profileRef?.level,
          noteId: note.id,
        });
        note.title = res.title || note.title;
        note.summary = res.summary || note.summary;
        note.content_html = res.content_html || note.content_html;
        note.content_text = res.content_text || note.content_text;
        note.structured = {
          ...(note.structured || {}),
          ...res,
          content_html_ht: res.content_html_ht || '',
          simple_explanation_fr: res.simple_explanation_fr || '',
          simple_explanation_ht: res.simple_explanation_ht || '',
          exam_qa: Array.isArray(res.exam_qa) ? res.exam_qa : [],
          questions_for_professor: Array.isArray(res.questions_for_professor) ? res.questions_for_professor : [],
        };

        if (navigator.onLine && isUuid(note.id)) {
          await db.from('pran_not_notes').update({
            title: note.title,
            summary: note.summary,
            content_html: note.content_html,
            content_text: note.content_text,
            structured: note.structured,
            updated_at: new Date().toISOString(),
          }).eq('id', note.id);
        }
        await cacheSet(`note_${note.id}`, note);
        toast(isFr ? 'Note mise à jour avec succès !' : 'Nòt la mete a jou avèk siksè !', 'success');
        await renderNote();
      } catch (err) {
        handleError(err);
      } finally {
        setLoading(btn, false);
      }
    });
  });

  document.getElementById('btn-export-note')?.addEventListener('click', () => {
    const m = openModal({
      title: t('notes.btn_export'),
      body: `<div class="stack-sm">
        <button type="button" class="btn btn-secondary btn-block" id="exp-pdf">${icon('file-text')}<span>PDF (.pdf)</span></button>
        <button type="button" class="btn btn-secondary btn-block" id="exp-docx">${icon('file-type')}<span>Word (.docx)</span></button>
        <button type="button" class="btn btn-secondary btn-block" id="exp-md">${icon('code')}<span>Markdown (.md)</span></button>
      </div>`,
    });
    m.el.querySelector('#exp-pdf').addEventListener('click', async () => {
      await exportNotePdf(note, profileRef, course?.name);
      m.close();
    });
    m.el.querySelector('#exp-docx').addEventListener('click', async () => {
      await exportNoteDocx(note, profileRef, course?.name);
      m.close();
    });
    m.el.querySelector('#exp-md').addEventListener('click', () => {
      exportNoteMarkdown(note, course?.name);
      m.close();
    });
  });

  document.getElementById('btn-continue-recording')?.addEventListener('click', () => {
    if (note.is_local_draft) {
      location.href = `${note.draft_target || './note-capture.html'}?mode=audio`;
      return;
    }
    location.href = `./note-capture.html?id=${encodeURIComponent(note.id)}&edit=1&mode=audio`;
  });

  document.getElementById('btn-add-board-photo')?.addEventListener('click', () => {
    if (note.is_local_draft) {
      location.href = `${note.draft_target || './note-capture.html'}?mode=photo`;
      return;
    }
    location.href = `./note-capture.html?id=${encodeURIComponent(note.id)}&edit=1&mode=photo`;
  });

  // Chanjman vèsyon lang nòt la (Tout 2 / Fransè sèlman / Kreyòl sèlman)
  const langToggleButtons = root.querySelectorAll('#note-lang-toggle [data-lang-view]');
  langToggleButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      langToggleButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.langView;
      const frSec = document.getElementById('note-section-fr');
      const htSec = document.getElementById('note-section-ht');
      if (view === 'both') {
        if (frSec) frSec.hidden = false;
        if (htSec) htSec.hidden = false;
      } else if (view === 'fr') {
        if (frSec) frSec.hidden = false;
        if (htSec) htSec.hidden = true;
      } else if (view === 'ht') {
        if (frSec) frSec.hidden = true;
        if (htSec) htSec.hidden = false;
      }
    });
  });

  document.getElementById('btn-edit-note')?.addEventListener('click', () => {
    if (note.is_local_draft) {
      location.href = note.draft_target || './note-capture.html';
      return;
    }
    location.href = `./note-capture.html?id=${encodeURIComponent(note.id)}&edit=1`;
  });

  document.getElementById('btn-print-note')?.addEventListener('click', () => {
    const cMap = new Map();
    if (course?.id) cMap.set(course.id, course);
    batchPrintNotes([note], cMap, profileRef);
  });

  // Transfè an dirèk sou sit la avèk kòd 6 chif
  document.getElementById('btn-live-transfer')?.addEventListener('click', () => {
    openSendTransferModal({
      id: note.id,
      title: note.title,
      content_html: note.content_html,
      content_text: note.content_text,
      summary: note.summary,
      keywords: Array.isArray(note.structured?.keywords) ? note.structured.keywords : [],
      homework: Array.isArray(note.structured?.homework) ? note.structured.homework : [],
      structured: note.structured,
      course_name: course?.name || '',
    });
  });

  // Tradiksyon rapid ant Kreyòl ak Fransè
  document.getElementById('btn-translate-note')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const srcText = note.content_text || note.raw_text || '';
      if (!srcText) {
        toast(t('errors.required'), 'warning');
        return;
      }
      const isFrench = /^(le|la|les|des|un|une|dans|pour|avec|nous|vous|est|sont)\b/i.test(srcText);
      const targetMode = isFrench ? 'harmonize_ht' : 'harmonize_fr';
      const targetLang = isFrench ? 'ht' : 'fr';

      const res = await processNote({
        rawText: srcText,
        mode: targetMode,
        language: targetLang,
        faculty: profileRef?.faculty_id || 'autre',
        level: profileRef?.level || 'L1',
      });

      if (res?.content_html) {
        note.content_html = res.content_html;
        note.content_text = res.content_text || srcText;
        if (res.title) note.title = res.title;
        if (res.summary) note.summary = res.summary;
        await renderNote();
        playNotificationSound('success');
        toast(t('notes.translated_toast', { lang: targetLang === 'ht' ? 'Kreyòl' : 'Français' }), 'success');

        // Sove nan DB si posib
        if (navigator.onLine && !note.is_local_pending && isUuid(note.id)) {
          await db.from('pran_not_notes').update({
            title: note.title,
            summary: note.summary,
            content_html: note.content_html,
            content_text: note.content_text,
          }).eq('id', note.id);
        }
      }
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  // Ajoute devwa detekte pa IA a dirèkteman nan lis devwa etidyan an
  document.querySelectorAll('.add-detected-hw-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const hwIdx = Number(e.currentTarget.dataset.hwIdx);
      const hwItem = (note.structured?.homework || [])[hwIdx];
      if (!hwItem) return;
      setLoading(e.currentTarget, true);
      try {
        await db.from('pran_not_assignments').insert({
          user_id: userRef.id,
          course_id: note.course_id || null,
          title: hwItem.title,
          description: hwItem.description || '',
          due_at: hwItem.due_hint ? new Date(Date.now() + 7 * 86400000).toISOString() : null,
          status: 'todo',
        });
        playNotificationSound('success');
        toast(t('notes.homework_saved_list'), 'success');
        e.currentTarget.disabled = true;
        e.currentTarget.innerHTML = `${icon('check')}<span>${esc(t('common.add'))}</span>`;
        icons(e.currentTarget);
      } catch (err) {
        handleError(err);
        setLoading(e.currentTarget, false);
      }
    });
  });

  document.getElementById('btn-share-note')?.addEventListener('click', async () => {
    try {
      const { data: groups } = await db.from('pran_not_study_groups').select('id, name');
      if (!groups?.length) {
        toast(isFr ? 'Créez ou rejoignez d\'abord un groupe d\'étude dans le Planificateur.' : 'Kreye oswa antre nan yon gwoup etid anvan nan Planifikatè.', 'info', {
          action: { label: t('nav.planner'), onClick: () => { location.href = appUrl('pages/planner.html'); } },
        });
        return;
      }
      const m = openModal({
        title: isFr ? 'Partager la note dans un groupe' : 'Pataje nòt la nan yon gwoup',
        body: `
          <div class="field"><label>${isFr ? 'Groupe d\'étude' : 'Gwoup etid'}</label>
            <select class="select" id="sh-group">${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>${isFr ? 'Permissions' : 'Pèmisyon'}</label>
            <select class="select" id="sh-perm">
              <option value="copy">${isFr ? 'Lecture + Copie dans leurs notes' : 'Li + Kopye nan nòt pa yo'}</option>
              <option value="view">${isFr ? 'Lecture seule' : 'Li sèlman'}</option>
            </select>
          </div>`,
        footer: `<button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
                 <button type="button" class="btn btn-primary" id="sh-ok">${esc(isFr ? 'Partager' : 'Pataje')}</button>`,
      });
      m.el.querySelector('#sh-ok').addEventListener('click', async () => {
        const groupId = m.el.querySelector('#sh-group').value;
        const permission = m.el.querySelector('#sh-perm').value;
        const { error } = await db.from('pran_not_shared_items').upsert({
          group_id: groupId, shared_by: userRef.id, item_type: 'note', item_id: note.id, permission,
        }, { onConflict: 'group_id,item_type,item_id' });
        if (error) handleError(error);
        else { toast(t('common.saved'), 'success'); m.close(); }
      });
    } catch (err) {
      handleError(err);
    }
  });

  document.getElementById('btn-report-note')?.addEventListener('click', async () => {
    const reason = await promptDialog({ title: t('notes.report_ai_error'), label: t('notes.report_ai_explain'), multiline: true });
    if (!reason) return;
    const { error } = await db.from('pran_not_content_reports').insert({
      reporter_id: userRef.id, item_type: 'ai_output', item_id: note.id, reason,
    });
    if (error) handleError(error);
    else toast(t('common.saved'), 'success');
  });

  document.getElementById('btn-delete-note')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: t('common.delete'), message: t('common.confirm_title'), danger: true });
    if (!ok) return;
    if (note.is_local_draft) {
      deleteDraftById(note.id);
      toast(t('common.deleted'), 'success');
      location.replace(appUrl('pages/notes.html'));
      return;
    }
    if (note.is_local_pending) {
      const qId = note.id.replace('local:', '');
      await removeQueueItem(qId);
      toast(t('common.deleted'), 'success');
      location.replace(appUrl('pages/notes.html'));
      return;
    }
    const { error } = await db.from('pran_not_notes').delete().eq('id', note.id);
    if (error) handleError(error);
    else location.replace(appUrl('pages/notes.html'));
  });

  // Quick AI Assistant nan note-view
  const nvAiCard = document.getElementById('note-view-quick-ai-card');
  if (nvAiCard) {
    const nvBtnGlobal = document.getElementById('nv-ai-scope-global');
    const nvBtnFaculty = document.getElementById('nv-ai-scope-faculty');
    const nvInput = document.getElementById('nv-quick-ai-input');
    const nvAskBtn = document.getElementById('nv-quick-ai-btn');
    const nvChips = document.getElementById('nv-quick-ai-chips');
    const nvResult = document.getElementById('nv-quick-ai-result');

    let nvScope = localStorage.getItem('prannot.note_ai_scope') || 'global';

    const syncNvScopeUI = () => {
      if (nvScope === 'global') {
        nvBtnGlobal?.classList.add('active');
        nvBtnFaculty?.classList.remove('active');
      } else {
        nvBtnFaculty?.classList.add('active');
        nvBtnGlobal?.classList.remove('active');
      }
    };
    syncNvScopeUI();

    nvBtnGlobal?.addEventListener('click', () => {
      nvScope = 'global';
      localStorage.setItem('prannot.note_ai_scope', 'global');
      syncNvScopeUI();
      toast(t('tutor.scope_switched_global'), 'info');
    });

    nvBtnFaculty?.addEventListener('click', () => {
      nvScope = 'faculty';
      localStorage.setItem('prannot.note_ai_scope', 'faculty');
      syncNvScopeUI();
      toast(t('tutor.scope_switched_faculty'), 'info');
    });

    nvChips?.querySelectorAll('[data-quick-prompt]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const prefix = chip.dataset.quickPrompt || '';
        if (nvInput) {
          nvInput.value = prefix + (nvInput.value ? nvInput.value.replace(/^[^:]+:\s*/, '') : '');
          nvInput.focus();
        }
      });
    });

    const runNvQuickAi = async () => {
      const q = nvInput?.value?.trim();
      if (!q) {
        toast(t('errors.required'), 'warning');
        nvInput?.focus();
        return;
      }

      setLoading(nvAskBtn, true);
      nvResult.hidden = false;
      nvResult.innerHTML = `
        <div class="card card-sm text-center p-3" style="background:var(--c-surface);">
          <div class="spinner mb-2" style="margin:0 auto;"></div>
          <p class="text-xs muted mb-0">${esc(t('capture.quick_ai_searching'))}</p>
        </div>
      `;

      try {
        const effectiveFaculty = nvScope === 'global' ? 'general' : (profileRef?.faculty_id || 'general');
        const res = await askTutor({
          message: q,
          mode: 'simple',
          scope: nvScope,
          faculty: effectiveFaculty,
          level: profileRef?.level || 'L1',
          language: getLang(),
          courseId: note.course_id || null,
          contextType: 'note',
          contextId: note.id,
          contextText: getFullNoteContent(),
        });

        const reply = res?.reply || '';
        if (!reply) throw new Error('No answer received');

        nvResult.innerHTML = `
          <div class="card card-sm" style="background:var(--c-surface);border:1px solid var(--c-primary-soft, #cbd5e1);">
            <div class="row-between mb-2" style="flex-wrap:wrap;gap:6px;">
              <div class="ai-suggestion-label">${icon('sparkles')}<span>${esc(q.length > 50 ? q.slice(0, 50) + '...' : q)}</span></div>
              <div class="row-wrap" style="gap:4px;">
                <button type="button" class="btn btn-xs btn-primary" id="nv-ai-insert-note">
                  ${icon('plus')}<span>${esc(t('capture.insert_in_note'))}</span>
                </button>
                <button type="button" class="btn btn-xs btn-ghost" id="nv-ai-copy-btn">
                  ${icon('copy')}<span>${esc(t('common.copy') || 'Kopye')}</span>
                </button>
                <button type="button" class="btn-icon" id="nv-ai-close-btn" aria-label="${esc(t('common.close'))}">
                  ${icon('x')}
                </button>
              </div>
            </div>
            <div class="prose text-sm" style="max-height:260px;overflow-y:auto;padding:8px;background:var(--c-surface-soft);border-radius:var(--r-card);">
              ${renderMarkdown(reply)}
            </div>
          </div>
        `;
        icons(nvResult);

        nvResult.querySelector('#nv-ai-insert-note')?.addEventListener('click', async (e) => {
          const insertBtn = e.currentTarget;
          setLoading(insertBtn, true);
          try {
            const insertionHtml = `<div class="card card-sm card-muted mt-3 mb-3" style="border-left:4px solid var(--c-primary,#F97316);background:var(--c-surface-2);">
              <h4 class="text-xs font-bold text-uppercase muted mb-1">${esc(q)}</h4>
              <div class="prose text-sm">${renderMarkdown(reply)}</div>
            </div>`;
            const insertionText = `\n\n[${q}]\n${reply}\n`;

            note.content_html = (note.content_html || '') + insertionHtml;
            note.content_text = (note.content_text || '') + insertionText;

            // Mete a jou nan DOM imedyatman
            const proseArticle = document.querySelector('#note-root article.prose');
            if (proseArticle) {
              proseArticle.insertAdjacentHTML('beforeend', insertionHtml);
              icons(proseArticle);
            }

            // Sove nan baz done oswa kach
            if (navigator.onLine && isUuid(note.id)) {
              await db.from('pran_not_notes').update({
                content_html: note.content_html,
                content_text: note.content_text,
                updated_at: new Date().toISOString(),
              }).eq('id', note.id);
            }
            await cacheSet(`note_${note.id}`, note);
            toast(t('capture.insert_in_note') + ' !', 'success');
            nvResult.hidden = true;
          } catch (insErr) {
            handleError(insErr);
          } finally {
            setLoading(insertBtn, false);
          }
        });

        nvResult.querySelector('#nv-ai-copy-btn')?.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(reply);
            toast(t('common.copied') || (isFr ? 'Copié !' : 'Kopye !'), 'success');
          } catch {
            toast(isFr ? 'Échec de la copie' : 'Kopye echwe', 'error');
          }
        });

        nvResult.querySelector('#nv-ai-close-btn')?.addEventListener('click', () => {
          nvResult.hidden = true;
        });

      } catch (err) {
        handleError(err);
        nvResult.innerHTML = `<div class="alert alert-error text-xs">${esc(err.message || 'Erè pandan repons IA')}</div>`;
      } finally {
        setLoading(nvAskBtn, false);
      }
    };

    nvAskBtn?.addEventListener('click', runNvQuickAi);
    nvInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runNvQuickAi();
      }
    });
  }
}

function renderProfQuestionsModal(questions = [], title = '', onInsertCallback) {
  const m = openModal({
    title: `Kesyon pou poze pwofesè a - ${title || ''}`,
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
              ${q.purpose ? `<p class="text-xs muted mb-1"><strong>Objektif :</strong> ${esc(q.purpose)}</p>` : ''}
              ${q.hint ? `<p class="text-xs text-accent mb-0"><strong>Sa pou w koute :</strong> ${esc(q.hint)}</p>` : ''}
              <div class="row-wrap mt-2" style="gap:6px;">
                ${onInsertCallback ? `
                  <button type="button" class="btn btn-xs btn-outline" data-insert-q="${esc(q.question)}">
                    ${icon('plus')}<span>Mete nan nòt la</span>
                  </button>
                ` : ''}
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
      navigator.clipboard?.writeText(b.dataset.copyProfQ || b.dataset.copyQ || '');
      toast(isFr ? 'Question copiée !' : 'Kesyon kopye !', 'success');
    });
  });

  if (onInsertCallback) {
    m.el.querySelectorAll('[data-insert-q]').forEach((b) => {
      b.addEventListener('click', () => {
        onInsertCallback(b.dataset.insertQ);
        m.close();
      });
    });
  }

  m.el.querySelectorAll('[data-ask-tutor-q]').forEach((b) => {
    b.addEventListener('click', () => {
      m.close();
      toggleTutorDrawer(true, `Eksplike m an detay repons pwofesè a gen chans bay sou kesyon sa a : "${b.dataset.askTutorQ}"`);
    });
  });
}

function formatDraftToNote(id, d, target) {
  const cleanBody = (d.body || d.rawText || d.content || '').trim();
  const cleanThoughts = (d.thoughts || '').trim();
  const cleanHtml = (d.quillHtml || d.content_html || '').trim();

  let combinedRaw = cleanBody;
  if (cleanThoughts) {
    combinedRaw = combinedRaw
      ? `${combinedRaw}\n\n## ${t('live.thoughts_section_title') || 'Panse & Ide Rapid'}\n${cleanThoughts}`
      : cleanThoughts;
  }

  const html = cleanHtml || (combinedRaw ? `<p>${esc(combinedRaw).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>` : '');
  const text = combinedRaw || (cleanHtml ? htmlToText(cleanHtml).trim() : '');
  const title = d.title?.trim() || (text ? text.split('\n')[0].slice(0, 80) : t('notes.untitled'));

  const isLive = id.includes('live') || d.source === 'live';
  const defaultTarget = isLive
    ? `./live-class.html?course=${encodeURIComponent(d.courseId || '')}&restore=1`
    : './note-capture.html';

  const structured = {
    homework: Array.isArray(d.homework) ? d.homework.map((h) => ({
      title: h.title,
      due_hint: h.due,
      description: h.description,
    })) : [],
    keywords: Array.isArray(d.keywords) ? d.keywords.map((k) => (typeof k === 'string' ? k : k.term)) : [],
  };

  return {
    id,
    is_local_draft: true,
    draft_target: target || defaultTarget,
    draft_data: d,
    title,
    content_html: html,
    content_text: text,
    raw_text: combinedRaw || null,
    summary: (d.summary || text).slice(0, 240),
    course_id: d.courseId || d.course_id || null,
    capture_mode: d.currentMode || (isLive ? 'audio' : 'text'),
    structured,
    created_at: new Date(d.archivedAt || d.savedAt || Date.now()).toISOString(),
    updated_at: new Date(d.archivedAt || d.savedAt || Date.now()).toISOString(),
  };
}

function loadDraftById(id) {
  if (!id) return null;
  if (id === 'draft:capture') {
    try {
      const raw = localStorage.getItem('prannot_note_capture_draft');
      if (raw) return formatDraftToNote('draft:capture', JSON.parse(raw), './note-capture.html');
    } catch {}
  }
  if (id === 'draft:live') {
    try {
      const raw = localStorage.getItem('prannot.liveClassDraft');
      if (raw) {
        const d = JSON.parse(raw);
        return formatDraftToNote('draft:live', d, `./live-class.html?course=${encodeURIComponent(d.courseId || '')}&restore=1`);
      }
    } catch {}
  }
  if (id.startsWith('draft:hist:')) {
    const idx = parseInt(id.replace('draft:hist:', ''), 10);
    try {
      const raw = localStorage.getItem('prannot.draft_history');
      if (raw) {
        const hist = JSON.parse(raw);
        if (Array.isArray(hist) && hist[idx]) {
          const d = hist[idx];
          const isLive = d.source === 'live' || d.kind === 'live';
          const target = isLive
            ? `./live-class.html?course=${encodeURIComponent(d.courseId || '')}&histIdx=${idx}`
            : `./note-capture.html?restoreDraft=${encodeURIComponent(id)}`;
          return formatDraftToNote(id, d, target);
        }
      }
    } catch {}
  }
  if (id.startsWith('draft:other:')) {
    const k = id.replace('draft:other:', '');
    try {
      const raw = localStorage.getItem(k);
      if (raw) {
        return formatDraftToNote(id, JSON.parse(raw), `./note-capture.html?restoreDraft=${encodeURIComponent(id)}`);
      }
    } catch {}
  }

  // Scan any matching draft in history or localStorage
  try {
    const histRaw = localStorage.getItem('prannot.draft_history');
    if (histRaw) {
      const hist = JSON.parse(histRaw);
      if (Array.isArray(hist)) {
        for (let i = 0; i < hist.length; i++) {
          const item = hist[i];
          const tName = item?.title || '';
          if (id === `draft:hist:${i}` || tName.toLowerCase() === id.toLowerCase() || (item?.id && item.id === id)) {
            const isLive = item.source === 'live' || item.kind === 'live';
            const target = isLive ? './live-class.html' : `./note-capture.html?restoreDraft=draft:hist:${i}`;
            return formatDraftToNote(`draft:hist:${i}`, item, target);
          }
        }
      }
    }
  } catch {}

  return null;
}

function deleteDraftById(id) {
  if (id === 'draft:capture') {
    localStorage.removeItem('prannot_note_capture_draft');
    return;
  }
  if (id === 'draft:live') {
    localStorage.removeItem('prannot.liveClassDraft');
    return;
  }
  if (id.startsWith('draft:hist:')) {
    const idx = parseInt(id.replace('draft:hist:', ''), 10);
    try {
      const raw = localStorage.getItem('prannot.draft_history');
      if (raw) {
        const hist = JSON.parse(raw);
        if (Array.isArray(hist)) {
          hist.splice(idx, 1);
          localStorage.setItem('prannot.draft_history', JSON.stringify(hist));
        }
      }
    } catch {}
    return;
  }
  if (id.startsWith('draft:other:')) {
    const k = id.replace('draft:other:', '');
    localStorage.removeItem(k);
  }
}

function saveDraftPatchById(id, patch) {
  if (id === 'draft:capture') {
    try {
      const raw = localStorage.getItem('prannot_note_capture_draft');
      const d = raw ? JSON.parse(raw) : {};
      if ('title' in patch) d.title = patch.title;
      if ('course_id' in patch) d.courseId = patch.course_id;
      if ('summary' in patch) d.summary = patch.summary;
      if ('content_text' in patch) d.rawText = patch.content_text;
      if ('content_html' in patch) d.quillHtml = patch.content_html;
      d.savedAt = Date.now();
      localStorage.setItem('prannot_note_capture_draft', JSON.stringify(d));
    } catch {}
    return;
  }
  if (id === 'draft:live') {
    try {
      const raw = localStorage.getItem('prannot.liveClassDraft');
      const d = raw ? JSON.parse(raw) : {};
      if ('title' in patch) d.title = patch.title;
      if ('course_id' in patch) d.courseId = patch.course_id;
      if ('content_text' in patch) d.body = patch.content_text;
      d.savedAt = Date.now();
      localStorage.setItem('prannot.liveClassDraft', JSON.stringify(d));
    } catch {}
    return;
  }
  if (id.startsWith('draft:hist:')) {
    const idx = parseInt(id.replace('draft:hist:', ''), 10);
    try {
      const raw = localStorage.getItem('prannot.draft_history');
      if (raw) {
        const hist = JSON.parse(raw);
        if (Array.isArray(hist) && hist[idx]) {
          if ('title' in patch) hist[idx].title = patch.title;
          if ('course_id' in patch) hist[idx].courseId = patch.course_id;
          if ('summary' in patch) hist[idx].summary = patch.summary;
          if ('content_text' in patch) hist[idx].rawText = patch.content_text;
          if ('content_html' in patch) hist[idx].quillHtml = patch.content_html;
          localStorage.setItem('prannot.draft_history', JSON.stringify(hist));
        }
      }
    } catch {}
  }
}

async function resolveNote(rawId) {
  if (!rawId) return null;
  const id = String(rawId).trim();

  // 1. Brouillon local
  if (id.startsWith('draft:')) {
    const draft = loadDraftById(id);
    if (draft) return draft;
  }

  // 2. Note dans la file d'attente hors-ligne (local:<id>)
  if (id.startsWith('local:')) {
    const qId = id.slice('local:'.length);
    const items = await getQueueItems();
    const item = items.find((x) => String(x.id) === String(qId) || String(x.payload?.client_id) === String(qId));
    if (item?.payload) {
      const p = item.payload;
      return {
        id,
        is_local_pending: true,
        title: p.title || t('notes.untitled'),
        content_html: p.content_html || (p.content_text ? `<p>${esc(p.content_text).replace(/\n+/g, '</p><p>')}</p>` : ''),
        content_text: p.content_text || p.raw_text || '',
        raw_text: p.raw_text || null,
        summary: (p.content_text || p.raw_text || '').slice(0, 240),
        course_id: p.course_id || null,
        capture_mode: p.capture_mode || 'text',
        created_at: new Date(item.createdAt).toISOString(),
        updated_at: new Date(item.createdAt).toISOString(),
      };
    }
    // Si la file a déjà été synchronisée avec Supabase, chercher par client_id dans Supabase ou dans le cache
    if (navigator.onLine) {
      try {
        const { data } = await db.from('pran_not_notes').select('*').eq('client_id', qId).maybeSingle();
        if (data) {
          await cacheSet(`note_${data.id}`, data);
          return data;
        }
      } catch {}
    }
  }

  // 3. Cache direct note_${id}
  const cachedNote = (await cacheGet(`note_${id}`)) || (await cacheGet(id));
  if (cachedNote && !navigator.onLine) {
    return cachedNote;
  }

  // 4. Supabase distant si en ligne et UUID valide
  if (navigator.onLine && isUuid(id)) {
    try {
      const { data, error } = await db.from('pran_not_notes').select('*').eq('id', id).maybeSingle();
      if (!error && data) {
        await cacheSet(`note_${id}`, data);
        return data;
      }
    } catch {}
  }

  // 5. Repli sur le cache direct même si en ligne (si Supabase n'a pas répondu ou en erreur)
  if (cachedNote) return cachedNote;

  // 6. Recherche dans le cache de liste notes_list
  const cachedList = (await cacheGet('notes_list')) || [];
  const fromList = cachedList.find((x) => x.id === id || x.client_id === id);
  if (fromList) {
    return {
      ...fromList,
      content_html: fromList.content_html || (fromList.content_text ? `<p>${esc(fromList.content_text).replace(/\n+/g, '</p><p>')}</p>` : ''),
    };
  }

  // 7. Recherche dans toutes les entrées du cache commençant par 'note_'
  try {
    const allCached = await cacheEntriesByPrefix('note_');
    const matched = allCached.find((e) => e.data?.id === id || e.key === `note_${id}` || e.data?.client_id === id);
    if (matched?.data) return matched.data;
  } catch {}

  // 8. Recherche de dernier recours dans les brouillons localStorage
  const fallbackDraft = loadDraftById(id);
  if (fallbackDraft) return fallbackDraft;

  // 9. Recherche par client_id dans Supabase si l'id était un client_id non-UUID
  if (navigator.onLine) {
    try {
      const { data } = await db.from('pran_not_notes').select('*').or(`id.eq.${id},client_id.eq.${id}`).maybeSingle();
      if (data) {
        await cacheSet(`note_${data.id}`, data);
        return data;
      }
    } catch {}
  }

  return null;
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  profileRef = profile;

  const id = getParam('id');
  await initAppChrome({ profile, user, active: 'notes' });
  pageEnter();

  note = await resolveNote(id);
  if (!note) {
    document.getElementById('note-root').innerHTML = `<div class="alert alert-error">${esc(t('errors.not_found'))}</div>`;
    return;
  }

  // Si un cours est associé, le charger
  if (note.course_id) {
    const cachedCourses = (await cacheGet('courses_list')) || [];
    course = cachedCourses.find((c) => c.id === note.course_id) || null;
    if (!course && navigator.onLine && isUuid(note.course_id)) {
      try {
        const { data: c } = await db.from('pran_not_courses').select('id, name, color').eq('id', note.course_id).maybeSingle();
        course = c;
      } catch {}
    }
  } else if (note.ai_course_suggestion) {
    const cachedCourses = (await cacheGet('courses_list')) || [];
    suggestedCourse = cachedCourses.find((c) => c.id === note.ai_course_suggestion) || null;
    if (!suggestedCourse && navigator.onLine && isUuid(note.ai_course_suggestion)) {
      try {
        const { data: sc } = await db.from('pran_not_courses').select('id, name, color').eq('id', note.ai_course_suggestion).maybeSingle();
        suggestedCourse = sc;
      } catch {}
    }
  }

  // Sources originales
  if (isUuid(note.id)) {
    if (navigator.onLine) {
      try {
        const { data: sRows } = await db.from('pran_not_note_sources').select('*').eq('note_id', note.id).order('chunk_index');
        sources = sRows || [];
        await cacheSet(`sources_${note.id}`, sources);
      } catch {}
    } else {
      sources = (await cacheGet(`sources_${note.id}`)) || [];
    }
  }

  setTutorContext({
    contextType: 'note',
    contextId: note.id,
    contextTitle: note.title,
    contextText: `${note.title}\n${note.summary || ''}\n${note.content_text || ''}`,
    courseId: note.course_id,
  });

  await renderNote();
})();
