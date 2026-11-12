/* =====================================================================
   PRAN NÒT - pages/onboarding.js
   Onboarding en 3 étapes : identité, faculté + niveau, préférences.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, updateProfile, appUrl } from '../auth.js';
import { t, getLang, setLang } from '../i18n.js';
import { ensureFooter } from '../navbar.js';
import { icons, icon, esc, toast, setLoading, pageEnter, normalizeWhatsAppPhone } from '../utils.js';

const db = window.db;
let step = 1;
const TOTAL = 3;

const DEFAULT_FACULTIES = [
  { id: 'medecine', name_fr: 'Médecine', name_ht: 'Medsin', icon: 'stethoscope' },
  { id: 'droit', name_fr: 'Droit', name_ht: 'Dwa', icon: 'scale' },
  { id: 'sciences_eco', name_fr: 'Sciences Économiques', name_ht: 'Syans Ekonomik', icon: 'trending-up' },
  { id: 'sciences_info', name_fr: 'Sciences Informatiques', name_ht: 'Syans Enfòmatik', icon: 'cpu' },
  { id: 'genie', name_fr: 'Génie', name_ht: 'Jeni', icon: 'compass' },
  { id: 'agronomie', name_fr: 'Agronomie', name_ht: 'Agwonomi', icon: 'sprout' },
  { id: 'lettres', name_fr: 'Lettres', name_ht: 'Lèt ak Syans Imèn', icon: 'book-open' },
  { id: 'education', name_fr: 'Sciences de l’Éducation', name_ht: 'Syans Edikasyon', icon: 'graduation-cap' },
  { id: 'sciences_infirmieres', name_fr: 'Sciences Infirmières', name_ht: 'Syans Enfimyè', icon: 'heart-pulse' },
  { id: 'pharmacie', name_fr: 'Pharmacie', name_ht: 'Famasi', icon: 'pill' },
  { id: 'odontologie', name_fr: 'Odontologie', name_ht: 'Odontoloji', icon: 'shield-plus' },
  { id: 'autre', name_fr: 'Autre', name_ht: 'Lòt fakilte', icon: 'layers' },
];

function renderStep() {
  document.querySelectorAll('[data-step]').forEach((sec) => {
    sec.hidden = Number(sec.dataset.step) !== step;
  });
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const finishBtn = document.getElementById('finish-btn');
  if (prevBtn) prevBtn.hidden = step === 1;
  if (nextBtn) nextBtn.hidden = step === TOTAL;
  if (finishBtn) finishBtn.hidden = step !== TOTAL;
  const pct = Math.round((step / TOTAL) * 100);
  const label = document.getElementById('step-label');
  if (label) {
    const translated = t('onboarding.step_of', { step, total: TOTAL });
    label.textContent = translated === 'onboarding.step_of' ? `${step} / ${TOTAL}` : translated;
  }
  const pctEl = document.getElementById('step-pct');
  if (pctEl) pctEl.textContent = `${pct}%`;
  const barEl = document.getElementById('step-bar');
  if (barEl) barEl.style.width = `${pct}%`;
}

(async () => {
  renderStep();

  let ready = false;
  const form = document.getElementById('onboarding-form');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const finishBtn = document.getElementById('finish-btn');
  const levelSel = document.getElementById('onb-level');

  const readyPromise = (async () => {
    const { profile } = await requireAuth({ requireOnboarded: false });
    ensureFooter();
    pageEnter();

    const langBtn = document.getElementById('onb-lang-btn');
    if (langBtn) {
      langBtn.textContent = getLang().toUpperCase();
      langBtn.addEventListener('click', async () => {
        await setLang(getLang() === 'ht' ? 'fr' : 'ht', { persistProfile: false });
        location.reload();
      });
    }

    const nameInput = document.getElementById('onb-name');
    const uniInput = document.getElementById('onb-uni');
    const waInput = document.getElementById('onb-whatsapp');
    if (profile?.full_name && nameInput && !nameInput.value.trim()) nameInput.value = profile.full_name;
    if (profile?.university && uniInput && !uniInput.value.trim()) uniInput.value = profile.university;
    if (profile?.whatsapp_phone && waInput && !waInput.value.trim()) waInput.value = profile.whatsapp_phone;
    const waToggle = document.getElementById('onb-notify-wa');
    if (waToggle && !waToggle.dataset.userTouched) {
      waToggle.checked = profile?.notify_whatsapp !== false;
    }

    // Facultés depuis DB (avec repli statique)
    let faculties = DEFAULT_FACULTIES;
    try {
      const { data } = await db.from('pran_not_faculties').select('*').order('position');
      if (data?.length) faculties = data;
    } catch { /* fallback */ }

    const lang = getLang();
    const facGrid = document.getElementById('faculty-grid');
    const selectedFac = profile?.faculty_id || 'medecine';
    if (facGrid) {
      facGrid.innerHTML = faculties.map((f) => `
        <label class="option">
          <input type="radio" name="faculty_id" value="${esc(f.id)}" ${f.id === selectedFac ? 'checked' : ''}>
          ${icon(f.icon || 'graduation-cap')}
          <span class="text-sm">${esc(lang === 'fr' ? f.name_fr : f.name_ht)}</span>
        </label>`).join('');
    }

    // Niveaux
    const levels = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'master'];
    if (levelSel) {
      levelSel.innerHTML = levels.map((lv) => `<option value="${lv}" ${profile?.level === lv ? 'selected' : ''}>${esc(t(`onboarding.levels.${lv}`))}</option>`).join('');
    }

    document.querySelectorAll('input[name="language"]').forEach((r) => {
      if (!r.dataset.userTouched) r.checked = r.value === (profile?.language || getLang());
    });

    icons();
    ready = true;
    renderStep();
    return { profile };
  })();

  document.getElementById('onb-notify-wa')?.addEventListener('change', (e) => {
    e.currentTarget.dataset.userTouched = '1';
  });
  document.querySelectorAll('input[name="language"]').forEach((r) => {
    r.addEventListener('change', () => { r.dataset.userTouched = '1'; });
  });

  prevBtn?.addEventListener('click', () => {
    if (step > 1) { step--; renderStep(); }
  });

  nextBtn?.addEventListener('click', async () => {
    if (!ready) {
      setLoading(nextBtn, true);
      try { await readyPromise; } catch { setLoading(nextBtn, false); return; }
      setLoading(nextBtn, false);
    }
    if (step === 1) {
      const name = document.getElementById('onb-name')?.value?.trim() || '';
      const uni = document.getElementById('onb-uni')?.value?.trim() || '';
      if (!name || !uni) {
        toast(t('errors.required'), 'warning');
        return;
      }
    }
    if (step < TOTAL) { step++; renderStep(); }
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (step < TOTAL) {
      nextBtn?.click();
      return;
    }
    setLoading(finishBtn, true);
    try {
      await readyPromise;
      const fullName = document.getElementById('onb-name')?.value?.trim() || '';
      const university = document.getElementById('onb-uni')?.value?.trim() || '';
      if (!fullName || !university) {
        step = 1;
        renderStep();
        toast(t('errors.required'), 'warning');
        setLoading(finishBtn, false);
        return;
      }
      const facultyId = form.querySelector('input[name="faculty_id"]:checked')?.value || 'autre';
      const level = levelSel?.value || 'L1';
      const prefLang = form.querySelector('input[name="language"]:checked')?.value || 'ht';
      const goalMin = Number(document.getElementById('onb-goal')?.value || 30);
      const reminderTime = document.getElementById('onb-reminder')?.value || '19:00';
      let whatsappPhone = null;
      try {
        whatsappPhone = normalizeWhatsAppPhone(document.getElementById('onb-whatsapp')?.value);
      } catch {
        toast(t('profile.whatsapp_invalid'), 'warning');
        setLoading(finishBtn, false);
        return;
      }
      const notifyWhatsapp = document.getElementById('onb-notify-wa')?.checked !== false;

      await updateProfile({
        full_name: fullName,
        university,
        faculty_id: facultyId,
        level,
        language: prefLang,
        daily_goal_minutes: goalMin,
        reminder_time: reminderTime,
        whatsapp_phone: whatsappPhone,
        notify_whatsapp: notifyWhatsapp,
        onboarded: true,
      });

      await setLang(prefLang, { persistProfile: false });

      if (whatsappPhone && notifyWhatsapp) {
        try { await db.functions.invoke('whatsapp-gateway', { body: { action: 'send_welcome' } }); } catch { /* optionnel */ }
      }

      try { await db.rpc('pran_not_record_activity'); } catch { /* ignore */ }
      location.replace(appUrl('pages/dashboard.html'));
    } catch (err) {
      if (err?.message === 'redirect_login' || err?.message === 'banned') return;
      toast(err?.message || t('errors.generic'), 'error');
      setLoading(finishBtn, false);
    }
  });
})();
