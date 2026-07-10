// Tests légers du module d'analyse avec des séries synthétiques.
// Usage : node bot/test-analysis.js

import {
  analyzePair,
  buildRatioSeries,
  rsi,
  hindsightGainPct,
  formatSignalMessage,
} from "../docs/js/analysis.js";

const MIN = 60 * 1000;
let failures = 0;

function check(name, cond) {
  console.log(`${cond ? "OK " : "ÉCHEC"} - ${name}`);
  if (!cond) failures++;
}

const cfg = {
  smaShortMin: 60,
  smaLongMin: 1440,
  zScoreTrigger: 2.0,
  rsiPeriod: 14,
  minNetGainPct: 1.0,
};
const pair = { from: "GST", to: "GMT", feePct: 2.0 };
const now = Date.now();

/** Série de ratio : 24 h de points toutes les 5 min autour de `base` avec un léger bruit déterministe. */
function flatSeries(base, noisePct = 0.3) {
  const out = [];
  for (let i = 288; i >= 0; i--) {
    const t = now - i * 5 * MIN;
    const noise = Math.sin(i * 1.7) * (noisePct / 100) * base;
    out.push([t, base + noise]);
  }
  return out;
}

// 1. Série stable → aucun signal.
{
  const { indicators, signal } = analyzePair(flatSeries(2.0), pair, cfg, now);
  check("série stable : pas de signal", signal === null);
  check("série stable : données suffisantes", indicators.dataOk === true);
  check("série stable : tendance stable", indicators.trend === "stable");
}

// 2. Pic net (+8 % sur la dernière heure) → signal from→to avec gain net > 0.
{
  const s = flatSeries(2.0);
  for (let i = s.length - 12; i < s.length; i++) {
    const progress = (i - (s.length - 12)) / 11;
    s[i][1] = 2.0 * (1 + 0.08 * progress);
  }
  const { indicators, signal } = analyzePair(s, pair, cfg, now);
  check("pic +8 % : signal déclenché", signal !== null);
  check("pic +8 % : sens GST → GMT", signal?.from === "GST" && signal?.to === "GMT");
  check("pic +8 % : gain net > 1 % (frais 2 % déduits)", (signal?.netGainPct ?? 0) > 1);
  check("pic +8 % : z-score au-dessus du seuil", (indicators.zScore ?? 0) >= 2);
  if (signal) console.log(`     message : ${formatSignalMessage(signal)}`);
}

// 3. Creux net (-8 %) → signal inverse to→from.
{
  const s = flatSeries(2.0);
  for (let i = s.length - 12; i < s.length; i++) {
    const progress = (i - (s.length - 12)) / 11;
    s[i][1] = 2.0 * (1 - 0.08 * progress);
  }
  const { signal } = analyzePair(s, pair, cfg, now);
  check("creux -8 % : signal inverse GMT → GST", signal?.from === "GMT" && signal?.to === "GST");
}

// 4. Micro-mouvement (+1,5 %) absorbé par les frais (2 %) → pas de signal.
{
  const s = flatSeries(2.0, 0.05);
  for (let i = s.length - 12; i < s.length; i++) s[i][1] = 2.0 * 1.015;
  const { indicators, signal } = analyzePair(s, pair, cfg, now);
  check(
    "micro-mouvement +1,5 % < frais : pas de signal malgré z-score élevé",
    signal === null && Math.abs(indicators.zScore ?? 0) >= 2
  );
}

// 5. Historique trop court → dataOk false, pas de signal.
{
  const s = flatSeries(2.0).slice(-6);
  const { indicators, signal } = analyzePair(s, pair, cfg, now);
  check("historique court : pas de signal", signal === null && indicators.dataOk === false);
}

// 6. buildRatioSeries aligne des séries décalées.
{
  const a = [[now - 10 * MIN, 4], [now - 5 * MIN, 6], [now, 8]];
  const b = [[now - 11 * MIN, 2], [now - 6 * MIN, 2], [now - 1 * MIN, 2]];
  const r = buildRatioSeries(a, b);
  check(
    "buildRatioSeries : ratios corrects",
    r.length === 3 && r[0][1] === 2 && r[2][1] === 4
  );
}

// 7. RSI bornes : hausse continue → proche de 100.
{
  const up = Array.from({ length: 20 }, (_, i) => 1 + i * 0.01);
  check("RSI hausse continue = 100", rsi(up, 14) === 100);
  check("RSI série trop courte = null", rsi([1, 2, 3], 14) === null);
}

// 8. Gain a posteriori : switch à ratio 2,2 ; retour à 2,0 → ~+10 % avant frais.
{
  const g = hindsightGainPct(2.2, 2.0, 2.0);
  check("hindsight : +8 % net (10 % - 2 % de frais)", Math.abs(g - 8) < 0.01);
}

console.log(failures === 0 ? "\nTous les tests passent." : `\n${failures} test(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
