/* =====================================================================
   PRAN NÒT - pages/planner.js
   Minuteur Pomodoro avec journalisation par cours, planning à rebours
   d'examen et groupes d'étude (création, code d'invitation, partage).
   ===================================================================== */
import '../supabase.js';
import { requireAuth, recordActivity, awardXp, appUrl } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, formatDate } from '../i18n.js';
import {
  icons, icon, esc, formatDuration, toast, handleError, openModal, promptDialog, uid, pageEnter,
} from '../utils.js';
import { enqueue } from '../offline.js';

const db = window.db;
let userRef = null;
let courses = [];
let groups = [];

// État Pomodoro
let pomoMode = 'work';
let remainingSec = 25 * 60;
let elapsedWorkSec = 0;
let timerId = null;

function updateTimerUi() {
  document.getElementById('pomo-display').textContent = formatDuration(remainingSec);
}

async function saveStudySession(minutes) {
  if (minutes < 1) return;
  const courseId = document.getElementById('pomo-course').value || null;
  const payload = {
    user_id: userRef.id,
    course_id: courseId,
    kind: 'pomodoro',
    started_at: new Date(Date.now() - minutes * 60000).toISOString(),
    ended_at: new Date().toISOString(),
    duration_minutes: minutes,
    client_id: uid(),
  };

  if (!navigator.onLine) {
    await enqueue('session', payload);
    toast(t('offline.saved_locally'), 'info');
    return;
  }

  try {
    const { error } = await db.from('pran_not_study_sessions').insert(payload);
    if (error) throw error;
    await recordActivity();
    await awardXp(Math.min(40, minutes), 'pomodoro');
    toast(`+${minutes} min sove.`, 'success');
  } catch (err) {
    await enqueue('session', payload);
    handleError(err);
  }
}

function startTimer() {
  if (timerId) return;
  document.getElementById('pomo-start-btn').hidden = true;
  document.getElementById('pomo-pause-btn').hidden = false;
  timerId = setInterval(() => {
    if (remainingSec > 0) {
      remainingSec--;
      if (pomoMode === 'work') elapsedWorkSec++;
      updateTimerUi();
    } else {
      clearInterval(timerId);
      timerId = null;
      document.getElementById('pomo-start-btn').hidden = false;
      document.getElementById('pomo-pause-btn').hidden = true;
      if (pomoMode === 'work') {
        const mins = Math.max(1, Math.round(elapsedWorkSec / 60));
        elapsedWorkSec = 0;
        saveStudySession(mins);
      } else {
        toast('Poz fini. Pare pou kontinye.', 'info');
      }
    }
  }, 1000);
}

function pauseTimer() {
  clearInterval(timerId);
  timerId = null;
  document.getElementById('pomo-start-btn').hidden = false;
  document.getElementById('pomo-pause-btn').hidden = true;
}

function resetTimer(mode = pomoMode) {
  pauseTimer();
  pomoMode = mode;
  remainingSec = mode === 'work' ? 25 * 60 : 5 * 60;
  elapsedWorkSec = 0;
  document.getElementById('pomo-mode-work').setAttribute('aria-pressed', mode === 'work' ? 'true' : 'false');
  document.getElementById('pomo-mode-break').setAttribute('aria-pressed', mode === 'break' ? 'true' : 'false');
  updateTimerUi();
}

/* ------------------------------------------------------------------
   Planning à rebours depuis la date d'examen
   ------------------------------------------------------------------ */
async function generateBackwardsPlan() {
  const courseId = document.getElementById('plan-course').value;
  const dateStr = document.getElementById('plan-exam-date').value;
  if (!courseId || !dateStr) { toast(t('errors.required'), 'warning'); return; }

  const examDate = new Date(`${dateStr}T09:00:00`);
  const daysLeft = Math.max(1, Math.ceil((examDate.getTime() - Date.now()) / 86400000));

  await db.from('pran_not_courses').update({ exam_date: dateStr }).eq('id', courseId);
  const { data: units } = await db.from('pran_not_syllabus_units').select('*').eq('course_id', courseId).order('position');

  const box = document.getElementById('exam-schedule-box');
  if (!units?.length) {
    box.innerHTML = `<p class="text-sm muted">Dat egzamen an sove (${daysLeft} jou rete). Enpòte silabis kou a pou repati chapit yo jou pa jou.</p>`;
    return;
  }

  // Répartir les unités entre aujourd'hui et J-2 avant l'examen (les 2 derniers jours réservés à la révision générale)
  const studySpan = Math.max(1, daysLeft - 2);
  const stepDays = studySpan / units.length;
  const schedule = [];

  for (let i = 0; i < units.length; i++) {
    const offset = Math.min(studySpan, Math.max(0, Math.floor(i * stepDays)));
    const planned = new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    await db.from('pran_not_syllabus_units').update({ planned_date: planned }).eq('id', units[i].id);
    schedule.push({ title: units[i].title, planned });
  }

  box.innerHTML = `<ul class="list">${schedule.map((s) => `
    <li class="list-item">
      <span class="flex-1 text-sm">${esc(s.title)}</span>
      <span class="badge">${esc(formatDate(s.planned))}</span>
    </li>`).join('')}
    <li class="list-item">
      <span class="flex-1 text-sm"><strong>Revizyon jeneral + Tès egzamen blan</strong></span>
      <span class="badge badge-accent">${esc(formatDate(dateStr))}</span>
    </li></ul>`;
  toast(t('common.saved'), 'success');
}

/* ------------------------------------------------------------------
   Groupes d'étude et partage
   ------------------------------------------------------------------ */
async function loadGroups() {
  const { data } = await db.from('pran_not_study_groups').select('*').order('created_at', { ascending: false });
  groups = data || [];
  renderGroups();
}

function renderGroups() {
  const box = document.getElementById('groups-box');
  if (!groups.length) {
    box.innerHTML = `<p class="text-sm muted mb-0">Ou poko nan okenn gwoup etid. Kreye youn oswa antre ak kòd yon kamarad.</p>`;
    return;
  }
  box.innerHTML = groups.map((g) => `
    <article class="card card-sm">
      <div class="row-between mb-2">
        <strong class="font-display">${esc(g.name)}</strong>
        <button type="button" class="badge badge-accent" data-copy-code="${esc(g.invite_code)}" title="Kopye kòd">Kòd: ${esc(g.invite_code)}</button>
      </div>
      ${g.description ? `<p class="text-xs muted mb-3">${esc(g.description)}</p>` : ''}
      <button type="button" class="btn btn-sm btn-secondary" data-open-group="${esc(g.id)}">${icon('users')}<span>Louvri espas gwoup la</span></button>
    </article>`).join('');

  box.querySelectorAll('[data-copy-code]').forEach((b) => {
    b.addEventListener('click', () => {
      navigator.clipboard?.writeText(b.dataset.copyCode);
      toast(t('common.copied'), 'success');
    });
  });
  box.querySelectorAll('[data-open-group]').forEach((b) => {
    b.addEventListener('click', () => openGroupDetail(b.dataset.openGroup));
  });
  icons(box);
}

async function openGroupDetail(groupId) {
  const g = groups.find((x) => x.id === groupId);
  if (!g) return;

  const [{ data: members }, { data: shared }] = await Promise.all([
    db.rpc('pran_not_get_group_members', { p_group: groupId }),
    db.from('pran_not_shared_items').select('*').eq('group_id', groupId).order('created_at', { ascending: false }),
  ]);

  // Charger les titres des éléments partagés
  const itemsHtml = [];
  for (const si of shared || []) {
    let label = si.item_type === 'note' ? 'Nòt' : 'Pake kat';
    if (si.item_type === 'note') {
      const { data: n } = await db.from('pran_not_notes').select('title').eq('id', si.item_id).maybeSingle();
      if (n?.title) label = n.title;
    } else {
      const { data: d } = await db.from('pran_not_flashcard_decks').select('title').eq('id', si.item_id).maybeSingle();
      if (d?.title) label = d.title;
    }
    itemsHtml.push(`
      <li class="list-item">
        <span class="icon-chip sm">${icon(si.item_type === 'note' ? 'file-text' : 'layers')}</span>
        <div class="flex-1">
          <div class="list-item-title">${esc(label)}</div>
          <div class="list-item-sub">${si.permission === 'copy' ? 'Li + Kopye' : 'Li sèlman'}</div>
        </div>
        ${si.item_type === 'note' ? `<a class="btn btn-sm btn-secondary" href="./note-view.html?id=${esc(si.item_id)}">${esc(t('common.open'))}</a>` : ''}
        ${si.permission === 'copy' && si.shared_by !== userRef.id ? `<button type="button" class="btn btn-sm btn-primary" data-copy-shared="${esc(si.id)}">${esc(t('common.copy'))}</button>` : ''}
      </li>`);
  }

  const m = openModal({
    title: g.name,
    size: 'lg',
    body: `
      <div class="row-between mb-4">
        <span class="text-sm muted">Kòd envitasyon : <strong>${esc(g.invite_code)}</strong></span>
        <span class="badge">${(members || []).length} manm</span>
      </div>
      <div class="row-wrap mb-4">
        ${(members || []).map((mb) => `<span class="badge">${esc(mb.full_name || 'Etidyan')} (${esc(mb.role)})</span>`).join('')}
      </div>
      <h3 class="text-sm font-display mb-2">Kontni pataje nan gwoup la</h3>
      <ul class="list">${itemsHtml.length ? itemsHtml.join('') : `<li class="list-item text-sm muted">Okenn nòt oswa kat pataje ankò. Louvri yon nòt epi klike sou Pataje.</li>`}</ul>`,
  });

  m.el.querySelectorAll('[data-copy-shared]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const { data: newId, error } = await db.rpc('pran_not_copy_shared_item', { p_shared_id: btn.dataset.copyShared });
        if (error) throw error;
        toast(t('common.saved'), 'success');
        m.close();
        if (newId) location.href = appUrl(`pages/note-view.html?id=${newId}`);
      } catch (err) {
        handleError(err);
      }
    });
  });
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;

  await initAppChrome({ profile, user, active: 'planner' });
  setTutorContext({ contextType: 'general', contextTitle: t('planner.title') });
  pageEnter();

  const { data: cData } = await db.from('pran_not_courses').select('id, name, exam_date').eq('archived', false).order('name');
  courses = cData || [];

  const pomoSel = document.getElementById('pomo-course');
  const planSel = document.getElementById('plan-course');
  courses.forEach((c) => {
    pomoSel.insertAdjacentHTML('beforeend', `<option value="${esc(c.id)}">${esc(c.name)}</option>`);
    planSel.insertAdjacentHTML('beforeend', `<option value="${esc(c.id)}">${esc(c.name)}</option>`);
  });
  if (courses[0]?.exam_date) document.getElementById('plan-exam-date').value = courses[0].exam_date;
  planSel.addEventListener('change', () => {
    const c = courses.find((x) => x.id === planSel.value);
    document.getElementById('plan-exam-date').value = c?.exam_date || '';
  });

  document.getElementById('pomo-mode-work').addEventListener('click', () => resetTimer('work'));
  document.getElementById('pomo-mode-break').addEventListener('click', () => resetTimer('break'));
  document.getElementById('pomo-start-btn').addEventListener('click', startTimer);
  document.getElementById('pomo-pause-btn').addEventListener('click', pauseTimer);
  document.getElementById('pomo-reset-btn').addEventListener('click', () => resetTimer(pomoMode));
  document.getElementById('pomo-log-btn').addEventListener('click', async () => {
    const mins = Math.max(1, Math.round(elapsedWorkSec / 60));
    elapsedWorkSec = 0;
    await saveStudySession(mins);
  });

  document.getElementById('gen-backwards-btn').addEventListener('click', generateBackwardsPlan);

  document.getElementById('create-group-btn').addEventListener('click', async () => {
    const name = await promptDialog({ title: t('planner.create_group'), label: 'Non gwoup la', placeholder: 'Ex : Medsin 2e ane UEH' });
    if (!name) return;
    const { error } = await db.from('pran_not_study_groups').insert({ owner_id: userRef.id, name });
    if (error) handleError(error);
    else { toast(t('common.saved'), 'success'); await loadGroups(); }
  });

  document.getElementById('join-group-btn').addEventListener('click', async () => {
    const code = await promptDialog({ title: t('planner.join_group'), label: 'Kòd envitasyon', placeholder: 'Ex : A1B2C3D4' });
    if (!code) return;
    const { error } = await db.rpc('pran_not_join_group', { p_code: code });
    if (error) handleError(error);
    else { toast(t('common.saved'), 'success'); await loadGroups(); }
  });

  await loadGroups();
})();
