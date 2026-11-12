/* =====================================================================
   PRAN NÒT - pages/note-view.js
   Affichage d'une note propre + sources originales + actions IA :
   flashcards, quiz, simplification, tuteur, export PDF/Word/MD, partage.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, appUrl } from '../auth.js';
import { initAppChrome, setTutorContext, toggleTutorDrawer } from '../navbar.js';
import { t, getLang, formatDate } from '../i18n.js';
import {
  icons, icon, esc, sanitizeHtml, renderMarkdown, openModal, confirmDialog,
  toast, handleError, setLoading, getParam, isUuid, pageEnter, promptDialog,
} from '../utils.js';
import { generateFlashcards, generateTest, explainText, processNote } from '../ai.js';
import { exportNotePdf, exportNoteDocx, exportNoteMarkdown } from '../export.js';
import { cacheSet, cacheGet, isDataSaver } from '../offline.js';

const db = window.db;
let note = null;
let course = null;
let suggestedCourse = null;
let sources = [];
let profileRef = null;
let userRef = null;

async function renderNote() {
  const root = document.getElementById('note-root');
  if (!note) return;

  const st = note.structured || {};
  const takeaways = Array.isArray(st.takeaways) ? st.takeaways : [];
  const implied = Array.isArray(st.implied_points) ? st.implied_points : [];
  const keywords = Array.isArray(st.keywords) ? st.keywords : [];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="row-wrap mb-2">
          <a class="btn btn-sm btn-ghost" href="./notes.html">${icon('arrow-left')}<span>${esc(t('common.back'))}</span></a>
          ${course ? `<a class="badge badge-outline" href="./course.html?id=${esc(course.id)}"><span class="course-dot" style="background:${esc(course.color || '#F97316')}"></span><span>${esc(course.name)}</span></a>` : ''}
          <span class="badge">${esc(formatDate(note.updated_at || note.created_at))}</span>
        </div>
        <h1>${esc(note.title || t('notes.untitled'))}</h1>
      </div>
      <div class="page-head-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="btn-edit-note">${icon('edit-3')}<span>${esc(t('common.edit'))}</span></button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-share-note">${icon('share-2')}<span>Pataje</span></button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-export-note">${icon('download')}<span>${esc(t('notes.btn_export'))}</span></button>
        <button type="button" class="btn btn-danger btn-sm" id="btn-delete-note">${icon('trash-2')}</button>
      </div>
    </div>

    ${(!note.course_id && suggestedCourse) ? `
      <div class="ai-suggestion mb-6 row-between">
        <div>
          <div class="ai-suggestion-label">${icon('sparkles')}<span>IA</span></div>
          <div>${esc(t('capture.suggested_course', { course: suggestedCourse.name }))}</div>
        </div>
        <button type="button" class="btn btn-sm btn-primary" id="btn-confirm-course">${esc(t('capture.confirm_course'))}</button>
      </div>` : ''}

    <!-- Barre d'actions IA sur la note -->
    <div class="row-wrap mb-6">
      <button type="button" class="btn btn-primary" id="btn-gen-cards">${icon('layers')}<span>${esc(t('notes.btn_flashcards'))}</span></button>
      <button type="button" class="btn btn-dark" id="btn-gen-quiz">${icon('check-circle-2')}<span>${esc(t('notes.btn_quiz'))}</span></button>
      <button type="button" class="btn btn-secondary" id="btn-simpler">${icon('sparkles')}<span>${esc(t('notes.btn_simpler'))}</span></button>
      <button type="button" class="btn btn-secondary" id="btn-ask-tutor">${icon('message-square')}<span>${esc(t('notes.btn_tutor'))}</span></button>
      ${!note.structured && note.raw_text ? `<button type="button" class="btn btn-secondary" id="btn-ai-clean">${icon('wand-2')}<span>${esc(t('capture.structure_ai'))}</span></button>` : ''}
    </div>

    <div class="grid grid-main-side">
      <div class="stack">
        ${note.summary ? `
          <section class="card card-accent">
            <h2 class="card-title">${esc(t('notes.summary'))}</h2>
            <p class="mb-0">${esc(note.summary)}</p>
          </section>` : ''}

        <article class="card prose">
          ${note.content_html ? sanitizeHtml(note.content_html) : `<p>${esc(note.content_text || note.raw_text || '')}</p>`}
        </article>

        ${implied.length ? `
          <section class="ai-suggestion">
            <div class="ai-suggestion-label">${icon('sparkles')}<span>${esc(t('notes.implied_title'))} — ${esc(t('notes.implied_badge'))}</span></div>
            <ul class="mt-2 mb-0" style="padding-left:1.3em;">
              ${implied.map((item) => `<li>${esc(item)}</li>`).join('')}
            </ul>
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
            ${icon('flag')}<span>Siyale yon erè IA</span>
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

  if (!navigator.onLine) {
    box.innerHTML = `<p class="text-sm muted mb-0">${esc(t('errors.offline'))}</p>`;
    return;
  }

  const saver = isDataSaver();
  const itemsHtml = [];

  for (const s of sources) {
    const bucket = s.kind === 'audio' ? 'pran-not-note-audio' : s.kind === 'pdf' ? 'pran-not-syllabi' : 'pran-not-note-images';
    const { data } = await db.storage.from(bucket).createSignedUrl(s.storage_path, 3600);
    const url = data?.signedUrl;
    if (!url) continue;

    if (s.kind === 'image') {
      if (saver) {
        itemsHtml.push(`<button type="button" class="btn btn-sm btn-secondary" data-load-img="${esc(url)}">${icon('image')}<span>Chaje foto orijinal (ekonomi done)</span></button>`);
      } else {
        itemsHtml.push(`<img src="${esc(url)}" alt="Foto orijinal tablo" loading="lazy" style="border-radius:12px;border:1px solid var(--c-border);">`);
      }
    } else if (s.kind === 'audio') {
      itemsHtml.push(`<div class="card card-sm card-muted"><div class="text-xs muted mb-1">Odyo orijinal</div><audio controls src="${esc(url)}" style="width:100%;"></audio></div>`);
    } else {
      itemsHtml.push(`<a class="btn btn-sm btn-secondary" href="${esc(url)}" target="_blank" rel="noopener">${icon('file-text')}<span>PDF orijinal</span></a>`);
    }
  }
  box.innerHTML = itemsHtml.join('');
  box.querySelectorAll('[data-load-img]').forEach((b) => {
    b.addEventListener('click', () => {
      b.outerHTML = `<img src="${esc(b.dataset.loadImg)}" alt="Foto orijinal" loading="lazy" style="border-radius:12px;border:1px solid var(--c-border);">`;
    });
  });
  icons(box);
}

function bindActions() {
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
      const res = await generateFlashcards({
        content: note.content_text || note.raw_text || note.summary || '',
        title: note.title,
        language: getLang(),
        faculty: profileRef?.faculty_id,
        level: profileRef?.level,
        count: 8,
        courseId: note.course_id,
        unitId: note.unit_id,
        noteId: note.id,
      });
      toast(`${res.cards?.length || 0} kat memwa kreye.`, 'success', {
        action: {
          label: t('nav.review'),
          onClick: () => { location.href = appUrl(`pages/flashcards.html?deck=${res.deckId}`); },
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
      const res = await generateTest({
        content: note.content_text || note.raw_text || note.summary || '',
        title: note.title,
        difficulty: 'medium',
        language: getLang(),
        faculty: profileRef?.faculty_id,
        level: profileRef?.level,
        count: 5,
      });
      const { data: testRow, error: tErr } = await db.from('pran_not_tests').insert({
        user_id: userRef.id,
        course_id: note.course_id,
        unit_id: note.unit_id,
        note_id: note.id,
        title: res.title || note.title,
        difficulty: 'medium',
        kind: 'standard',
        source: 'ai',
      }).select().single();
      if (tErr) throw tErr;

      const qRows = (res.questions || []).map((q, idx) => ({
        test_id: testRow.id,
        user_id: userRef.id,
        unit_id: note.unit_id,
        position: idx + 1,
        type: q.type,
        prompt: q.prompt,
        options: q.options || [],
        answer: q.answer,
        explanation: q.explanation || '',
        keyword: q.keyword || '',
        points: q.points || 1,
      }));
      if (qRows.length) await db.from('pran_not_test_questions').insert(qRows);
      location.href = appUrl(`pages/test-session.html?id=${testRow.id}`);
    } catch (err) {
      handleError(err);
      setLoading(btn, false);
    }
  });

  document.getElementById('btn-simpler')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const res = await explainText({
        text: `${note.title}\n\n${note.content_text || note.raw_text || ''}`,
        mode: 'simple',
        language: getLang(),
        faculty: profileRef?.faculty_id,
        level: profileRef?.level,
      });
      openModal({
        title: t('notes.btn_simpler'),
        size: 'lg',
        body: `<div class="prose">${renderMarkdown(res?.result?.text || '')}</div>`,
      });
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  document.getElementById('btn-ask-tutor')?.addEventListener('click', () => {
    toggleTutorDrawer(true);
  });

  document.getElementById('btn-ai-clean')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const res = await processNote({
        rawText: note.raw_text || note.content_text,
        language: getLang(),
        faculty: profileRef?.faculty_id,
        level: profileRef?.level,
        noteId: note.id,
      });
      note.title = res.title || note.title;
      note.summary = res.summary || note.summary;
      note.content_html = res.content_html || note.content_html;
      note.structured = res;
      toast(t('common.saved'), 'success');
      renderNote();
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
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

  document.getElementById('btn-edit-note')?.addEventListener('click', async () => {
    const m = openModal({
      title: t('common.edit'),
      size: 'lg',
      body: `
        <div class="field"><label>Tit</label><input class="input" id="ed-title" value="${esc(note.title || '')}"></div>
        <div class="field"><label>Rezime</label><textarea class="textarea" id="ed-summary" rows="3">${esc(note.summary || '')}</textarea></div>
        <div class="field"><label>Kontni</label><textarea class="textarea" id="ed-content" rows="10">${esc(note.content_text || '')}</textarea></div>`,
      footer: `<button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
               <button type="button" class="btn btn-primary" id="ed-save">${esc(t('common.save'))}</button>`,
    });
    m.el.querySelector('#ed-save').addEventListener('click', async () => {
      const title = m.el.querySelector('#ed-title').value.trim();
      const summary = m.el.querySelector('#ed-summary').value.trim();
      const contentText = m.el.querySelector('#ed-content').value.trim();
      const contentHtml = `<p>${esc(contentText).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
      const { error } = await db.from('pran_not_notes').update({ title, summary, content_text: contentText, content_html: contentHtml }).eq('id', note.id);
      if (error) { handleError(error); return; }
      note.title = title; note.summary = summary; note.content_text = contentText; note.content_html = contentHtml;
      toast(t('common.saved'), 'success');
      m.close();
      renderNote();
    });
  });

  document.getElementById('btn-share-note')?.addEventListener('click', async () => {
    try {
      const { data: groups } = await db.from('pran_not_study_groups').select('id, name');
      if (!groups?.length) {
        toast('Kreye oswa antre nan yon gwoup etid anvan nan Planifikatè.', 'info', {
          action: { label: t('nav.planner'), onClick: () => { location.href = appUrl('pages/planner.html'); } },
        });
        return;
      }
      const m = openModal({
        title: 'Pataje nòt la nan yon gwoup',
        body: `
          <div class="field"><label>Gwoup etid</label>
            <select class="select" id="sh-group">${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Pèmisyon</label>
            <select class="select" id="sh-perm">
              <option value="copy">Li + Kopye nan nòt pa yo</option>
              <option value="view">Li sèlman</option>
            </select>
          </div>`,
        footer: `<button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
                 <button type="button" class="btn btn-primary" id="sh-ok">Pataje</button>`,
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
    const reason = await promptDialog({ title: 'Siyale yon erè IA', label: 'Eksplike sa ki pa egzak', multiline: true });
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
    const { error } = await db.from('pran_not_notes').delete().eq('id', note.id);
    if (error) handleError(error);
    else location.replace(appUrl('pages/notes.html'));
  });
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  profileRef = profile;

  const id = getParam('id');
  await initAppChrome({ profile, user, active: 'notes' });
  pageEnter();

  if (!isUuid(id)) {
    document.getElementById('note-root').innerHTML = `<div class="alert alert-error">${esc(t('errors.not_found'))}</div>`;
    return;
  }

  try {
    const { data, error } = await db.from('pran_not_notes').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('not_found');
    note = data;
    await cacheSet(`note_${id}`, note);

    if (note.course_id) {
      const { data: c } = await db.from('pran_not_courses').select('id, name, color').eq('id', note.course_id).maybeSingle();
      course = c;
    } else if (note.ai_course_suggestion) {
      const { data: sc } = await db.from('pran_not_courses').select('id, name, color').eq('id', note.ai_course_suggestion).maybeSingle();
      suggestedCourse = sc;
    }

    const { data: sRows } = await db.from('pran_not_note_sources').select('*').eq('note_id', id).order('chunk_index');
    sources = sRows || [];
  } catch (err) {
    note = await cacheGet(`note_${id}`);
    if (!note) {
      document.getElementById('note-root').innerHTML = `<div class="alert alert-error">${esc(t('errors.not_found'))}</div>`;
      return;
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
