/* =====================================================================
   PRAN NÒT - pages/tutor.js
   Espace Tuteur IA pleine page avec historique filtrable par cours.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, appUrl } from '../auth.js';
import { initAppChrome } from '../navbar.js';
import { t, getLang, formatRelative } from '../i18n.js';
import { icons, icon, esc, renderMarkdown, toast, handleError, pageEnter } from '../utils.js';
import { askTutor } from '../ai.js';

const db = window.db;
let profileRef = null;
let conversations = [];
let activeConvId = null;
let messages = [];

function needsVerify() {
  return ['medecine', 'sciences_infirmieres', 'pharmacie', 'odontologie', 'droit'].includes(profileRef?.faculty_id);
}

function renderConvs() {
  const courseFilter = document.getElementById('tutor-course-sel').value;
  const list = document.getElementById('conv-list');
  const rows = conversations.filter((c) => !courseFilter || c.course_id === courseFilter);
  if (!rows.length) {
    list.innerHTML = `<li class="list-item text-xs muted">${esc(t('common.none'))}</li>`;
    return;
  }
  list.innerHTML = rows.map((c) => `
    <li class="list-item" style="padding:8px 0;">
      <button type="button" class="btn btn-ghost btn-sm btn-block" data-conv="${esc(c.id)}" style="justify-content:flex-start;text-align:left;${c.id === activeConvId ? 'background:var(--c-accent-soft);color:var(--c-accent-text);' : ''}">
        <span class="truncate flex-1">${esc(c.title)}</span>
        <span class="text-xs muted">${esc(formatRelative(c.updated_at))}</span>
      </button>
    </li>`).join('');
  list.querySelectorAll('[data-conv]').forEach((b) => {
    b.addEventListener('click', () => loadConversation(b.dataset.conv));
  });
}

function renderMessages() {
  const box = document.getElementById('full-tutor-msgs');
  if (!messages.length) {
    box.innerHTML = `<div class="msg msg-assistant">
      <p>${esc(t('tutor.welcome'))}</p>
      ${needsVerify() ? `<div class="alert alert-warning text-xs mt-2">${icon('alert-triangle')}<span>${esc(t('tutor.verify_warning'))}</span></div>` : ''}
    </div>`;
    icons(box);
    return;
  }

  box.innerHTML = messages.map((m) => {
    const cites = m.role === 'assistant' && Array.isArray(m.citations)
      ? m.citations.filter((c, idx, arr) => c.book_id && arr.findIndex((x) => x.book_id === c.book_id) === idx).slice(0, 4)
      : [];
    const citesHtml = cites.length
      ? `<div class="row-wrap mt-2">${cites.map((c) =>
          `<a class="badge badge-outline" href="${appUrl(`pages/library.html?book=${encodeURIComponent(c.book_id)}`)}">${esc(c.book_title)}${c.section_label ? ` · ${esc(c.section_label)}` : ''}</a>`
        ).join('')}</div>`
      : '';
    return `
    <div class="msg ${m.role === 'user' ? 'msg-user' : 'msg-assistant'}">
      ${m.role === 'user' ? esc(m.content) : renderMarkdown(m.content) + citesHtml}
    </div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

async function loadConversation(id) {
  activeConvId = id;
  const conv = conversations.find((c) => c.id === id);
  document.getElementById('active-conv-title').textContent = conv?.title || t('tutor.context_general');
  const { data } = await db.from('pran_not_tutor_messages').select('role, content, mode').eq('conversation_id', id).order('created_at');
  messages = data || [];
  renderConvs();
  renderMessages();
}

async function sendMsg(text, mode = 'standard') {
  const box = document.getElementById('full-tutor-msgs');
  const courseId = document.getElementById('tutor-course-sel').value || null;

  if (!messages.length) box.innerHTML = '';
  messages.push({ role: 'user', content: text });
  renderMessages();

  const typing = document.createElement('div');
  typing.className = 'msg msg-assistant';
  typing.innerHTML = '<div class="msg-typing"><span></span><span></span><span></span></div>';
  box.appendChild(typing);
  box.scrollTop = box.scrollHeight;

  try {
    const res = await askTutor({
      conversationId: activeConvId,
      message: text,
      mode,
      contextType: courseId ? 'course' : 'general',
      courseId,
      faculty: profileRef?.faculty_id || 'autre',
      level: profileRef?.level || 'L1',
      language: getLang(),
      history: messages.slice(-8),
    });
    if (res?.conversationId && !activeConvId) {
      activeConvId = res.conversationId;
      conversations.unshift({ id: activeConvId, title: text.slice(0, 70), course_id: courseId, updated_at: new Date().toISOString() });
      renderConvs();
    }
    messages.push({ role: 'assistant', content: res.reply || '', citations: res.libraryCitations || [] });
    renderMessages();
  } catch (err) {
    typing.remove();
    toast(handleError(err), 'error');
  }
}

(async () => {
  const { user, profile } = await requireAuth();
  profileRef = profile;

  await initAppChrome({ profile, user, active: 'tutor', showTutor: false });
  pageEnter();

  const [cRes, convRes] = await Promise.all([
    db.from('pran_not_courses').select('id, name').eq('archived', false).order('name'),
    db.from('pran_not_tutor_conversations').select('*').order('updated_at', { ascending: false }).limit(30),
  ]);

  const cSel = document.getElementById('tutor-course-sel');
  (cRes.data || []).forEach((c) => cSel.insertAdjacentHTML('beforeend', `<option value="${esc(c.id)}">${esc(c.name)}</option>`));
  conversations = convRes.data || [];
  renderConvs();
  renderMessages();

  cSel.addEventListener('change', renderConvs);
  document.getElementById('new-conv-btn').addEventListener('click', () => {
    activeConvId = null;
    messages = [];
    document.getElementById('active-conv-title').textContent = t('tutor.context_general');
    renderConvs();
    renderMessages();
  });

  document.querySelectorAll('#full-tutor-modes .chip').forEach((ch) => {
    ch.addEventListener('click', () => {
      const m = ch.dataset.mode;
      const map = {
        simple: t('tutor.quick_simple'),
        child: t('tutor.quick_child'),
        haiti: t('tutor.quick_haiti'),
        compare: t('tutor.quick_compare'),
        mnemonic: t('tutor.quick_mnemonic'),
        quiz: t('tutor.quick_quiz'),
      };
      sendMsg(map[m] || t('tutor.quick_simple'), m);
    });
  });

  const form = document.getElementById('full-tutor-form');
  const input = document.getElementById('full-tutor-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const txt = input.value.trim();
    if (!txt) return;
    input.value = '';
    sendMsg(txt, 'standard');
  });
})();
