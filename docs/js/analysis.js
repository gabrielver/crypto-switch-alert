// Module d'analyse partagé entre le bot Node (GitHub Actions) et la PWA.
// Aucune dépendance : uniquement des fonctions pures sur des séries [tMs, valeur].
//
// Pour enrichir plus tard la couche d'analyse (sentiment, news, prédiction…),
// ajouter des fonctions qui produisent des objets "signal" au même format que
// analyzePair() : le bot et la PWA les consommeront sans modification.

const MIN = 60 * 1000;

/** Moyenne simple des `period` dernières valeurs (ou de toutes si moins). */
export function sma(values, period) {
  if (!values.length) return null;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

/** Moyenne et écart-type d'un tableau de valeurs. */
export function meanStd(values) {
  if (!values.length) return { mean: null, std: null };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/** RSI de Wilder sur les `period + 1` derniers points (0-100, null si trop court). */
export function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  const slice = values.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

/** Valeurs d'une série [t, v] comprises dans les `minutes` dernières minutes. */
export function windowValues(series, minutes, now) {
  const cutoff = now - minutes * MIN;
  return series.filter(([t]) => t >= cutoff).map(([, v]) => v);
}

/** Variation en % entre la valeur il y a `minutes` minutes et la dernière. */
export function variationPct(series, minutes, now) {
  if (series.length < 2) return null;
  const target = now - minutes * MIN;
  // Point le plus proche du passé visé (tolérance : moitié de la fenêtre).
  let past = null;
  for (const [t, v] of series) {
    if (t <= target) past = v;
    else break;
  }
  if (past === null) {
    const [t0, v0] = series[0];
    if (t0 > target + minutes * MIN * 0.5) return null;
    past = v0;
  }
  const last = series[series.length - 1][1];
  if (!past) return null;
  return ((last - past) / past) * 100;
}

/**
 * Construit la série du ratio prixFrom / prixTo en alignant deux séries de prix.
 * Pour chaque point de A, prend la dernière valeur de B connue à cet instant
 * (tolérance 2 h : au-delà, le point est ignoré).
 */
export function buildRatioSeries(seriesFrom, seriesTo) {
  const out = [];
  let j = 0;
  let lastB = null;
  let lastBt = -Infinity;
  for (const [t, vA] of seriesFrom) {
    while (j < seriesTo.length && seriesTo[j][0] <= t) {
      lastBt = seriesTo[j][0];
      lastB = seriesTo[j][1];
      j++;
    }
    if (lastB && t - lastBt <= 120 * MIN) out.push([t, vA / lastB]);
  }
  return out;
}

/** Libellé lisible d'une fenêtre en minutes : 1440 → "24 h", 4320 → "3 j". */
export function windowLabel(minutes) {
  if (minutes >= 1440) {
    const days = minutes / 1440;
    return `${Number.isInteger(days) ? days : days.toFixed(1)} j`;
  }
  return `${Math.round(minutes / 60)} h`;
}

/** Tendance simple : SMA courte vs SMA longue (marge 0,2 %). */
export function trendOf(smaShort, smaLong) {
  if (smaShort === null || smaLong === null) return "stable";
  if (smaShort > smaLong * 1.002) return "hausse";
  if (smaShort < smaLong * 0.998) return "baisse";
  return "stable";
}

/**
 * Analyse une paire sur la série de son ratio.
 *
 * @param {Array<[number, number]>} ratioSeries  série [tMs, ratio] triée par temps
 * @param {{from: string, to: string, feePct: number}} pairCfg
 * @param {{smaShortMin, smaLongMin, zScoreTrigger, rsiPeriod, minNetGainPct,
 *          rsiOverbought, rsiOversold, maxDestDrop7dPct}} cfg
 * @param {number} now  timestamp ms
 * @param {Object<string, Array<[number, number]>>} coinSeries  prix par symbole,
 *        pour le garde-fou anti-effondrement (facultatif)
 * @returns {{indicators: object, signal: object|null}}
 *
 * Le signal indique le sens du switch avantageux :
 *  - ratio anormalement HAUT  (z-score >= seuil)  → `from` est cher relativement
 *    à `to` → switcher from → to.
 *  - ratio anormalement BAS   (z-score <= -seuil) → switcher to → from.
 *
 * Trois filtres doivent passer ensuite, dans cet ordre :
 *  1. rentabilité : gain net (écart au SMA long, frais déduits) >= minNetGainPct ;
 *  2. RSI : l'écart doit être confirmé par un excès (sur-achat dans le sens
 *     from → to, sur-vente dans l'autre) et pas par un simple bruit ;
 *  3. anti-effondrement : ne jamais basculer vers une crypto qui s'écroule sur
 *     7 jours — le retour à la moyenne suppose une anomalie, pas une chute durable.
 *
 * Quand un filtre bloque, indicators.rejected en donne la raison (utile pour
 * expliquer à l'utilisateur pourquoi rien ne se déclenche).
 */
export function analyzePair(ratioSeries, pairCfg, cfg, now = Date.now(), coinSeries = {}) {
  const empty = {
    indicators: { ratio: null, dataOk: false },
    signal: null,
  };
  if (!ratioSeries || ratioSeries.length < 5) return empty;

  const ratio = ratioSeries[ratioSeries.length - 1][1];
  const shortVals = windowValues(ratioSeries, cfg.smaShortMin, now);
  const longVals = windowValues(ratioSeries, cfg.smaLongMin, now);
  const smaShort = shortVals.length ? sma(shortVals, shortVals.length) : null;
  const { mean: smaLong, std } = meanStd(longVals);
  const rsiVal = rsi(ratioSeries.map(([, v]) => v), cfg.rsiPeriod);

  const indicators = {
    ratio,
    smaShort,
    smaLong,
    trend: trendOf(smaShort, smaLong),
    zScore: std ? (ratio - smaLong) / std : null,
    rsi: rsiVal,
    var15m: variationPct(ratioSeries, 15, now),
    var1h: variationPct(ratioSeries, 60, now),
    var24h: variationPct(ratioSeries, 1440, now),
    refLabel: windowLabel(cfg.smaLongMin),
    // Évolution propre de chaque crypto sur 7 j (garde-fou anti-effondrement).
    drop7dFrom: variationPct(coinSeries[pairCfg.from] || [], 7 * 1440, now),
    drop7dTo: variationPct(coinSeries[pairCfg.to] || [], 7 * 1440, now),
    // Fiable seulement avec assez d'historique pour la moyenne de référence.
    dataOk: longVals.length >= 12 && std !== null && std > 0,
    rejected: null,
  };

  let signal = null;
  if (indicators.dataOk && indicators.zScore !== null) {
    const fee = pairCfg.feePct ?? 0;
    const forward = indicators.zScore >= cfg.zScoreTrigger;
    const reverse = indicators.zScore <= -cfg.zScoreTrigger;

    if (forward || reverse) {
      const from = forward ? pairCfg.from : pairCfg.to;
      const to = forward ? pairCfg.to : pairCfg.from;
      const grossPct = forward ? (ratio / smaLong - 1) * 100 : (smaLong / ratio - 1) * 100;
      const netPct = grossPct - fee;

      // Filtre RSI : un ratio étiré doit l'être franchement. Sans RSI calculable
      // (historique trop court), on ne bloque pas.
      const rsiOk =
        rsiVal === null ||
        (forward
          ? rsiVal >= (cfg.rsiOverbought ?? 0)
          : rsiVal <= (cfg.rsiOversold ?? 100));

      // Garde-fou : la crypto d'arrivée ne doit pas s'effondrer sur 7 jours.
      const destDrop = forward ? indicators.drop7dTo : indicators.drop7dFrom;
      const maxDrop = cfg.maxDestDrop7dPct ?? Infinity;
      const dropOk = destDrop === null || destDrop > -maxDrop;

      if (netPct < cfg.minNetGainPct) indicators.rejected = "frais";
      else if (!rsiOk) indicators.rejected = "rsi";
      else if (!dropOk) indicators.rejected = "chute";
      else signal = makeSignal(from, to, indicators, grossPct, netPct, fee, destDrop);
    }
  }

  return { indicators, signal };
}

function makeSignal(from, to, ind, grossPct, netPct, feePct, destDrop7dPct = null) {
  return {
    from,
    to,
    ratio: ind.ratio,
    smaLong: ind.smaLong,
    zScore: ind.zScore,
    rsi: ind.rsi,
    grossGainPct: grossPct,
    netGainPct: netPct,
    feePct,
    refLabel: ind.refLabel,
    destDrop7dPct,
  };
}

/** Phrase expliquant pourquoi un écart détecté n'a pas donné de signal. */
export function rejectionReason(ind, pairCfg) {
  if (!ind?.rejected) return null;
  if (ind.rejected === "frais") return "écart trop faible pour couvrir les frais";
  if (ind.rejected === "rsi") return `écart non confirmé par le RSI (${Math.round(ind.rsi)})`;
  const forward = (ind.zScore ?? 0) > 0;
  const dest = forward ? pairCfg.to : pairCfg.from;
  const drop = forward ? ind.drop7dTo : ind.drop7dFrom;
  return `${dest} s'effondre (${drop.toFixed(0)} % sur 7 j) — bascule bloquée`;
}

const fmtPct = (v, digits = 1) =>
  v === null || v === undefined ? "?" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)} %`;

/** Message d'alerte lisible, identique côté bot (ntfy) et côté PWA. */
export function formatSignalMessage(signal) {
  const rsiTxt = signal.rsi === null ? "" : `, RSI ${Math.round(signal.rsi)}`;
  return (
    `Switch ${signal.from} → ${signal.to} recommandé — gain net estimé ` +
    `${fmtPct(signal.netGainPct)} (écart ${fmtPct(signal.grossGainPct)} vs moyenne ` +
    `${signal.refLabel ?? "24 h"}, frais ${signal.feePct} % déduits, ` +
    `z-score ${signal.zScore.toFixed(1)}${rsiTxt})`
  );
}

/**
 * Suivi d'un switch réellement effectué : que rapporterait le retour maintenant ?
 *
 * Référence = TA quantité de départ (pas la moyenne du marché) et TON taux
 * d'entrée réel (frais de l'exchange déjà compris dans qtyTo).
 *
 * @param {{from,to,qtyFrom,qtyTo}} pos  switch validé (donné qtyFrom, reçu qtyTo)
 * @param {number} priceFrom  prix actuel de la crypto de départ
 * @param {number} priceTo    prix actuel de la crypto reçue
 * @param {number} feePct     frais estimés du switch retour
 * @param {number} targetPct  gain minimum pour conseiller le retour
 * @returns {{qtyBack, profitPct, missingPct, ready}|null}
 */
export function positionReturn(pos, priceOrigin, priceCurrent, feePct, targetPct) {
  // Une position est une chaîne : mise d'origine (ce qu'on veut récupérer) et
  // crypto détenue aujourd'hui, après un ou plusieurs switchs successifs.
  const qtyOrigin = pos.qtyOrigin ?? pos.qtyFrom;
  const qtyCurrent = pos.qtyCurrent ?? pos.qtyTo;
  if (!priceOrigin || !priceCurrent || !qtyOrigin || !qtyCurrent) return null;
  // Reconvertir tout le montant détenu vers la crypto d'origine, frais déduits.
  const qtyBack = ((qtyCurrent * priceCurrent) / priceOrigin) * (1 - feePct / 100);
  const profitPct = (qtyBack / qtyOrigin - 1) * 100;
  return {
    qtyBack,
    profitPct,
    missingPct: targetPct - profitPct,
    ready: profitPct >= targetPct,
  };
}

/**
 * Gain hypothétique si l'alerte avait été suivie, au ratio actuel.
 * Après un switch from → to au ratio r0, revenir vers `from` au ratio actuel r
 * multiplie la quantité de `from` par r0 / r (avant frais du retour).
 */
export function hindsightGainPct(alertRatio, currentRatio, feePct = 0) {
  if (!alertRatio || !currentRatio) return null;
  return (alertRatio / currentRatio - 1) * 100 - feePct;
}
