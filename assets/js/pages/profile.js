/* =====================================================================
   PRAN NÒT - pages/profile.js
   Édition du profil académique, photo avatar, XP et galerie de badges.
   ===================================================================== */
import '../supabase.js';
import { requireAuth, updateProfile, initials } from '../auth.js';
import { initAppChrome, setTutorContext } from '../navbar.js';
import { t, getLang } from '../i18n.js';
import {
  icons, icon, esc, toast, handleError, setLoading, compressImage, checkFileSize, pageEnter, normalizeWhatsAppPhone,
} from '../utils.js';
import { cacheSet, cacheGet } from '../offline.js';

const db = window.db;

(async () => {
  const { user, profile } = await requireAuth();
  await initAppChrome({ profile, user, active: 'profile' });
  setTutorContext({ contextType: 'general', contextTitle: t('profile.title') });
  pageEnter();

  const lang = getLang();
  document.getElementById('prof-name-head').textContent = profile?.full_name || user.email;
  document.getElementById('prof-email-head').textContent = user.email;

  const avBox = document.getElementById('prof-avatar');
  if (profile?.avatar_url) {
    avBox.innerHTML = `<img src="${esc(profile.avatar_url)}" alt="${esc(profile.full_name || '')}">`;
  } else {
    avBox.textContent = initials(profile?.full_name, user.email);
  }

  document.getElementById('pf-name').value = profile?.full_name || '';
  document.getElementById('pf-uni').value = profile?.university || '';
  document.getElementById('pf-goal').value = profile?.daily_goal_minutes || 30;
  document.getElementById('pf-rem').value = (profile?.reminder_time || '19:00').slice(0, 5);
  document.getElementById('pf-wa').value = profile?.whatsapp_phone || '';

  let profMeta = await cacheGet(`profile_meta_${user.id}`);
  if (navigator.onLine) {
    try {
      const [{ data: f }, { data: ab }, { data: mb }, { data: st }] = await Promise.all([
        db.from('pran_not_faculties').select('*').order('position'),
        db.from('pran_not_badges').select('*').order('position'),
        db.from('pran_not_user_badges').select('badge_id, earned_at'),
        db.from('pran_not_streaks').select('*').eq('user_id', user.id).maybeSingle(),
      ]);
      profMeta = { facs: f || [], allBadges: ab || [], myBadges: mb || [], streak: st || null };
      await cacheSet(`profile_meta_${user.id}`, profMeta);
    } catch { /* fallback cache */ }
  }
  const facs = profMeta?.facs || (await cacheGet('faculties_list')) || [];
  const allBadges = profMeta?.allBadges || [];
  const myBadges = profMeta?.myBadges || [];
  const streak = profMeta?.streak || null;

  const facSel = document.getElementById('pf-fac');
  facSel.innerHTML = (facs || []).map((f) => `<option value="${esc(f.id)}" ${f.id === profile?.faculty_id ? 'selected' : ''}>${esc(lang === 'fr' ? f.name_fr : f.name_ht)}</option>`).join('');

  const lvlSel = document.getElementById('pf-lvl');
  ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'master'].forEach((lv) => {
    lvlSel.insertAdjacentHTML('beforeend', `<option value="${lv}" ${lv === profile?.level ? 'selected' : ''}>${esc(t(`onboarding.levels.${lv}`))}</option>`);
  });

  // Bilan XP & Série
  document.getElementById('profile-stats').innerHTML = `
    <h2 class="card-title mb-4">${esc(t('profile.stats'))}</h2>
    <div class="stack-sm">
      <div class="row-between"><span>XP</span><strong>${profile?.xp || 0} XP</strong></div>
      <div class="row-between"><span>${esc(t('dashboard.xp_label', { level: profile?.xp_level || 1 }))}</span><strong>Nivo ${profile?.xp_level || 1}</strong></div>
      <div class="row-between"><span>${esc(t('dashboard.streak_label'))}</span><strong>${streak?.current || 0} j (rekò: ${streak?.longest || 0} j)</strong></div>
    </div>`;

  // Badges
  const earnedIds = new Set((myBadges || []).map((b) => b.badge_id));
  const bGrid = document.getElementById('badges-grid');
  bGrid.innerHTML = (allBadges || []).map((b) => {
    const owned = earnedIds.has(b.id);
    return `<div class="card card-sm" style="opacity:${owned ? '1' : '0.45'};">
      <div class="row mb-2">
        <span class="icon-chip sm ${owned ? 'accent' : ''}">${icon(b.icon || 'award')}</span>
        <strong class="text-sm">${esc(lang === 'fr' ? b.name_fr : b.name_ht)}</strong>
      </div>
      <p class="text-xs muted mb-0">${esc(lang === 'fr' ? b.description_fr : b.description_ht)}</p>
    </div>`;
  }).join('');
  icons(bGrid);

  document.getElementById('avatar-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file || !checkFileSize(file, 'avatar')) return;
    try {
      const blob = await compressImage(file, { maxSize: 400, quality: 0.8 });
      const path = `${user.id}/avatar-${Date.now()}.jpg`;
      const { error: upErr } = await db.storage.from('pran-not-avatars').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (upErr) throw upErr;
      const { data: signed } = await db.storage.from('pran-not-avatars').createSignedUrl(path, 60 * 60 * 24 * 365);
      await updateProfile({ avatar_url: signed?.signedUrl || null });
      if (signed?.signedUrl) avBox.innerHTML = `<img src="${esc(signed.signedUrl)}" alt="Avatar">`;
      toast(t('common.saved'), 'success');
    } catch (err) {
      handleError(err);
    }
  });

  const saveBtn = document.getElementById('pf-save-btn');
  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let waPhone = null;
    try {
      waPhone = normalizeWhatsAppPhone(document.getElementById('pf-wa').value);
    } catch {
      toast(t('profile.whatsapp_invalid'), 'warning');
      return;
    }
    setLoading(saveBtn, true);
    try {
      const updated = await updateProfile({
        full_name: document.getElementById('pf-name').value.trim(),
        university: document.getElementById('pf-uni').value.trim(),
        faculty_id: facSel.value,
        level: lvlSel.value,
        daily_goal_minutes: Number(document.getElementById('pf-goal').value || 30),
        reminder_time: document.getElementById('pf-rem').value || '19:00',
        whatsapp_phone: waPhone,
      });
      if (waPhone) document.getElementById('pf-wa').value = waPhone;
      document.getElementById('prof-name-head').textContent = updated.full_name;
      toast(t('common.saved'), 'success');
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(saveBtn, false);
    }
  });
})();
