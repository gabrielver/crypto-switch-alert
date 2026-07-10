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
 * @param {{smaShortMin, smaLongMin, zScoreTrigger, rsiPeriod, minNetGainPct}} cfg
 * @param {number} now  timestamp ms
 * @returns {{indicators: object, signal: object|null}}
 *
 * Le signal indique le sens du switch avantageux :
 *  - ratio anormalement HAUT  (z-score >= seuil)  → `from` est cher relativement
 *    à `to` → switcher from → to.
 *  - ratio anormalement BAS   (z-score <= -seuil) → switcher to → from.
 * Le gain net estimé (écart au SMA long, frais déduits) doit dépasser
 * minNetGainPct pour éviter les micro-mouvements absorbés par les frais.
 */
export function analyzePair(ratioSeries, pairCfg, cfg, now = Date.now()) {
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
    // Fiable seulement avec assez d'historique pour la moyenne de référence.
    dataOk: longVals.length >= 12 && std !== null && std > 0,
  };

  let signal = null;
  if (indicators.dataOk && indicators.zScore !== null) {
    const fee = pairCfg.feePct ?? 0;
    if (indicators.zScore >= cfg.zScoreTrigger) {
      const grossPct = (ratio / smaLong - 1) * 100;
      const netPct = grossPct - fee;
      if (netPct >= cfg.minNetGainPct) {
        signal = makeSignal(pairCfg.from, pairCfg.to, indicators, grossPct, netPct, fee);
      }
    } else if (indicators.zScore <= -cfg.zScoreTrigger) {
      const grossPct = (smaLong / ratio - 1) * 100;
      const netPct = grossPct - fee;
      if (netPct >= cfg.minNetGainPct) {
        signal = makeSignal(pairCfg.to, pairCfg.from, indicators, grossPct, netPct, fee);
      }
    }
  }

  return { indicators, signal };
}

function makeSignal(from, to, ind, grossPct, netPct, feePct) {
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
  };
}

const fmtPct = (v, digits = 1) =>
  v === null || v === undefined ? "?" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)} %`;

/** Message d'alerte lisible, identique côté bot (ntfy) et côté PWA. */
export function formatSignalMessage(signal) {
  const rsiTxt = signal.rsi === null ? "" : `, RSI ${Math.round(signal.rsi)}`;
  return (
    `Switch ${signal.from} → ${signal.to} recommandé — gain net estimé ` +
    `${fmtPct(signal.netGainPct)} (écart ${fmtPct(signal.grossGainPct)} vs moyenne 24 h, ` +
    `frais ${signal.feePct} % déduits, z-score ${signal.zScore.toFixed(1)}${rsiTxt})`
  );
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
