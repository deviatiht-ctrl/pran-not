/* =====================================================================
   PRAN NÒT - pages/review.js
   Séance de révision SM-2 plein écran avec retournement GSAP,
   gestes de balayage mobile, raccourcis clavier et file hors-ligne.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, recordActivity, awardXp } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, getLang } from '../i18n.js';
import {
  icons, icon, esc, emptyState, handleError, prefersReducedMotion, pageEnter, getParam, uid, toast,
} from '../utils.js';
import { sm2, previewIntervals, formatCloze } from '../srs.js';
import { enqueue, cacheSet, cacheGet } from '../offline.js';

const db = window.db;
let queue = [];
let index = 0;
let reviewedCount = 0;
let flipped = false;
let cardShownAt = Date.now();
let userRef = null;

function renderCurrent() {
  const root = document.getElementById('review-root');

  if (!queue.length) {
    root.innerHTML = emptyState({
      icon: 'check-circle-2',
      title: t('review.all_caught_up_title'),
      text: t('review.all_caught_up_text'),
      action: `<a class="btn btn-primary" href="./flashcards.html">${icon('layers')}<span>${esc(t('flashcards.title'))}</span></a>
               <a class="btn btn-secondary" href="./tests.html">${icon('check-circle-2')}<span>${esc(t('nav.tests'))}</span></a>`,
    });
    icons(root);
    return;
  }

  if (index >= queue.length) {
    root.innerHTML = `
      <div class="card">
        <span class="icon-chip success mb-4">${icon('check-circle-2')}</span>
        <h2>${esc(t('review.done_title'))}</h2>
        <p class="muted">${esc(t('review.done_summary', { count: reviewedCount }))}</p>
        <div class="row-wrap mt-4">
          <a class="btn btn-primary" href="./dashboard.html">${esc(t('nav.home'))}</a>
          <a class="btn btn-secondary" href="./tests.html">${esc(t('nav.tests'))}</a>
        </div>
      </div>`;
    icons(root);
    return;
  }

  const card = queue[index];
  flipped = false;
  cardShownAt = Date.now();

  setTutorContext({
    contextType: 'card',
    contextId: card.id,
    contextTitle: card.front.slice(0, 60),
    contextText: `Kesyon: ${card.front}\nRepons: ${card.back}`,
    courseId: card.course_id,
  });

  const frontHtml = card.type === 'cloze' ? formatCloze(card.front, false) : esc(card.front);
  const backHtml = card.type === 'cloze'
    ? `${formatCloze(card.front, true)}<hr class="mt-4 mb-4"><div>${esc(card.back)}</div>`
    : esc(card.back);
  const previews = previewIntervals(card, getLang());
  const pct = Math.round(((index) / queue.length) * 100);

  root.innerHTML = `
    <div class="row-between text-xs muted mb-2">
      <span>${index + 1} / ${queue.length}</span>
      <span>${esc(t(`flashcards.types.${card.type}`) || card.type)}</span>
    </div>
    <div class="progress progress-sm mb-6"><span style="width:${pct}%"></span></div>

    <div class="flip-scene mb-6">
      <div class="flip-card" id="flip-card" tabindex="0" role="button" aria-label="${esc(t('review.flip'))}">
        <div class="flip-face flip-front">
          <span class="badge card-type">${esc(t(`flashcards.types.${card.type}`) || card.type)}</span>
          <div class="flip-text">${frontHtml}</div>
          <span class="text-xs muted mt-4">Tape oswa peze Espas pou retounen</span>
        </div>
        <div class="flip-face flip-back">
          <span class="badge badge-accent card-type">Repons</span>
          <div class="flip-text" style="font-size:1.15rem;font-family:var(--font-body);font-weight:500;">${backHtml}</div>
        </div>
      </div>
    </div>

    <div id="flip-prompt">
      <button type="button" class="btn btn-dark btn-block btn-lg" id="flip-btn">${esc(t('review.flip'))}</button>
    </div>

    <div class="rate-bar" id="rate-bar" hidden>
      ${[0, 1, 2, 3].map((r) => `
        <button type="button" class="rate-btn" data-rating="${r}">
          <span>${esc(t(`review.rate_${r}`))}</span>
          <small>${esc(previews[r])}</small>
        </button>`).join('')}
    </div>`;

  const cardEl = document.getElementById('flip-card');
  const flipBtn = document.getElementById('flip-btn');
  const flipPrompt = document.getElementById('flip-prompt');
  const rateBar = document.getElementById('rate-bar');

  const doFlip = () => {
    if (flipped) return;
    flipped = true;
    if (window.gsap && !prefersReducedMotion()) {
      window.gsap.to(cardEl, { rotateY: 180, duration: 0.45, ease: 'power2.out' });
    } else {
      cardEl.style.transform = 'rotateY(180deg)';
    }
    flipPrompt.hidden = true;
    rateBar.hidden = false;
  };

  cardEl.addEventListener('click', doFlip);
  flipBtn.addEventListener('click', doFlip);
  cardEl.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); doFlip(); }
  });

  // Gestes tactiles de balayage mobile (gauche = À revoir, droite = Bien)
  let startX = 0;
  cardEl.addEventListener('pointerdown', (e) => { startX = e.clientX; });
  cardEl.addEventListener('pointerup', (e) => {
    const dx = e.clientX - startX;
    if (flipped && Math.abs(dx) > 75) {
      submitRating(dx > 0 ? 2 : 0);
    }
  });

  rateBar.querySelectorAll('[data-rating]').forEach((btn) => {
    btn.addEventListener('click', () => submitRating(Number(btn.dataset.rating)));
  });

  icons(root);
}

async function submitRating(rating) {
  const card = queue[index];
  if (!card) return;
  const durationMs = Math.min(120000, Date.now() - cardShownAt);
  const nextState = sm2(card, rating);

  // Si "À revoir" (0), re-proposer plus tard dans la séance en plus de la planification
  if (rating === 0) {
    queue.push({ ...card, ...nextState });
  }

  reviewedCount++;
  index++;
  renderCurrent();

  const clientId = uid();
  if (!navigator.onLine) {
    await enqueue('review', {
      cardId: card.id,
      srsPatch: nextState,
      rating,
      prevInterval: card.interval_days || 0,
      durationMs,
      clientId,
    });
    return;
  }

  try {
    await db.from('pran_not_flashcards').update(nextState).eq('id', card.id);
    await db.from('pran_not_card_reviews').insert({
      user_id: userRef.id,
      card_id: card.id,
      rating,
      prev_interval: card.interval_days || 0,
      new_interval: nextState.interval_days,
      new_ease: nextState.ease,
      duration_ms: durationMs,
      client_id: clientId,
    });
    if (reviewedCount === 1) await recordActivity();
    if (reviewedCount % 5 === 0) await awardXp(10, 'flashcard_review');
  } catch (err) {
    await enqueue('review', {
      cardId: card.id, srsPatch: nextState, rating, prevInterval: card.interval_days || 0, durationMs, clientId,
    });
    toast(t('offline.saved_locally'), 'info');
  }
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (!flipped && e.code === 'Space') {
    e.preventDefault();
    document.getElementById('flip-btn')?.click();
  } else if (flipped && ['1', '2', '3', '4'].includes(e.key)) {
    submitRating(Number(e.key) - 1);
  }
});

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;

  const deckParam = getParam('deck');
  const courseParam = getParam('course');

  try {
    let q = db.from('pran_not_flashcards').select('*').eq('suspended', false).lte('due_at', new Date().toISOString()).order('due_at').limit(40);
    if (deckParam) q = q.eq('deck_id', deckParam);
    if (courseParam) q = q.eq('course_id', courseParam);
    const { data, error } = await q;
    if (error) throw error;
    queue = data || [];
    await cacheSet('due_cards', queue);
  } catch (err) {
    queue = (await cacheGet('due_cards')) || [];
    if (!queue.length) handleError(err);
  }

  await initAppChrome({ profile, user, active: 'review', dueCount: queue.length });
  pageEnter();
  renderCurrent();
})();
