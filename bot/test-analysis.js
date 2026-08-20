// Tests légers du module d'analyse avec des séries synthétiques.
// Usage : node bot/test-analysis.js

import {
  analyzePair,
  buildRatioSeries,
  rsi,
  hindsightGainPct,
  positionReturn,
  rejectionReason,
  windowLabel,
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
  rsiOverbought: 65,
  rsiOversold: 35,
  maxDestDrop7dPct: 25,
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

// 9. Suivi de position : switch 1000 GST (0,001 $) → 130 GMT (0,0077 $).
{
  const pos = { from: "GST", to: "GMT", qtyFrom: 1000, qtyTo: 130 };
  // Prix inchangés : le retour reperd les frais → perte, pas de re-switch conseillé.
  const flat = positionReturn(pos, 0.001, 0.0077, 2, 1);
  check("position à prix inchangés : perte, pas prête", !flat.ready && flat.profitPct < 0);

  // GMT monte de 10 % face au GST → retour gagnant.
  const up = positionReturn(pos, 0.001, 0.00847, 2, 1);
  check("position GMT +10 % : prête à re-switcher", up.ready && up.profitPct > 6);
  check("position GMT +10 % : quantité rendue > départ", up.qtyBack > pos.qtyFrom);

  // Objectif à 20 % : pas encore atteint, manque bien la différence.
  const strict = positionReturn(pos, 0.001, 0.00847, 2, 20);
  check(
    "objectif 20 % : pas prête, manque calculé",
    !strict.ready && Math.abs(strict.missingPct - (20 - up.profitPct)) < 0.001
  );

  check("position sans prix : null", positionReturn(pos, 0, 0.0077, 2, 1) === null);
}

// 10. Filtre RSI : un écart installé mais sans excès de momentum est écarté.
{
  const s = flatSeries(2.0);
  // Plateau haut qui oscille : z-score très élevé, mais RSI ~50 (ni sur-achat ni
  // sur-vente) — l'écart n'est pas confirmé, on ne switche pas.
  for (let i = s.length - 20; i < s.length; i++) s[i][1] = 2.18 * (1 + (i % 2 ? 0.0005 : -0.0005));
  const { indicators, signal } = analyzePair(s, pair, cfg, now);
  check(
    "RSI tiède malgré z-score élevé : signal filtré",
    signal === null &&
      indicators.rejected === "rsi" &&
      indicators.zScore > cfg.zScoreTrigger &&
      indicators.rsi < cfg.rsiOverbought
  );
  check("raison lisible pour le RSI", /RSI/.test(rejectionReason(indicators, pair)));

  // Même niveau de ratio, mais atteint par une vraie poussée → RSI élevé, ça passe.
  const pushed = flatSeries(2.0);
  for (let i = pushed.length - 20; i < pushed.length; i++) {
    pushed[i][1] = 2.0 * (1 + 0.09 * ((i - (pushed.length - 21)) / 20));
  }
  const r2 = analyzePair(pushed, pair, cfg, now);
  check("poussée franche : RSI confirme, signal conservé", r2.signal !== null && r2.indicators.rsi >= cfg.rsiOverbought);
}

// 11. Garde-fou anti-effondrement : ne pas basculer vers une crypto qui s'écroule.
{
  const s = flatSeries(2.0);
  for (let i = s.length - 12; i < s.length; i++) {
    const p = (i - (s.length - 12)) / 11;
    s[i][1] = 2.0 * (1 + 0.08 * p);
  }
  // GMT (destination) perd 40 % en 7 jours.
  const crash = [];
  for (let i = 7 * 24; i >= 0; i--) {
    crash.push([now - i * 60 * MIN, 1 * (1 - 0.4 * ((7 * 24 - i) / (7 * 24)))]);
  }
  const stable = [[now - 7 * 24 * 60 * MIN, 1], [now, 1]];

  const blocked = analyzePair(s, pair, cfg, now, { GST: stable, GMT: crash });
  check(
    "destination en chute : signal bloqué",
    blocked.signal === null && blocked.indicators.rejected === "chute"
  );
  check("raison lisible pour la chute", /effondre/.test(rejectionReason(blocked.indicators, pair)));

  // Même écart, destination saine → le signal passe.
  const ok = analyzePair(s, pair, cfg, now, { GST: stable, GMT: stable });
  check("destination saine : signal conservé", ok.signal !== null);
  check("pas de blocage sans données de prix", analyzePair(s, pair, cfg, now).signal !== null);
}

// 12. Fenêtre de référence configurable, reflétée dans les messages.
{
  const longCfg = { ...cfg, smaLongMin: 4320 };
  const s = [];
  for (let i = 3 * 24 * 12; i >= 0; i--) s.push([now - i * 5 * MIN, 2.0 + Math.sin(i * 1.7) * 0.006]);
  for (let i = s.length - 12; i < s.length; i++) s[i][1] = 2.0 * 1.08;
  const { indicators, signal } = analyzePair(s, pair, longCfg, now);
  check("fenêtre 3 j : libellé propagé", indicators.refLabel === "3 j" && signal?.refLabel === "3 j");
  check("message reprend la fenêtre", formatSignalMessage(signal).includes("moyenne 3 j"));
  check("windowLabel : 1440 → 24 h", windowLabel(1440) === "1 j" || windowLabel(1440) === "24 h");
  check("windowLabel : 10080 → 7 j", windowLabel(10080) === "7 j");
}

console.log(failures === 0 ? "\nTous les tests passent." : `\n${failures} test(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
