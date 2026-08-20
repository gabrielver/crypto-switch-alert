// Bot de surveillance : exécuté par GitHub Actions toutes les ~5-15 min.
// 1. Récupère les prix CoinGecko (1 seul appel pour toutes les cryptos).
// 2. Met à jour docs/data/history.json (élagué + compacté).
// 3. Analyse chaque paire (module partagé docs/js/analysis.js).
// 4. Envoie une notification push via ntfy.sh si opportunité (env NTFY_TOPIC).
// 5. Enregistre l'alerte dans docs/data/alerts.json (avec anti-spam).
// 6. Récupère les switchs en cours publiés chiffrés par la PWA et alerte quand
//    leur retour devient gagnant — c'est ce qui marche app fermée.
//
// Usage local :  node bot/collect.js          (sans notif si NTFY_TOPIC absent)
//                NTFY_TOPIC=mon-topic node bot/collect.js

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

// vault.js utilise l'API WebCrypto du navigateur : la fournir avant son import.
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const { buildRatioSeries, analyzePair, formatSignalMessage, positionReturn, rejectionReason } =
  await import("../docs/js/analysis.js");
const { unseal, positionsTopic } = await import("../docs/js/vault.js");

// fetch natif à partir de Node 18 ; repli https pour les Node plus anciens en local.
const fetchFn =
  globalThis.fetch ??
  function (url, options = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        { method: options.method || "GET", headers: options.headers },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              json: async () => JSON.parse(body),
              text: async () => body,
            })
          );
        }
      );
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "docs", "config.json");
const HISTORY_PATH = path.join(ROOT, "docs", "data", "history.json");
const ALERTS_PATH = path.join(ROOT, "docs", "data", "alerts.json");
// Positions de l'utilisateur : stockées chiffrées, jamais en clair dans le repo.
const POSITIONS_PATH = path.join(ROOT, "docs", "data", "positions.json");

const MIN = 60 * 1000;
const API = "https://api.coingecko.com/api/v3";
const MAX_ALERTS_KEPT = 300;
// Au-delà de 48 h, l'historique est compacté en points de 30 min.
const FULL_RES_HOURS = 48;
const BUCKET_MIN = 30;

// Le replace enlève un éventuel BOM UTF-8 (fichiers édités sous Windows).
function parseJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

function readJson(file, fallback) {
  try {
    return parseJsonFile(file);
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

async function fetchJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetchFn(url, {
        // CoinGecko refuse (403) les requêtes sans User-Agent.
        headers: { accept: "application/json", "user-agent": "crypto-switch-alert/1.0" },
      });
      if (res.status === 429) throw new Error("rate limit CoinGecko (429)");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries) throw err;
      const wait = 15000 * i;
      console.warn(`Tentative ${i} échouée (${err.message}), nouvel essai dans ${wait / 1000} s…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Premier lancement : récupère ~30 jours d'historique horaire pour une crypto. */
async function bootstrapCoin(coin) {
  console.log(`Bootstrap de l'historique ${coin.symbol} (30 j horaires)…`);
  const data = await fetchJson(
    `${API}/coins/${coin.id}/market_chart?vs_currency=usd&days=30`
  );
  return (data.prices || []).map(([t, v]) => [Math.round(t), v]);
}

/** Élague au-delà de historyDays et compacte les vieux points en buckets de 30 min. */
function pruneSeries(series, now, historyDays) {
  const cutoff = now - historyDays * 24 * 60 * MIN;
  const fullResCutoff = now - FULL_RES_HOURS * 60 * MIN;
  const out = [];
  let lastBucket = -1;
  for (const [t, v] of series) {
    if (t < cutoff) continue;
    if (t < fullResCutoff) {
      const bucket = Math.floor(t / (BUCKET_MIN * MIN));
      if (bucket === lastBucket) out[out.length - 1] = [t, v];
      else out.push([t, v]);
      lastBucket = bucket;
    } else {
      out.push([t, v]);
    }
  }
  return out;
}

async function pushNtfy(topic, title, message, tags = "arrows_counterclockwise") {
  const res = await fetchFn(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: { Title: title, Priority: "high", Tags: tags },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

const signedPct = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} %`;

function sendNtfy(topic, signal) {
  return pushNtfy(
    topic,
    `Switch ${signal.from} -> ${signal.to} : ${signedPct(signal.netGainPct)}`,
    formatSignalMessage(signal),
    "arrows_counterclockwise,chart_with_upwards_trend"
  );
}

/**
 * Récupère les switchs en cours publiés chiffrés par la PWA sur son canal dérivé.
 * Le dépôt du repo (chiffré) fait foi si aucun message récent n'est disponible :
 * ntfy ne garde ses messages que quelques heures, le repo garde la position.
 */
async function loadPositions(topic, now) {
  const stored = readJson(POSITIONS_PATH, null);
  let best = stored?.blob ? { blob: stored.blob, t: stored.updated || 0 } : null;

  try {
    const channel = await positionsTopic(topic);
    const res = await fetchFn(`https://ntfy.sh/${channel}/json?poll=1&since=12h`, {
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const raw = await res.text();
      for (const line of raw.trim().split("\n").filter(Boolean)) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!msg.message) continue;
        const payload = await unseal(msg.message, topic);
        // Un message qu'on ne sait pas déchiffrer n'est pas pour nous : on l'ignore.
        if (payload?.t && payload.t > (best?.t || 0)) best = { blob: msg.message, t: payload.t };
      }
    }
  } catch (err) {
    console.warn(`Canal des positions injoignable (${err.message}) — dépôt du repo utilisé.`);
  }

  if (!best) return { payload: null, blob: null, updated: 0 };
  const payload = await unseal(best.blob, topic);
  if (!payload) {
    console.warn("Positions illisibles (topic différent de celui de l'app ?) — ignorées.");
    return { payload: null, blob: null, updated: 0 };
  }
  console.log(
    `Positions reçues de l'app : ${payload.positions?.length || 0} en cours ` +
      `(publiées il y a ${Math.round((now - payload.t) / MIN)} min).`
  );
  return { payload, blob: best.blob, updated: best.t };
}

/**
 * Alerte quand le retour d'un switch validé redevient gagnant vs la quantité de
 * départ. Les messages ne contiennent que des pourcentages : aucun montant ne
 * transite en clair par ntfy.
 */
async function checkPositions(payload, priceOf, config, alertsDb, topic, now) {
  const target = payload.minReturnGainPct ?? config.analysis.minNetGainPct;
  const engaged = new Set();
  for (const pos of payload.positions || []) {
    engaged.add(pos.from).add(pos.to);
    const feePct =
      config.pairs.find(
        (p) =>
          (p.from === pos.from && p.to === pos.to) || (p.from === pos.to && p.to === pos.from)
      )?.feePct ?? 2;
    const st = positionReturn(pos, priceOf(pos.from), priceOf(pos.to), feePct, target);
    if (!st) continue;
    console.log(
      `Position ${pos.from}->${pos.to} : retour ${signedPct(st.profitPct)} ` +
        `(objectif ${signedPct(target)}) ${st.ready ? "PRÊTE" : "en attente"}`
    );
    if (!st.ready) continue;

    const key = `return-${pos.id}`;
    if (now - (alertsDb.cooldowns[key] || 0) < config.analysis.cooldownMin * MIN) continue;
    alertsDb.cooldowns[key] = now;

    const message =
      `Re-switch ${pos.to} → ${pos.from} : ${signedPct(st.profitPct)} vs ton entrée, ` +
      `frais du retour déduits. Ouvre l'app pour les montants.`;
    alertsDb.alerts.unshift({
      id: `${now}-${key}`,
      t: now,
      from: pos.to,
      to: pos.from,
      netGainPct: st.profitPct,
      message,
      source: "bot-position",
    });
    if (topic) {
      try {
        await pushNtfy(
          topic,
          `Re-switch ${pos.to} -> ${pos.from} : ${signedPct(st.profitPct)}`,
          message,
          "moneybag"
        );
        console.log("  Notification de retour envoyée.");
      } catch (err) {
        console.error(`  Échec envoi ntfy : ${err.message}`);
      }
    }
  }
  return engaged;
}

async function main() {
  const now = Date.now();
  const config = parseJsonFile(CONFIG_PATH);
  const history = readJson(HISTORY_PATH, { updated: 0, prices: {} });
  const alertsDb = readJson(ALERTS_PATH, { alerts: [], cooldowns: {} });

  // Bootstrap pour toute crypto sans historique (nouvelle entrée dans config.json).
  for (const coin of config.coins) {
    if (!history.prices[coin.symbol] || history.prices[coin.symbol].length === 0) {
      history.prices[coin.symbol] = await bootstrapCoin(coin);
      await new Promise((r) => setTimeout(r, 3000)); // ménage le rate limit gratuit
    }
  }

  // Prix actuels : un seul appel pour toutes les cryptos.
  const ids = config.coins.map((c) => c.id).join(",");
  const prices = await fetchJson(`${API}/simple/price?ids=${ids}&vs_currencies=usd`);
  for (const coin of config.coins) {
    const usd = prices[coin.id]?.usd;
    if (usd === undefined) {
      console.warn(`Pas de prix pour ${coin.symbol} (id CoinGecko "${coin.id}") — vérifier config.json`);
      continue;
    }
    history.prices[coin.symbol].push([now, usd]);
    console.log(`${coin.symbol}: ${usd} $`);
  }

  for (const symbol of Object.keys(history.prices)) {
    history.prices[symbol] = pruneSeries(history.prices[symbol], now, config.historyDays);
  }
  history.updated = now;

  // Analyse de chaque paire + alertes.
  const topic = process.env.NTFY_TOPIC;
  if (!topic) console.log("NTFY_TOPIC absent : analyse sans notification push.");

  // Switchs en cours de l'utilisateur : ils passent avant les signaux de marché.
  const priceOf = (symbol) => {
    const series = history.prices[symbol];
    return series?.length ? series[series.length - 1][1] : null;
  };
  let engaged = new Set();
  let positionsBlob = null;
  if (topic) {
    const { payload, blob, updated } = await loadPositions(topic, now);
    if (payload) {
      positionsBlob = { blob, updated };
      engaged = await checkPositions(payload, priceOf, config, alertsDb, topic, now);
    }
  }

  for (const pair of config.pairs) {
    // Crypto déjà engagée dans un switch : c'est son retour qui compte, pas le marché.
    if (engaged.has(pair.from) || engaged.has(pair.to)) {
      console.log(`${pair.from}/${pair.to}: ignorée (position en cours)`);
      continue;
    }
    const sFrom = history.prices[pair.from];
    const sTo = history.prices[pair.to];
    if (!sFrom || !sTo) continue;
    const ratioSeries = buildRatioSeries(sFrom, sTo);
    const { indicators, signal } = analyzePair(
      ratioSeries,
      pair,
      config.analysis,
      now,
      history.prices // garde-fou anti-effondrement sur 7 j
    );
    const label = `${pair.from}/${pair.to}`;
    const reason = rejectionReason(indicators, pair);
    console.log(
      `${label}: ratio ${indicators.ratio?.toPrecision(5)} | z ${indicators.zScore?.toFixed(2) ?? "?"} | ` +
        `RSI ${indicators.rsi === null ? "?" : Math.round(indicators.rsi)} | ` +
        `tendance ${indicators.trend ?? "?"} | ` +
        `${signal ? "OPPORTUNITÉ" : reason ? `filtré (${reason})` : "neutre"}`
    );
    if (!signal) continue;

    // Anti-spam : cooldown par sens de switch.
    const key = `${signal.from}->${signal.to}`;
    const last = alertsDb.cooldowns[key] || 0;
    if (now - last < config.analysis.cooldownMin * MIN) {
      console.log(`  (cooldown actif pour ${key}, pas de nouvelle alerte)`);
      continue;
    }

    const alert = {
      id: `${now}-${key}`,
      t: now,
      from: signal.from,
      to: signal.to,
      ratio: signal.ratio,
      netGainPct: signal.netGainPct,
      grossGainPct: signal.grossGainPct,
      feePct: signal.feePct,
      zScore: signal.zScore,
      rsi: signal.rsi,
      message: formatSignalMessage(signal),
    };
    alertsDb.alerts.unshift(alert);
    alertsDb.cooldowns[key] = now;
    console.log(`  ALERTE : ${alert.message}`);

    if (topic) {
      try {
        await sendNtfy(topic, signal);
        console.log("  Notification ntfy envoyée.");
      } catch (err) {
        console.error(`  Échec envoi ntfy : ${err.message}`);
      }
    }
  }

  alertsDb.alerts = alertsDb.alerts.slice(0, MAX_ALERTS_KEPT);
  writeJson(HISTORY_PATH, history);
  writeJson(ALERTS_PATH, alertsDb);
  // Positions re-stockées telles quelles (chiffrées) : le repo sert de mémoire
  // longue durée, ntfy n'ayant qu'un cache de quelques heures.
  if (positionsBlob) {
    writeJson(POSITIONS_PATH, { updated: positionsBlob.updated, blob: positionsBlob.blob });
  }
  console.log("Données écrites dans docs/data/.");
}

main().catch((err) => {
  console.error(`Échec de la collecte : ${err.message}`);
  process.exit(1);
});
