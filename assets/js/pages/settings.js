/* =====================================================================
   PRAN NÒT - pages/settings.js
   Studio Design Personnel par étudiant + paramètres langue, économie de données,
   notifications et quota IA.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, updateProfile, signOut } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, getLang, setLang } from '../i18n.js';
import { toast, handleError, setLoading, pageEnter, esc, icons } from '../utils.js';
import { getQuotaStatus } from '../ai.js';
import { initPwaInstall } from '../pwa.js';
import {
  DISPLAY_FONTS, BODY_FONTS, THEME_PRESETS,
  getTheme, applyTheme, saveTheme, resetTheme,
} from '../theme.js';

let draftTheme = getTheme();

function renderPresets(lang) {
  const grid = document.getElementById('studio-presets-grid');
  if (!grid) return;
  const isFr = lang === 'fr';
  grid.innerHTML = THEME_PRESETS.map((p) => {
    const active = draftTheme.id === p.id
      && draftTheme.bg.toUpperCase() === p.bg
      && draftTheme.card.toUpperCase() === p.card
      && draftTheme.text.toUpperCase() === p.text
      && draftTheme.accent.toUpperCase() === p.accent;
    return `
      <button type="button" class="theme-preset-card" data-preset="${esc(p.id)}" aria-pressed="${active ? 'true' : 'false'}">
        <div class="theme-preset-preview" style="background:${esc(p.bg)};">
          <span style="font-family:'${esc(p.displayFont)}',sans-serif;font-weight:700;font-size:15px;color:${esc(p.text)};">Aa</span>
          <span class="theme-swatch-row">
            <span class="theme-swatch-dot" style="background:${esc(p.card)};"></span>
            <span class="theme-swatch-dot" style="background:${esc(p.text)};"></span>
            <span class="theme-swatch-dot" style="background:${esc(p.accent)};"></span>
          </span>
        </div>
        <strong class="text-sm" style="color:var(--c-navy);">${esc(isFr ? p.name_fr : p.name_ht)}</strong>
        <span class="text-xs muted">${esc(isFr ? p.sub_fr : p.sub_ht)}</span>
      </button>`;
  }).join('');

  grid.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = THEME_PRESETS.find((x) => x.id === btn.dataset.preset);
      if (!preset) return;
      draftTheme = applyTheme({ ...preset }, { persistLocal: true });
      syncStudioControls(lang);
    });
  });
}

function populateFontSelects(lang) {
  const isFr = lang === 'fr';
  const dSel = document.getElementById('font-display-sel');
  const bSel = document.getElementById('font-body-sel');
  if (dSel) {
    dSel.innerHTML = DISPLAY_FONTS.map((f) => `<option value="${esc(f.id)}">${esc(f.label)} — ${esc(isFr ? f.tag_fr : f.tag_ht)}</option>`).join('');
  }
  if (bSel) {
    bSel.innerHTML = BODY_FONTS.map((f) => `<option value="${esc(f.id)}">${esc(f.label)} — ${esc(isFr ? f.tag_fr : f.tag_ht)}</option>`).join('');
  }
}

function syncStudioControls(lang) {
  const colBg = document.getElementById('col-bg');
  const colCard = document.getElementById('col-card');
  const colText = document.getElementById('col-text');
  const colAccent = document.getElementById('col-accent');

  if (colBg) colBg.value = draftTheme.bg;
  if (colCard) colCard.value = draftTheme.card;
  if (colText) colText.value = draftTheme.text;
  if (colAccent) colAccent.value = draftTheme.accent;

  document.getElementById('hex-bg').textContent = draftTheme.bg;
  document.getElementById('hex-card').textContent = draftTheme.card;
  document.getElementById('hex-text').textContent = draftTheme.text;
  document.getElementById('hex-accent').textContent = draftTheme.accent;

  const dSel = document.getElementById('font-display-sel');
  const bSel = document.getElementById('font-body-sel');
  if (dSel) dSel.value = draftTheme.displayFont;
  if (bSel) bSel.value = draftTheme.bodyFont;

  document.querySelectorAll('#studio-radius-group [data-radius]').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.radius === draftTheme.radius ? 'true' : 'false');
  });
  document.querySelectorAll('#studio-card-group [data-card-style]').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.cardStyle === draftTheme.cardStyle ? 'true' : 'false');
  });

  const scaleEl = document.getElementById('studio-scale');
  const scaleBadge = document.getElementById('studio-scale-val');
  if (scaleEl) scaleEl.value = String(draftTheme.scale || 1);
  if (scaleBadge) scaleBadge.textContent = `${Math.round((draftTheme.scale || 1) * 100)}%`;

  renderPresets(lang);
}

function initDesignStudio(lang) {
  populateFontSelects(lang);
  draftTheme = getTheme();
  syncStudioControls(lang);

  const previewPatch = (patch, custom = true) => {
    draftTheme = applyTheme({
      ...draftTheme,
      ...(custom ? { id: 'custom' } : {}),
      ...patch,
    }, { persistLocal: true });
    syncStudioControls(lang);
  };

  document.getElementById('col-bg')?.addEventListener('input', (e) => previewPatch({ bg: e.target.value }));
  document.getElementById('col-card')?.addEventListener('input', (e) => previewPatch({ card: e.target.value }));
  document.getElementById('col-text')?.addEventListener('input', (e) => previewPatch({ text: e.target.value }));
  document.getElementById('col-accent')?.addEventListener('input', (e) => previewPatch({ accent: e.target.value }));

  document.getElementById('font-display-sel')?.addEventListener('change', (e) => {
    previewPatch({ displayFont: e.target.value }, false);
  });
  document.getElementById('font-body-sel')?.addEventListener('change', (e) => {
    previewPatch({ bodyFont: e.target.value }, false);
  });

  document.querySelectorAll('#studio-radius-group [data-radius]').forEach((b) => {
    b.addEventListener('click', () => previewPatch({ radius: b.dataset.radius }, false));
  });
  document.querySelectorAll('#studio-card-group [data-card-style]').forEach((b) => {
    b.addEventListener('click', () => previewPatch({ cardStyle: b.dataset.cardStyle }, false));
  });

  document.getElementById('studio-scale')?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    document.getElementById('studio-scale-val').textContent = `${Math.round(val * 100)}%`;
    draftTheme = applyTheme({ ...draftTheme, scale: val }, { persistLocal: true });
  });

  document.getElementById('studio-save-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      draftTheme = await saveTheme(draftTheme, { persistProfile: true });
      toast(t('common.saved'), 'success');
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  document.getElementById('studio-reset-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      draftTheme = await resetTheme({ persistProfile: true });
      syncStudioControls(lang);
      toast(t('settings.studio_reset_done'), 'info');
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(btn, false);
    }
  });

  icons(document.getElementById('design-studio'));
}

(async () => {
  const { user, profile } = await requireAuth();
  await initAppChrome({ profile, user, active: 'profile' });
  setTutorContext({ contextType: 'general', contextTitle: t('settings.title') });
  pageEnter();

  const lang = getLang();
  initDesignStudio(lang);

  if (location.hash === '#design-studio') {
    setTimeout(() => {
      document.getElementById('design-studio')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }

  const langSel = document.getElementById('set-lang');
  const dsChk = document.getElementById('set-datasaver');
  const nDaily = document.getElementById('set-n-daily');
  const nWeekly = document.getElementById('set-n-weekly');
  const nDead = document.getElementById('set-n-deadlines');
  const nWa = document.getElementById('set-n-whatsapp');

  langSel.value = profile?.language || lang;
  dsChk.checked = Boolean(profile?.data_saver);
  nDaily.checked = profile?.notify_email !== false;
  nWeekly.checked = profile?.notify_weekly !== false;
  nDead.checked = profile?.notify_deadlines !== false;
  nWa.checked = profile?.notify_whatsapp !== false;

  langSel.addEventListener('change', async () => {
    await setLang(langSel.value);
    location.reload();
  });

  const bindToggle = (el, field) => {
    el.addEventListener('change', async () => {
      try {
        await updateProfile({ [field]: el.checked });
        if (field === 'data_saver') {
          document.body.classList.toggle('data-saver', el.checked);
          localStorage.setItem('prannot.dataSaver', el.checked ? '1' : '0');
        }
        toast(t('common.saved'), 'success');
      } catch (err) {
        handleError(err);
      }
    });
  };
  bindToggle(dsChk, 'data_saver');
  bindToggle(nDaily, 'notify_email');
  bindToggle(nWeekly, 'notify_weekly');
  bindToggle(nDead, 'notify_deadlines');
  bindToggle(nWa, 'notify_whatsapp');

  const q = await getQuotaStatus();
  const pct = Math.min(100, Math.round(((q.used || 0) / Math.max(1, q.quota || 60)) * 100));
  document.getElementById('quota-text').textContent = `${q.used || 0} / ${q.quota || 60}`;
  document.getElementById('quota-bar').style.width = `${pct}%`;

  document.getElementById('logout-btn').addEventListener('click', () => signOut());
  initPwaInstall({ showBanner: false });
  icons(document.getElementById('pwa-settings-card'));
})();
