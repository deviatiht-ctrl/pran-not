/* =====================================================================
   PRAN NÒT - live-transfer.js
   Transfè nòt an dirèk ant etidyan sou sit la avèk kòd 6 chif
   + Revizyon egzamen pa peryòd dat (de tel date a tel date)
   ===================================================================== */
import './supabase.js';
import { requireAuth, appUrl } from './auth.js';
import { t, formatDate } from './i18n.js';
import { openModal, esc, icons, icon, toast, handleError, setLoading } from './utils.js';
import { playNotificationSound } from './notifications.js';

const db = window.db;

/**
 * Jenere yon kòd 6 chif separe ak yon tire (eg: 742-198)
 */
function generateTransferCode() {
  const n = Math.floor(100000 + Math.random() * 900000);
  const s = String(n);
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

/**
 * Ouvri modal pou voye yon nòt bay yon lòt etidyan ki sou sit la
 */
export async function openSendTransferModal(noteData) {
  const { user, profile } = await requireAuth();
  const rawCode = generateTransferCode();
  const title = noteData.title || t('notes.untitled');

  let transferRow = null;
  let pollInterval = null;

  const m = openModal({
    title: t('transfer.send_title') || 'Pataje nòt an dirèk sou sit la',
    body: `
      <div class="stack text-center py-2">
        <p class="text-sm muted mb-1">
          Bay lòt etidyan an kòd sa a. Fòk li sou sit la epi klike sou <strong>"Resevwa nòt"</strong> pou transfè a fèt touswit :
        </p>
        <div class="card card-accent my-3 py-4" style="background:var(--c-surface-2);border:2px dashed var(--c-accent);">
          <div class="text-xs uppercase muted mb-1">Kòd Transfè an Dirèk</div>
          <div id="transfer-display-code" style="font-size:2rem;font-weight:900;letter-spacing:4px;color:var(--c-accent);font-family:monospace;">
            ${esc(rawCode)}
          </div>
          <div class="text-xs muted mt-1">Valab pandan 30 minit</div>
        </div>

        <div class="row-center mb-3" style="gap:8px;">
          <button type="button" class="btn btn-sm btn-secondary" id="transfer-copy-code-btn">
            ${icon('copy')}<span>Kopye kòd la</span>
          </button>
          <button type="button" class="btn btn-sm btn-outline" id="transfer-test-sound-btn">
            ${icon('volume-2')}<span>Tande son</span>
          </button>
        </div>

        <div id="transfer-status-box" class="alert alert-info">
          <span class="live-pulse-dot"></span>
          <span>Nap tann lòt etidyan an antre kòd la...</span>
        </div>
      </div>
    `,
  });

  icons(m.el);

  m.el.querySelector('#transfer-test-sound-btn')?.addEventListener('click', () => {
    playNotificationSound('success', { force: true });
  });

  m.el.querySelector('#transfer-copy-code-btn')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(rawCode.replace('-', ''));
      toast('Kòd kopye nan bipò!', 'success');
    } catch {
      toast(rawCode, 'info');
    }
  });

  // Enskri transfè a nan DB
  try {
    const payload = {
      title,
      content_html: noteData.content_html || '',
      content_text: noteData.content_text || '',
      summary: noteData.summary || '',
      keywords: noteData.keywords || [],
      homework: noteData.homework || [],
      structured: noteData.structured || null,
      course_name: noteData.course_name || '',
    };

    const { data, error } = await db.from('pran_not_live_transfers').insert({
      code: rawCode.replace('-', '').trim(),
      sender_id: user.id,
      sender_name: profile?.full_name || 'Kanmarad',
      note_id: noteData.id || null,
      note_title: title,
      note_payload: payload,
      status: 'pending',
    }).select().single();

    if (error) throw error;
    transferRow = data;

    // Koute chanjman sou transfè a (Realtime oswa polling dou)
    pollInterval = setInterval(async () => {
      if (!transferRow?.id) return;
      const { data: updated } = await db
        .from('pran_not_live_transfers')
        .select('status, claimed_at')
        .eq('id', transferRow.id)
        .maybeSingle();

      if (updated && updated.status === 'claimed') {
        clearInterval(pollInterval);
        pollInterval = null;
        playNotificationSound('success', { force: true });
        const box = m.el.querySelector('#transfer-status-box');
        if (box) {
          box.className = 'alert alert-success';
          box.innerHTML = `${icon('check-circle')} <strong>Transfè a reyisi !</strong> Kanmarad la resevwa nòt la sou kont li.`;
          icons(box);
        }
      }
    }, 2500);

  } catch (err) {
    handleError(err);
  }

  // Netwayaj le modal la fèmen
  const origClose = m.close;
  m.close = () => {
    if (pollInterval) clearInterval(pollInterval);
    origClose();
  };
}

/**
 * Ouvri modal pou resevwa yon nòt avèk yon kòd transfè
 */
export async function openReceiveTransferModal(onReceivedCallback) {
  const { user } = await requireAuth();

  const m = openModal({
    title: t('transfer.receive_title') || 'Resevwa yon nòt an dirèk',
    body: `
      <form id="receive-transfer-form" class="stack py-2">
        <p class="text-sm muted mb-2">
          Mete kòd 6 chif kanmarad ou a ba ou pou telechaje nòt la dirèkteman sou kont ou :
        </p>
        <div class="field mb-3">
          <label for="receive-code-input">Kòd Transfè (6 chif)</label>
          <input class="input text-center font-bold" id="receive-code-input" type="text"
            placeholder="Ex: 742198" maxlength="8" style="font-size:1.5rem;letter-spacing:4px;" required autocomplete="off">
        </div>
        <div id="receive-feedback" class="stack-sm mb-3"></div>
        <button type="submit" class="btn btn-primary btn-block" id="receive-submit-btn">
          ${icon('download')}<span>Resevwa nòt la</span>
        </button>
      </form>
    `,
  });

  icons(m.el);
  const input = m.el.querySelector('#receive-code-input');
  const btn = m.el.querySelector('#receive-submit-btn');
  const form = m.el.querySelector('#receive-transfer-form');
  const feedback = m.el.querySelector('#receive-feedback');

  if (input) setTimeout(() => input.focus(), 150);

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cleanCode = (input?.value || '').replace(/\D/g, '').trim();
    if (cleanCode.length !== 6) {
      toast('Kòd la dwe gen 6 chif', 'warning');
      return;
    }

    setLoading(btn, true);
    feedback.innerHTML = '';

    try {
      const { data: transfer, error } = await db
        .from('pran_not_live_transfers')
        .select('*')
        .eq('code', cleanCode)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (error) throw error;
      if (!transfer) {
        toast('Kòd sa a pa valab oswa li ekspire', 'error');
        setLoading(btn, false);
        return;
      }

      const p = transfer.note_payload || {};
      const noteTitle = p.title || transfer.note_title || 'Nòt pataje';

      // Kreye nòt la nan kont etidyan k ap resevwa a
      const { data: newNote, error: insertErr } = await db
        .from('pran_not_notes')
        .insert({
          user_id: user.id,
          title: `${noteTitle} (Transfè)`,
          content_html: p.content_html || '',
          content_text: p.content_text || '',
          summary: p.summary || '',
          structured: p.structured || null,
          status: 'ready',
          capture_mode: 'text',
        })
        .select()
        .single();

      if (insertErr) throw insertErr;

      // Make transfè a kòm reklame
      await db
        .from('pran_not_live_transfers')
        .update({
          status: 'claimed',
          claimed_by: user.id,
          claimed_at: new Date().toISOString(),
        })
        .eq('id', transfer.id);

      // Si gen devwa ki te nan nòt la, ajoute yo si posib
      if (Array.isArray(p.homework) && p.homework.length) {
        for (const hw of p.homework) {
          try {
            await db.from('pran_not_assignments').insert({
              user_id: user.id,
              title: hw.title,
              description: hw.description || '',
              due_at: hw.due ? new Date(hw.due).toISOString() : null,
              status: 'todo',
            });
          } catch { /* ignore */ }
        }
      }

      playNotificationSound('success', { force: true });
      toast('Ou resevwa nòt la ak siksè !', 'success');

      feedback.innerHTML = `
        <div class="alert alert-success">
          ${icon('check-circle')}
          <div>
            <strong>Nòt anrejistre !</strong>
            <div class="text-xs mt-1">"${esc(noteTitle)}" pare nan koleksyon nòt ou yo.</div>
          </div>
        </div>
      `;
      icons(feedback);

      setTimeout(() => {
        m.close();
        if (typeof onReceivedCallback === 'function') {
          onReceivedCallback(newNote);
        } else {
          location.href = appUrl(`pages/note-view.html?id=${newNote.id}`);
        }
      }, 900);

    } catch (err) {
      handleError(err);
      setLoading(btn, false);
    }
  });
}

/**
 * Ouvri modal Revizyon Egzamen pa peryòd dat (de tel date a tel date)
 */
export async function openExamRevisionModal({ courseId = '', courses = [] } = {}) {
  const { user } = await requireAuth();

  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const m = openModal({
    title: 'Revizyon Egzamen pa Peryòd Dat',
    body: `
      <div class="stack py-2">
        <p class="text-sm muted mb-3">
          Chwazi yon peryòd (egzanp: depi kòmansman sesyon an rive jodi a) pou w wè tout nòt, devwa ak konsèp kle pou prepare egzamen ou :
        </p>

        <div class="form-row">
          <div class="field">
            <label for="exam-start-date">Dat Kòmansman</label>
            <input class="input" id="exam-start-date" type="date" value="${thirtyDaysAgo}">
          </div>
          <div class="field">
            <label for="exam-end-date">Dat Fin</label>
            <input class="input" id="exam-end-date" type="date" value="${today}">
          </div>
        </div>

        <div class="field mb-3">
          <label for="exam-course-filter">Kou (opsyonèl)</label>
          <select class="select" id="exam-course-filter">
            <option value="">Tout kou yo</option>
            ${courses.map((c) => `<option value="${esc(c.id)}" ${c.id === courseId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </div>

        <button type="button" class="btn btn-primary" id="exam-load-btn">
          ${icon('search')}<span>Chèche Nòt Peryòd Sa A</span>
        </button>

        <div id="exam-results-box" class="stack mt-4">
          <p class="text-xs muted text-center">Klike sou bouton an pou chaje nòt yo.</p>
        </div>
      </div>
    `,
  });

  icons(m.el);

  const startInput = m.el.querySelector('#exam-start-date');
  const endInput = m.el.querySelector('#exam-end-date');
  const courseSel = m.el.querySelector('#exam-course-filter');
  const loadBtn = m.el.querySelector('#exam-load-btn');
  const resultsBox = m.el.querySelector('#exam-results-box');

  const runQuery = async () => {
    setLoading(loadBtn, true);
    resultsBox.innerHTML = '<p class="text-center text-sm muted py-4">Nap chaje nòt yo...</p>';

    try {
      const sDate = startInput.value || thirtyDaysAgo;
      const eDate = endInput.value || today;
      const cId = courseSel.value;

      let q = db
        .from('pran_not_notes')
        .select('id, title, summary, course_id, created_at, live_duration_seconds, structured')
        .eq('user_id', user.id)
        .gte('created_at', `${sDate}T00:00:00.000Z`)
        .lte('created_at', `${eDate}T23:59:59.999Z`)
        .order('created_at', { ascending: false });

      if (cId) q = q.eq('course_id', cId);

      const { data: notes, error } = await q;
      if (error) throw error;

      if (!notes || !notes.length) {
        resultsBox.innerHTML = `
          <div class="alert alert-info text-center py-4">
            Pa gen okenn nòt ki anrejistre ant ${formatDate(sDate)} ak ${formatDate(eDate)}.
          </div>
        `;
        setLoading(loadBtn, false);
        return;
      }

      // Estatistik peryòd
      const totalNotes = notes.length;
      const allKeywords = new Set();
      let totalLiveSec = 0;

      notes.forEach((n) => {
        totalLiveSec += (n.live_duration_seconds || 0);
        const kws = n.structured?.keywords;
        if (Array.isArray(kws)) kws.forEach((k) => allKeywords.add(k));
      });

      resultsBox.innerHTML = `
        <div class="row-between card card-accent card-sm mb-3">
          <div>
            <div class="text-xs muted">Total Nòt</div>
            <div class="text-lg font-bold">${totalNotes} nòt</div>
          </div>
          <div>
            <div class="text-xs muted">Tan an Dirèk</div>
            <div class="text-lg font-bold">${Math.round(totalLiveSec / 60)} min</div>
          </div>
          <div>
            <div class="text-xs muted">Konsèp Kle</div>
            <div class="text-lg font-bold">${allKeywords.size}</div>
          </div>
        </div>

        <h4 class="card-title text-sm mb-2">Lis Nòt Peryòd la (${formatDate(sDate)} - ${formatDate(eDate)})</h4>
        <ul class="list stack-sm">
          ${notes.map((n) => `
            <li class="list-item">
              <span class="icon-chip sm accent">${icon('book-open')}</span>
              <div class="flex-1">
                <div class="list-item-title font-bold">${esc(n.title)}</div>
                ${n.summary ? `<div class="text-xs muted line-clamp-2">${esc(n.summary)}</div>` : ''}
                <div class="text-xs muted mt-1">${formatDate(n.created_at)}</div>
              </div>
              <a class="btn btn-sm btn-secondary" href="${esc(appUrl(`pages/note-view.html?id=${n.id}`))}">
                ${esc(t('common.open'))}
              </a>
            </li>
          `).join('')}
        </ul>
      `;
      icons(resultsBox);

    } catch (err) {
      handleError(err);
    } finally {
      setLoading(loadBtn, false);
    }
  };

  loadBtn?.addEventListener('click', runQuery);
  setTimeout(runQuery, 50);
}
