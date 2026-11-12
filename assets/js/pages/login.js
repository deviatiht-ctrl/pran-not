/* =====================================================================
   PRAN NÒT - pages/login.js
   Connexion et inscription par email + mot de passe (+ Google si activé).
   ===================================================================== */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase.js';
import { initI18n, getLang, setLang, t } from '../i18n.js';
import { getSession, getProfile, appUrl } from '../auth.js';
import { ensureFooter } from '../navbar.js';
import { initPwaInstall } from '../pwa.js';
import { icons, icon, toast, setLoading, getParam, esc, pageEnter } from '../utils.js';

const db = window.db;
let mode = 'password'; // 'password' | 'signup'

function showAlert(msg, kind = 'warning') {
  const box = document.getElementById('login-alert');
  box.className = `alert alert-${kind} mb-4`;
  box.innerHTML = `${icon(kind === 'success' ? 'check-circle-2' : 'alert-circle')}<div>${esc(msg)}</div>`;
  box.hidden = false;
  icons(box);
}

function hideAlert() {
  const box = document.getElementById('login-alert');
  if (box) box.hidden = true;
}

function mapAuthError(err) {
  const raw = String(err?.message || '').toLowerCase();
  if (raw.includes('invalid login credentials') || raw.includes('invalid email or password')) {
    return t('login.err_invalid_credentials');
  }
  if (raw.includes('already registered') || raw.includes('user already exists')) {
    return t('login.err_already_registered');
  }
  if (raw.includes('at least') && raw.includes('character')) {
    return t('login.err_weak_password');
  }
  if (raw.includes('email not confirmed')) {
    return t('login.err_email_not_confirmed');
  }
  if (raw.includes('rate limit') || err?.status === 429) {
    return t('login.err_rate_limit');
  }
  return err?.message || t('errors.generic');
}

async function redirectAfterAuth() {
  const next = getParam('next');
  try {
    const profile = await getProfile(true);
    if (profile && !profile.onboarded) {
      location.replace(appUrl('onboarding.html'));
      return;
    }
  } catch { /* continuer vers dashboard */ }

  if (next && next.startsWith('/') && !next.startsWith('//')) {
    location.replace(next);
  } else {
    location.replace(appUrl('pages/dashboard.html'));
  }
}

function bindPasswordToggle(btnId, inputId) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    const nextType = input.type === 'password' ? 'text' : 'password';
    input.type = nextType;
    btn.innerHTML = icon(nextType === 'text' ? 'eye-off' : 'eye');
    btn.setAttribute('aria-label', t(nextType === 'text' ? 'login.hide_password' : 'login.show_password'));
    icons(btn);
  });
}

async function detectGoogleProvider() {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_ANON_KEY },
    });
    if (!res.ok) return;
    const settings = await res.json();
    if (settings?.external?.google) {
      const divider = document.getElementById('auth-divider');
      const gBtn = document.getElementById('google-btn');
      if (divider) divider.hidden = false;
      if (gBtn) gBtn.hidden = false;
    }
  } catch { /* garder Google masqué si hors-ligne */ }
}

(async () => {
  const tabs = document.querySelectorAll('[role="tab"]');
  const nameField = document.getElementById('name-field');
  const passInput = document.getElementById('password');
  const passHint = document.getElementById('pass-hint');
  const confirmField = document.getElementById('confirm-password-field');
  const confirmInput = document.getElementById('confirm-password');
  const submitLabel = document.querySelector('#submit-btn span');
  const form = document.getElementById('auth-form');
  const submitBtn = document.getElementById('submit-btn');

  let formReady = false;
  function applyMode(nextMode) {
    mode = nextMode === 'signup' ? 'signup' : 'password';
    const isSignup = mode === 'signup';
    tabs.forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === mode ? 'true' : 'false'));
    nameField.hidden = !isSignup;
    confirmField.hidden = !isSignup;
    passHint.hidden = !isSignup;
    confirmInput.required = isSignup;
    passInput.autocomplete = isSignup ? 'new-password' : 'current-password';
    if (formReady) submitLabel.textContent = t(isSignup ? 'login.submit_signup' : 'login.submit_login');
  }

  if (getParam('mode') === 'signup') {
    applyMode('signup');
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      hideAlert();
      applyMode(tab.dataset.mode);
    });
  });

  bindPasswordToggle('toggle-pass-btn', 'password');
  bindPasswordToggle('toggle-confirm-btn', 'confirm-password');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!formReady) return;
    hideAlert();
    const email = document.getElementById('email').value.trim();
    const password = passInput.value;
    const confirm = confirmInput.value;
    const fullName = document.getElementById('full-name').value.trim();

    if (!email || !password) {
      showAlert(t('errors.required'), 'warning');
      return;
    }

    if (mode === 'signup') {
      if (password.length < 6) {
        showAlert(t('login.err_weak_password'), 'warning');
        passInput.focus();
        return;
      }
      if (password !== confirm) {
        showAlert(t('login.password_mismatch'), 'warning');
        confirmInput.focus();
        return;
      }
    }

    setLoading(submitBtn, true);
    try {
      if (mode === 'signup') {
        const { data, error } = await db.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName || undefined },
            emailRedirectTo: appUrl('onboarding.html'),
          },
        });
        if (error) throw error;
        if (data.session) {
          await redirectAfterAuth();
        } else {
          showAlert(t('login.signup_check_email'), 'success');
        }
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await redirectAfterAuth();
      }
    } catch (err) {
      const msg = mapAuthError(err);
      showAlert(msg, 'error');
      toast(msg, 'error');
    } finally {
      setLoading(submitBtn, false);
    }
  });

  await initI18n();
  formReady = true;
  applyMode(mode);
  ensureFooter();
  initPwaInstall({ showBanner: true });
  icons();
  pageEnter();

  const langBtn = document.getElementById('login-lang-btn');
  langBtn.textContent = getLang().toUpperCase();
  langBtn.addEventListener('click', async () => {
    await setLang(getLang() === 'ht' ? 'fr' : 'ht', { persistProfile: false });
    langBtn.textContent = getLang().toUpperCase();
    applyMode(mode);
  });

  if (getParam('admin') === 'denied') showAlert(t('login.admin_denied'), 'error');
  if (getParam('banned') === '1') showAlert(t('login.banned'), 'error');

  const existing = await getSession();
  if (existing) {
    await redirectAfterAuth();
    return;
  }

  detectGoogleProvider();

  document.getElementById('google-btn')?.addEventListener('click', async () => {
    try {
      const { error } = await db.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: appUrl('pages/dashboard.html') },
      });
      if (error) throw error;
    } catch (err) {
      toast(mapAuthError(err), 'error');
    }
  });
})();
