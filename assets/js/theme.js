/* =====================================================================
   PRAN NÒT - theme.js
   Moteur de thèmes sophistiqués par étudiant : palettes claires/sombres,
   contraste AA automatique, typographies Google Fonts, rayons, finitions
   des cartes, sauvegarde locale instantanée (sans FOUC) et synchronisation
   sur pran_not_profiles.theme_config.
   ===================================================================== */

export const DISPLAY_FONTS = [
  { id: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans', tag_ht: 'Modèn ak klè (Defo)', tag_fr: 'Moderne et net (Défaut)', gf: 'Plus+Jakarta+Sans:wght@500;600;700;800' },
  { id: 'Sora', label: 'Sora', tag_ht: 'Jeyometrik presi', tag_fr: 'Géométrique précis', gf: 'Sora:wght@600;700;800' },
  { id: 'Space Grotesk', label: 'Space Grotesk', tag_ht: 'Achitekti ak karaktè', tag_fr: 'Architectural et affirmé', gf: 'Space+Grotesk:wght@500;600;700' },
  { id: 'Outfit', label: 'Outfit', tag_ht: 'Senp ak akeyan', tag_fr: 'Épuré et chaleureux', gf: 'Outfit:wght@500;600;700;800' },
  { id: 'Bricolage Grotesque', label: 'Bricolage Grotesque', tag_ht: 'Editoryal ekspresif', tag_fr: 'Éditorial expressif', gf: 'Bricolage+Grotesque:wght@600;700;800' },
  { id: 'Fraunces', label: 'Fraunces', tag_ht: 'Serig akadémik klasik', tag_fr: 'Serif académique raffiné', gf: 'Fraunces:opsz,wght@9..144,600;9..144,700' },
  { id: 'Lora', label: 'Lora', tag_ht: 'Literè ak pozé', tag_fr: 'Littéraire et posé', gf: 'Lora:wght@600;700' },
  { id: 'Manrope', label: 'Manrope', tag_ht: 'Swis modèn', tag_fr: 'Suisse contemporain', gf: 'Manrope:wght@600;700;800' },
];

export const BODY_FONTS = [
  { id: 'Inter', label: 'Inter', tag_ht: 'Ekstrèmman lizib (Defo)', tag_fr: 'Lisibilité maximale (Défaut)', gf: 'Inter:wght@400;500;600;700' },
  { id: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans', tag_ht: 'Dous ak balanse', tag_fr: 'Fluide et équilibré', gf: 'Plus+Jakarta+Sans:wght@400;500;600;700' },
  { id: 'Source Sans 3', label: 'Source Sans 3', tag_ht: 'Konfò lekti long', tag_fr: 'Confort lecture longue', gf: 'Source+Sans+3:wght@400;500;600;700' },
  { id: 'Work Sans', label: 'Work Sans', tag_ht: 'Kla ak estriktire', tag_fr: 'Clair et structuré', gf: 'Work+Sans:wght@400;500;600;700' },
  { id: 'Nunito Sans', label: 'Nunito Sans', tag_ht: 'Awondi ak kalm', tag_fr: 'Doux et reposant', gf: 'Nunito+Sans:wght@400;600;700' },
  { id: 'Merriweather', label: 'Merriweather', tag_ht: 'Serif pou nòt long', tag_fr: 'Serif de lecture', gf: 'Merriweather:wght@400;700' },
];

export const THEME_PRESETS = [
  {
    id: 'kreyol_editorial',
    name_ht: 'Pran Nòt Klasik',
    name_fr: 'Pran Nòt Classique',
    sub_ht: 'Blan pi ak zoranj inivèsitè',
    sub_fr: 'Blanc pur et orange universitaire',
    bg: '#FFFFFF',
    card: '#FFFFFF',
    text: '#1B2A4A',
    accent: '#F97316',
    displayFont: 'Plus Jakarta Sans',
    bodyFont: 'Inter',
    radius: 'balanced',
    cardStyle: 'bordered',
    scale: 1,
  },
  {
    id: 'papye_cho',
    name_ht: 'Papye Bibliyotèk',
    name_fr: 'Papier Bibliothèque',
    sub_ht: 'Krèm cho ak tèkòta dous pou je',
    sub_fr: 'Crème chaud et terracotta reposant',
    bg: '#FBF8F3',
    card: '#FFFFFF',
    text: '#1F242D',
    accent: '#C85A17',
    displayFont: 'Fraunces',
    bodyFont: 'Source Sans 3',
    radius: 'balanced',
    cardStyle: 'bordered',
    scale: 1,
  },
  {
    id: 'karayib_lagon',
    name_ht: 'Lagon Karayib',
    name_fr: 'Lagon Caraïbe',
    sub_ht: 'Vè dlo klè ak ble pwofon',
    sub_fr: 'Vert d’eau épuré et encre marine',
    bg: '#F6FBFA',
    card: '#FFFFFF',
    text: '#0F2933',
    accent: '#0D9488',
    displayFont: 'Sora',
    bodyFont: 'Plus Jakarta Sans',
    radius: 'soft',
    cardStyle: 'elevated',
    scale: 1,
  },
  {
    id: 'jaden_kafe',
    name_ht: 'Jaden Kafe',
    name_fr: 'Jardin Café',
    sub_ht: 'Ton òganik natirèl ak anm',
    sub_fr: 'Neutre organique et ambre doré',
    bg: '#F9F9F6',
    card: '#FFFFFF',
    text: '#1C2B21',
    accent: '#B45309',
    displayFont: 'Bricolage Grotesque',
    bodyFont: 'Inter',
    radius: 'balanced',
    cardStyle: 'bordered',
    scale: 1,
  },
  {
    id: 'mon_ble',
    name_ht: 'Mòn Ble',
    name_fr: 'Morne Bleu',
    sub_ht: 'Pwofesyonèl ak kobalt modèn',
    sub_fr: 'Studio clair et bleu cobalt',
    bg: '#F8FAFC',
    card: '#FFFFFF',
    text: '#0F172A',
    accent: '#2563EB',
    displayFont: 'Space Grotesk',
    bodyFont: 'Inter',
    radius: 'sharp',
    cardStyle: 'bordered',
    scale: 1,
  },
  {
    id: 'lank_minwi',
    name_ht: 'Lank Minwi (Nwa)',
    name_fr: 'Encre de Minuit (Sombre)',
    sub_ht: 'Mòd fènwa kalm pou etidye lannwit',
    sub_fr: 'Mode sombre confortable pour la nuit',
    bg: '#0D1422',
    card: '#151F33',
    text: '#F1F5F9',
    accent: '#FB923C',
    displayFont: 'Plus Jakarta Sans',
    bodyFont: 'Inter',
    radius: 'balanced',
    cardStyle: 'bordered',
    scale: 1,
  },
  {
    id: 'katye_wa',
    name_ht: 'Obsidyèn Lò (Nwa)',
    name_fr: 'Obsidienne & Or (Sombre)',
    sub_ht: 'Nwa chabon elegant ak aksan lò',
    sub_fr: 'Charbon raffiné et accents dorés',
    bg: '#111114',
    card: '#1A1A1F',
    text: '#F4F4F5',
    accent: '#EAB308',
    displayFont: 'Outfit',
    bodyFont: 'Work Sans',
    radius: 'balanced',
    cardStyle: 'elevated',
    scale: 1,
  },
  {
    id: 'lalin_nwa',
    name_ht: 'Forè Nwit (Nwa)',
    name_fr: 'Forêt Nocturne (Sombre)',
    sub_ht: 'Nwa botanik pwofon ak vè emwòd',
    sub_fr: 'Émeraude nocturne apaisant',
    bg: '#0B1512',
    card: '#12211D',
    text: '#ECFDF5',
    accent: '#10B981',
    displayFont: 'Manrope',
    bodyFont: 'Nunito Sans',
    radius: 'soft',
    cardStyle: 'bordered',
    scale: 1,
  },
];

const RADIUS_MAP = {
  sharp: { sm: '4px', md: '8px', lg: '10px', xl: '16px' },
  balanced: { sm: '8px', md: '12px', lg: '16px', xl: '24px' },
  soft: { sm: '12px', md: '18px', lg: '24px', xl: '32px' },
};

const STORAGE_THEME = 'prannot.theme';
const STORAGE_VARS = 'prannot.theme_vars';

export function getDefaultTheme() {
  return { ...THEME_PRESETS[0] };
}

function cleanHex(v, fallback) {
  const s = String(v || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toUpperCase();
  }
  return fallback;
}

export function normalizeThemeConfig(raw = {}) {
  const def = getDefaultTheme();
  if (!raw || typeof raw !== 'object') return def;

  const preset = THEME_PRESETS.find((p) => p.id === raw.id);
  const base = preset ? { ...preset } : def;

  const displayOk = DISPLAY_FONTS.some((f) => f.id === raw.displayFont);
  const bodyOk = BODY_FONTS.some((f) => f.id === raw.bodyFont);
  const radius = ['sharp', 'balanced', 'soft'].includes(raw.radius) ? raw.radius : base.radius;
  const cardStyle = ['bordered', 'elevated', 'tinted'].includes(raw.cardStyle) ? raw.cardStyle : base.cardStyle;
  const numScale = Number(raw.scale);
  const scale = Number.isFinite(numScale) ? Math.min(1.22, Math.max(0.88, Math.round(numScale * 100) / 100)) : base.scale;

  return {
    id: raw.id || base.id,
    bg: cleanHex(raw.bg, base.bg),
    card: cleanHex(raw.card, base.card),
    text: cleanHex(raw.text, base.text),
    accent: cleanHex(raw.accent, base.accent),
    displayFont: displayOk ? raw.displayFont : base.displayFont,
    bodyFont: bodyOk ? raw.bodyFont : base.bodyFont,
    radius,
    cardStyle,
    scale,
  };
}

function hexToRgb(hex) {
  const c = cleanHex(hex, '#000000').slice(1);
  return {
    r: parseInt(c.slice(0, 2), 16),
    g: parseInt(c.slice(2, 4), 16),
    b: parseInt(c.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function mixHex(c1, c2, amount) {
  const a = hexToRgb(c1);
  const b = hexToRgb(c2);
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

function rgbaStr(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

function relLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastRatio(hexA, hexB) {
  const l1 = relLuminance(hexA);
  const l2 = relLuminance(hexB);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function ensureMinContrast(fgHex, bgHex, targetHex, minRatio = 4.6) {
  let candidate = fgHex;
  if (contrastRatio(candidate, bgHex) >= minRatio) return candidate;
  for (let i = 1; i <= 20; i++) {
    candidate = mixHex(fgHex, targetHex, i / 20);
    if (contrastRatio(candidate, bgHex) >= minRatio) return candidate;
  }
  return candidate;
}

export function buildFontHref(displayFont, bodyFont) {
  const specs = new Set();
  const dObj = DISPLAY_FONTS.find((f) => f.id === displayFont);
  const bObj = BODY_FONTS.find((f) => f.id === bodyFont);
  if (dObj && dObj.id !== 'Plus Jakarta Sans' && dObj.id !== 'Inter') specs.add(dObj.gf);
  if (bObj && bObj.id !== 'Plus Jakarta Sans' && bObj.id !== 'Inter') specs.add(bObj.gf);
  if (!specs.size) return '';
  return `https://fonts.googleapis.com/css2?family=${Array.from(specs).join('&family=')}&display=swap`;
}

export function computeThemePayload(rawConfig) {
  const cfg = normalizeThemeConfig(rawConfig);
  const isDark = relLuminance(cfg.bg) < 0.24;

  // Assurer que text a un contraste minimal avec bg et card
  const safeText = ensureMinContrast(cfg.text, cfg.card, isDark ? '#FFFFFF' : '#0F172A', 7);
  const onNavy = contrastRatio('#FFFFFF', safeText) >= contrastRatio('#0D1422', safeText) ? '#FFFFFF' : '#0D1422';
  const navyHover = isDark ? mixHex(safeText, '#CBD5E1', 0.2) : mixHex(safeText, '#000000', 0.25);

  const muted = ensureMinContrast(
    mixHex(safeText, cfg.bg, isDark ? 0.30 : 0.34),
    cfg.card,
    safeText,
    4.6,
  );
  const faint = mixHex(safeText, cfg.bg, isDark ? 0.45 : 0.48);
  const placeholder = mixHex(safeText, cfg.bg, isDark ? 0.55 : 0.58);

  const onAccent = contrastRatio('#FFFFFF', cfg.accent) >= 3.4 ? '#FFFFFF' : '#111827';
  const accentHover = isDark ? mixHex(cfg.accent, '#FFFFFF', 0.14) : mixHex(cfg.accent, '#000000', 0.14);
  const accentText = ensureMinContrast(
    cfg.accent,
    cfg.card,
    isDark ? '#FFFFFF' : '#000000',
    4.6,
  );

  const surface = isDark ? mixHex(cfg.bg, '#FFFFFF', 0.08) : mixHex(cfg.bg, safeText, 0.045);
  const surface2 = isDark ? mixHex(cfg.card, '#FFFFFF', 0.045) : mixHex(cfg.bg, safeText, 0.02);
  const cardBg = cfg.cardStyle === 'tinted' ? surface2 : cfg.card;
  const inputBg = isDark ? mixHex(cfg.card, '#000000', 0.2) : cfg.card;

  const border = isDark ? 'rgba(255, 255, 255, 0.12)' : mixHex(cfg.bg, safeText, 0.12);
  const borderStrong = isDark ? 'rgba(255, 255, 255, 0.24)' : mixHex(cfg.bg, safeText, 0.22);

  const radii = RADIUS_MAP[cfg.radius] || RADIUS_MAP.balanced;

  const shadowBase = isDark ? 'rgba(0, 0, 0, 0.45)' : rgbaStr(safeText, 0.07);
  const vars = {
    '--c-bg': cfg.bg,
    '--c-card': cardBg,
    '--c-elevated': isDark ? mixHex(cfg.card, '#FFFFFF', 0.03) : cfg.card,
    '--c-navy': safeText,
    '--c-on-navy': onNavy,
    '--c-navy-hover': navyHover,
    '--c-navy-80': mixHex(safeText, cfg.bg, 0.18),
    '--c-navy-60': mixHex(safeText, cfg.bg, 0.36),
    '--c-text': safeText,
    '--c-text-muted': muted,
    '--c-text-faint': faint,
    '--c-placeholder': placeholder,
    '--c-accent': cfg.accent,
    '--c-on-accent': onAccent,
    '--c-accent-hover': accentHover,
    '--c-accent-text': accentText,
    '--c-accent-soft': rgbaStr(cfg.accent, isDark ? 0.18 : 0.11),
    '--c-accent-border': rgbaStr(cfg.accent, isDark ? 0.38 : 0.3),
    '--c-accent-ring': rgbaStr(cfg.accent, 0.35),
    '--c-accent-shadow': rgbaStr(cfg.accent, isDark ? 0.28 : 0.34),
    '--c-surface': surface,
    '--c-surface-2': surface2,
    '--c-input-bg': inputBg,
    '--c-border': border,
    '--c-border-strong': borderStrong,
    '--c-skeleton-hi': isDark ? 'rgba(255, 255, 255, 0.14)' : rgbaStr(safeText, 0.08),
    '--c-overlay': isDark ? 'rgba(0, 0, 0, 0.65)' : rgbaStr(safeText, 0.38),
    '--c-nav-bg': rgbaStr(cfg.card, isDark ? 0.84 : 0.82),
    '--c-nav-border': isDark ? 'rgba(255, 255, 255, 0.14)' : rgbaStr(mixHex(cfg.bg, safeText, 0.12), 0.92),
    '--c-nav-active': isDark ? mixHex(cfg.card, '#FFFFFF', 0.1) : cfg.card,
    '--c-mobile-nav-bg': rgbaStr(cfg.card, 0.92),
    '--c-success': isDark ? '#4ADE80' : '#15803D',
    '--c-success-soft': isDark ? 'rgba(34, 197, 94, 0.16)' : '#ECFDF3',
    '--c-success-border': isDark ? 'rgba(74, 222, 128, 0.34)' : '#BBF7D0',
    '--c-success-text': isDark ? '#BBF7D0' : '#14532D',
    '--c-error': isDark ? '#F87171' : '#B91C1C',
    '--c-error-soft': isDark ? 'rgba(239, 68, 68, 0.16)' : '#FEF2F2',
    '--c-error-border': isDark ? 'rgba(248, 113, 113, 0.34)' : '#FECACA',
    '--c-error-text': isDark ? '#FECACA' : '#7F1D1D',
    '--c-warning': isDark ? '#FBBF24' : '#A16207',
    '--c-warning-soft': isDark ? 'rgba(245, 158, 11, 0.16)' : '#FEFCE8',
    '--c-warning-border': isDark ? 'rgba(251, 191, 36, 0.34)' : '#FDE68A',
    '--c-warning-text': isDark ? '#FDE68A' : '#713F12',
    '--c-info': isDark ? '#60A5FA' : '#1D4ED8',
    '--c-info-soft': isDark ? 'rgba(59, 130, 246, 0.16)' : '#EFF6FF',
    '--c-info-border': isDark ? 'rgba(96, 165, 250, 0.34)' : '#BFDBFE',
    '--c-info-text': isDark ? '#BFDBFE' : '#1E3A8A',
    '--font-display': `'${cfg.displayFont}', '${cfg.bodyFont}', system-ui, sans-serif`,
    '--font-body': `'${cfg.bodyFont}', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`,
    '--fs-scale': String(cfg.scale),
    '--r-sm': radii.sm,
    '--r-md': radii.md,
    '--r-lg': radii.lg,
    '--r-xl': radii.xl,
    '--sh-xs': isDark ? `0 1px 2px ${shadowBase}` : `0 1px 2px ${rgbaStr(safeText, 0.05)}`,
    '--sh-sm': isDark ? `0 2px 6px ${shadowBase}` : `0 1px 3px ${rgbaStr(safeText, 0.06)}, 0 1px 2px ${rgbaStr(safeText, 0.04)}`,
    '--sh-md': isDark ? `0 10px 28px ${shadowBase}` : `0 6px 20px ${rgbaStr(safeText, 0.07)}`,
    '--sh-lg': isDark ? `0 18px 48px rgba(0, 0, 0, 0.60)` : `0 16px 40px ${rgbaStr(safeText, 0.10)}`,
  };

  return {
    config: cfg,
    mode: isDark ? 'dark' : 'light',
    cardStyle: cfg.cardStyle,
    fontHref: buildFontHref(cfg.displayFont, cfg.bodyFont),
    themeColor: isDark ? cfg.bg : safeText,
    vars,
  };
}

function ensureCustomFontLink(href) {
  let el = document.getElementById('prannot-custom-fonts');
  if (!href) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('link');
    el.id = 'prannot-custom-fonts';
    el.rel = 'stylesheet';
    document.head.appendChild(el);
  }
  if (el.getAttribute('href') !== href) el.setAttribute('href', href);
}

/** Applique un thème sur documentElement sans latence. */
export function applyTheme(rawConfig, { persistLocal = true } = {}) {
  const payload = computeThemePayload(rawConfig);
  const root = document.documentElement;
  root.setAttribute('data-theme-mode', payload.mode);
  root.setAttribute('data-card-style', payload.cardStyle);

  for (const [k, v] of Object.entries(payload.vars)) {
    root.style.setProperty(k, v);
  }

  ensureCustomFontLink(payload.fontHref);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', payload.themeColor);

  if (persistLocal) {
    try {
      localStorage.setItem(STORAGE_THEME, JSON.stringify(payload.config));
      localStorage.setItem(
        STORAGE_VARS,
        JSON.stringify({
          vars: payload.vars,
          mode: payload.mode,
          cardStyle: payload.cardStyle,
          fontHref: payload.fontHref,
          themeColor: payload.themeColor,
        }),
      );
    } catch { /* quota localStorage */ }
  }
  return payload.config;
}

/** Thème courant depuis le stockage local ou défaut. */
export function getTheme() {
  try {
    const raw = localStorage.getItem(STORAGE_THEME);
    if (raw) return normalizeThemeConfig(JSON.parse(raw));
  } catch { /* ignore */ }
  return getDefaultTheme();
}

/** Applique puis sauvegarde sur le profil Supabase. */
export async function saveTheme(rawConfig, { persistProfile = true } = {}) {
  const cfg = applyTheme(rawConfig, { persistLocal: true });
  if (persistProfile && window.db && navigator.onLine) {
    try {
      const { data: sess } = await window.db.auth.getSession();
      const uid = sess?.session?.user?.id;
      if (uid) {
        const { error } = await window.db
          .from('pran_not_profiles')
          .update({ theme_config: cfg })
          .eq('id', uid);
        if (error) throw error;
        const cachedRaw = localStorage.getItem('prannot.profile');
        if (cachedRaw) {
          const prof = JSON.parse(cachedRaw);
          prof.theme_config = cfg;
          localStorage.setItem('prannot.profile', JSON.stringify(prof));
        }
      }
    } catch (err) {
      console.warn('[theme] save profile error', err);
      throw err;
    }
  }
  return cfg;
}

/** Réinitialise vers le thème Pran Nòt Klasik. */
export async function resetTheme({ persistProfile = true } = {}) {
  return saveTheme(getDefaultTheme(), { persistProfile });
}

/** Applique le thème sauvegardé dans le profil uniquement s'il est configuré. */
export function syncThemeFromProfile(profile) {
  if (profile?.theme_config && Object.keys(profile.theme_config).length > 0) {
    return applyTheme(profile.theme_config, { persistLocal: true });
  }
  return getTheme();
}

/** Palette Chart.js adaptée au thème actif (clair ou sombre). */
export function getThemeChartPalette() {
  const cfg = getTheme();
  const isDark = relLuminance(cfg.bg) < 0.24;
  return {
    accent: cfg.accent,
    accentSoft: rgbaStr(cfg.accent, isDark ? 0.22 : 0.14),
    primary: cfg.text,
    primarySoft: rgbaStr(cfg.text, isDark ? 0.18 : 0.1),
    text: cfg.text,
    muted: isDark ? mixHex(cfg.text, cfg.bg, 0.35) : mixHex(cfg.text, cfg.bg, 0.4),
    grid: isDark ? 'rgba(255, 255, 255, 0.09)' : rgbaStr(cfg.text, 0.08),
    isDark,
  };
}

// Application immédiate au chargement du module
applyTheme(getTheme(), { persistLocal: false });
