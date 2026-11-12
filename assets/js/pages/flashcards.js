/* =====================================================================
   PRAN NÒT - pages/flashcards.js
   Gestion des paquets et flashcards : ajout manuel, édition, fusion de doublons,
   tags, génération par IA et partage en groupe.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, appUrl } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, getLang } from '../i18n.js';
import {
  icons, icon, esc, emptyState, openModal, confirmDialog, toast, handleError,
  setLoading, getParam, isUuid, animateIn, pageEnter,
} from '../utils.js';
import { generateFlashcards } from '../ai.js';

const db = window.db;
let userRef = null;
let profileRef = null;
let courses = [];
let decks = [];
let activeDeck = null;
let deckCards = [];

function renderDecks() {
  document.getElementById('deck-detail-view').hidden = true;
  const view = document.getElementById('decks-view');
  view.hidden = false;

  if (!decks.length) {
    view.className = '';
    view.innerHTML = emptyState({
      icon: 'layers',
      title: t('flashcards.empty_title'),
      text: t('flashcards.empty_text'),
      action: `<button type="button" class="btn btn-primary" id="empty-deck-btn">${icon('plus')}<span>${esc(t('flashcards.new_deck'))}</span></button>`,
    });
    view.querySelector('#empty-deck-btn')?.addEventListener('click', openDeckModal);
    icons(view);
    return;
  }

  view.className = 'grid grid-3';
  view.innerHTML = decks.map((d) => {
    const c = courses.find((x) => x.id === d.course_id);
    return `<article class="card">
      <div class="card-head">
        <div>
          <h2 class="card-title">${esc(d.title)}</h2>
          <div class="card-meta">${c ? esc(c.name) : esc(t('common.no_course'))}</div>
        </div>
        <button type="button" class="btn-icon" data-del-deck="${esc(d.id)}" aria-label="${esc(t('common.delete'))}">${icon('trash-2')}</button>
      </div>
      ${d.description ? `<p class="text-sm muted line-clamp-2">${esc(d.description)}</p>` : ''}
      <div class="row-wrap mt-4">
        <button type="button" class="btn btn-sm btn-primary" data-open-deck="${esc(d.id)}">${esc(t('common.open'))}</button>
        <a class="btn btn-sm btn-secondary" href="./review.html?deck=${esc(d.id)}">${esc(t('nav.review'))}</a>
      </div>
    </article>`;
  }).join('');

  view.querySelectorAll('[data-open-deck]').forEach((b) => {
    b.addEventListener('click', () => openDeck(b.dataset.openDeck));
  });
  view.querySelectorAll('[data-del-deck]').forEach((b) => {
    b.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: t('common.delete'), message: t('common.confirm_title'), danger: true });
      if (!ok) return;
      const { error } = await db.from('pran_not_flashcard_decks').delete().eq('id', b.dataset.delDeck);
      if (error) handleError(error);
      else {
        decks = decks.filter((x) => x.id !== b.dataset.delDeck);
        renderDecks();
      }
    });
  });

  icons(view);
  animateIn('#decks-view article');
}

async function openDeck(deckId) {
  const { data: d } = await db.from('pran_not_flashcard_decks').select('*').eq('id', deckId).maybeSingle();
  if (!d) return;
  activeDeck = d;
  const { data: cards } = await db.from('pran_not_flashcards').select('*').eq('deck_id', deckId).order('created_at', { ascending: false });
  deckCards = cards || [];
  renderDeckDetail();
}

function renderDeckDetail() {
  document.getElementById('decks-view').hidden = true;
  const box = document.getElementById('deck-detail-view');
  box.hidden = false;

  box.innerHTML = `
    <div class="row-between mb-6" style="flex-wrap:wrap;gap:12px;">
      <div class="row">
        <button type="button" class="btn btn-secondary btn-sm" id="back-decks-btn">${icon('arrow-left')}<span>${esc(t('common.back'))}</span></button>
        <h2 class="mb-0">${esc(activeDeck.title)} (${deckCards.length})</h2>
      </div>
      <div class="row-wrap">
        <button type="button" class="btn btn-sm btn-secondary" id="dedupe-btn">${icon('git-merge')}<span>${esc(t('flashcards.dedupe'))}</span></button>
        <button type="button" class="btn btn-sm btn-secondary" id="ai-cards-btn">${icon('sparkles')}<span>${esc(t('flashcards.generate_ai'))}</span></button>
        <button type="button" class="btn btn-sm btn-primary" id="add-card-btn">${icon('plus')}<span>${esc(t('flashcards.new_card'))}</span></button>
        <a class="btn btn-sm btn-dark" href="./review.html?deck=${esc(activeDeck.id)}">${icon('play')}<span>${esc(t('nav.review'))}</span></a>
      </div>
    </div>

    <div class="grid grid-2" id="cards-list">
      ${deckCards.length ? deckCards.map((c) => `
        <article class="card card-sm">
          <div class="row-between mb-2">
            <span class="badge">${esc(t(`flashcards.types.${c.type}`) || c.type)}</span>
            <div class="row" style="gap:4px;">
              <button type="button" class="btn-icon" data-edit-card="${esc(c.id)}" aria-label="${esc(t('common.edit'))}">${icon('edit-3')}</button>
              <button type="button" class="btn-icon" data-del-card="${esc(c.id)}" aria-label="${esc(t('common.delete'))}">${icon('trash-2')}</button>
            </div>
          </div>
          <strong class="text-sm">${esc(c.front)}</strong>
          <p class="text-sm muted mt-2 mb-2">${esc(c.back)}</p>
          ${c.tags?.length ? `<div class="row-wrap">${c.tags.map((tg) => `<span class="badge">${esc(tg)}</span>`).join('')}</div>` : ''}
        </article>`).join('') : `<p class="muted">${esc(t('common.none'))}</p>`}
    </div>`;

  icons(box);
  document.getElementById('back-decks-btn').addEventListener('click', renderDecks);
  document.getElementById('add-card-btn').addEventListener('click', () => openCardModal());
  document.getElementById('ai-cards-btn').addEventListener('click', openAiGenerateModal);
  document.getElementById('dedupe-btn').addEventListener('click', dedupeCards);

  box.querySelectorAll('[data-edit-card]').forEach((b) => {
    b.addEventListener('click', () => {
      const card = deckCards.find((x) => x.id === b.dataset.editCard);
      if (card) openCardModal(card);
    });
  });
  box.querySelectorAll('[data-del-card]').forEach((b) => {
    b.addEventListener('click', async () => {
      const { error } = await db.from('pran_not_flashcards').delete().eq('id', b.dataset.delCard);
      if (error) handleError(error);
      else {
        deckCards = deckCards.filter((x) => x.id !== b.dataset.delCard);
        renderDeckDetail();
      }
    });
  });
}

function openDeckModal() {
  const m = openModal({
    title: t('flashcards.new_deck'),
    body: `
      <div class="field"><label>Tit pake a</label><input class="input" id="dk-title" required placeholder="Ex : Kadyoloji - Chapit 1"></div>
      <div class="field"><label>${esc(t('nav.courses'))}</label>
        <select class="select" id="dk-course"><option value="">${esc(t('common.no_course'))}</option>
          ${courses.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Deskripsyon</label><input class="input" id="dk-desc"></div>`,
    footer: `<button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
             <button type="button" class="btn btn-primary" id="dk-save">${esc(t('common.save'))}</button>`,
  });
  m.el.querySelector('#dk-save').addEventListener('click', async () => {
    const title = m.el.querySelector('#dk-title').value.trim();
    if (!title) return;
    const { data, error } = await db.from('pran_not_flashcard_decks').insert({
      user_id: userRef.id,
      course_id: m.el.querySelector('#dk-course').value || null,
      title,
      description: m.el.querySelector('#dk-desc').value.trim() || null,
    }).select().single();
    if (error) { handleError(error); return; }
    decks.unshift(data);
    m.close();
    renderDecks();
  });
}

function openCardModal(existing = null) {
  const types = ['qa', 'definition', 'cloze', 'true_false', 'formula', 'case'];
  const m = openModal({
    title: existing ? t('common.edit') : t('flashcards.new_card'),
    body: `
      <div class="field"><label>${esc(t('flashcards.type'))}</label>
        <select class="select" id="fc-type">${types.map((tp) => `<option value="${tp}" ${existing?.type === tp ? 'selected' : ''}>${esc(t(`flashcards.types.${tp}`))}</option>`).join('')}</select>
      </div>
      <div class="field"><label>${esc(t('flashcards.front'))}</label>
        <textarea class="textarea" id="fc-front" rows="3">${esc(existing?.front || '')}</textarea>
      </div>
      <div class="field"><label>${esc(t('flashcards.back'))}</label>
        <textarea class="textarea" id="fc-back" rows="3">${esc(existing?.back || '')}</textarea>
      </div>
      <div class="field"><label>Tags (separe ak vigil)</label>
        <input class="input" id="fc-tags" value="${esc((existing?.tags || []).join(', '))}">
      </div>`,
    footer: `<button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
             <button type="button" class="btn btn-primary" id="fc-save">${esc(t('common.save'))}</button>`,
  });
  m.el.querySelector('#fc-save').addEventListener('click', async () => {
    const front = m.el.querySelector('#fc-front').value.trim();
    const back = m.el.querySelector('#fc-back').value.trim();
    if (!front || !back) { toast(t('errors.required'), 'warning'); return; }
    const tags = m.el.querySelector('#fc-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
    const payload = {
      user_id: userRef.id,
      deck_id: activeDeck.id,
      course_id: activeDeck.course_id,
      type: m.el.querySelector('#fc-type').value,
      front,
      back,
      tags,
    };
    const { data, error } = existing
      ? await db.from('pran_not_flashcards').update(payload).eq('id', existing.id).select().single()
      : await db.from('pran_not_flashcards').insert(payload).select().single();
    if (error) { handleError(error); return; }
    if (existing) deckCards = deckCards.map((x) => (x.id === existing.id ? data : x));
    else deckCards.unshift(data);
    m.close();
    renderDeckDetail();
  });
}

function openAiGenerateModal() {
  const m = openModal({
    title: t('flashcards.generate_ai'),
    body: `<div class="field"><label>Kontni oswa sijè pou kreye kat</label>
      <textarea class="textarea" id="ai-fc-src" rows="6" placeholder="Kole tèks kou a oswa ekri tèm yo..."></textarea></div>`,
    footer: `<button type="button" class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
             <button type="button" class="btn btn-primary" id="ai-fc-go">${esc(t('flashcards.generate_ai'))}</button>`,
  });
  const btn = m.el.querySelector('#ai-fc-go');
  btn.addEventListener('click', async () => {
    const content = m.el.querySelector('#ai-fc-src').value.trim();
    if (!content) return;
    setLoading(btn, true);
    try {
      await generateFlashcards({
        content,
        title: activeDeck.title,
        language: getLang(),
        faculty: profileRef?.faculty_id,
        level: profileRef?.level,
        count: 8,
        courseId: activeDeck.course_id,
        deckId: activeDeck.id,
      });
      m.close();
      await openDeck(activeDeck.id);
      toast(t('common.saved'), 'success');
    } catch (err) {
      handleError(err);
      setLoading(btn, false);
    }
  });
}

async function dedupeCards() {
  const seen = new Set();
  const dupIds = [];
  for (const c of deckCards) {
    const key = c.front.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) dupIds.push(c.id);
    else seen.add(key);
  }
  if (!dupIds.length) {
    toast('Okenn doublon pa jwenn nan pake sa a.', 'info');
    return;
  }
  const { error } = await db.from('pran_not_flashcards').delete().in('id', dupIds);
  if (error) handleError(error);
  else {
    deckCards = deckCards.filter((c) => !dupIds.includes(c.id));
    toast(`${dupIds.length} doublon efase.`, 'success');
    renderDeckDetail();
  }
}

(async () => {
  const { user, profile } = await requireAuth();
  userRef = user;
  profileRef = profile;

  await initAppChrome({ profile, user, active: 'review' });
  setTutorContext({ contextType: 'general', contextTitle: t('flashcards.title') });
  pageEnter();

  const [cRes, dRes] = await Promise.all([
    db.from('pran_not_courses').select('id, name').eq('archived', false).order('name'),
    db.from('pran_not_flashcard_decks').select('*').order('created_at', { ascending: false }),
  ]);
  courses = cRes.data || [];
  decks = dRes.data || [];

  const deckParam = getParam('deck');
  if (isUuid(deckParam)) await openDeck(deckParam);
  else renderDecks();

  document.getElementById('new-deck-btn').addEventListener('click', openDeckModal);
})();
