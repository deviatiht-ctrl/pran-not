/* =====================================================================
   PRAN NÒT - srs.js
   Algorithme de répétition espacée SM-2 adapté à 4 niveaux de notation.
   0 = À revoir | 1 = Difficile | 2 = Bien | 3 = Facile
   ===================================================================== */

/**
 * Calcule le prochain état SM-2 d'une flashcard.
 * @param {object} card { ease, interval_days, repetitions, lapses }
 * @param {0|1|2|3} rating
 * @param {Date} now
 * @returns {{ ease:number, interval_days:number, repetitions:number, lapses:number, due_at:string, last_reviewed_at:string }}
 */
export function sm2(card, rating, now = new Date()) {
  const prevEase = Number(card?.ease ?? 2.5);
  const prevInterval = Number(card?.interval_days ?? 0);
  const prevReps = Number(card?.repetitions ?? 0);
  const prevLapses = Number(card?.lapses ?? 0);

  let ease = prevEase;
  let interval = prevInterval;
  let repetitions = prevReps;
  let lapses = prevLapses;

  if (rating === 0) {
    // À revoir : réinitialisation de la série
    repetitions = 0;
    lapses = prevLapses + 1;
    interval = 1;
    ease = Math.max(1.3, Number((prevEase - 0.2).toFixed(2)));
  } else {
    // Correspondance avec la qualité SM-2 (3 = difficile, 4 = bien, 5 = facile)
    const q = rating === 1 ? 3 : rating === 2 ? 4 : 5;
    ease = prevEase + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    ease = Math.max(1.3, Number(ease.toFixed(2)));

    if (prevReps === 0) {
      interval = rating === 3 ? 4 : 1;
    } else if (prevReps === 1) {
      interval = rating === 1 ? 3 : rating === 3 ? 8 : 6;
    } else {
      const factor = rating === 1 ? 1.2 : rating === 3 ? ease * 1.3 : ease;
      interval = Math.max(prevInterval + 1, Math.round(prevInterval * factor));
    }
    repetitions = prevReps + 1;
  }

  // Plafond raisonnable : 365 jours
  interval = Math.min(365, Math.max(1, interval));

  const due = new Date(now.getTime() + interval * 86400000);
  return {
    ease,
    interval_days: interval,
    repetitions,
    lapses,
    due_at: due.toISOString(),
    last_reviewed_at: now.toISOString(),
  };
}

/** Retourne l'aperçu des intervalles pour les 4 boutons (ex: "1 j", "6 j"). */
export function previewIntervals(card, lang = 'ht') {
  const unitDay = lang === 'ht' ? 'j' : 'j';
  const unitMonth = lang === 'ht' ? 'mwa' : 'mois';
  const fmt = (days) => {
    if (days >= 30) return `${Math.round(days / 30)} ${unitMonth}`;
    return `${days} ${unitDay}`;
  };
  return {
    0: lang === 'ht' ? 'Talè / 1 j' : 'Revoir / 1 j',
    1: fmt(sm2(card, 1).interval_days),
    2: fmt(sm2(card, 2).interval_days),
    3: fmt(sm2(card, 3).interval_days),
  };
}

/** Formate un texte cloze : remplace {{mot}} par un blanc ou la réponse. */
export function formatCloze(text, reveal = false) {
  const str = String(text || '');
  if (reveal) {
    return str.replace(/\{\{([^}]+)\}\}/g, '<mark>$1</mark>');
  }
  return str.replace(/\{\{([^}]+)\}\}/g, '<span class="cloze-blank" aria-label="mot manquant">_____</span>');
}
