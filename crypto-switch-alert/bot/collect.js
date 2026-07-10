// Bot de surveillance : exécuté par GitHub Actions toutes les ~5-15 min.
// 1. Récupère les prix CoinGecko (1 seul appel pour toutes les cryptos).
// 2. Met à jour docs/data/history.json (élagué + compacté).
// 3. Analyse chaque paire (module partagé docs/js/analysis.js).
// 4. Envoie une notification push via ntfy.sh si opportunité (env NTFY_TOPIC).
// 5. Enregistre l'alerte dans docs/data/alerts.json (avec anti-spam).
//
// Usage local :  node bot/collect.js          (sans notif si NTFY_TOPIC absent)
//                NTFY_TOPIC=mon-topic node bot/collect.js

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { buildRatioSeries, analyzePair, formatSignalMessage } from "../docs/js/analysis.js";

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

async function sendNtfy(topic, signal) {
  const message = formatSignalMessage(signal);
  const res = await fetchFn(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      Title: `Switch ${signal.from} -> ${signal.to} : ${signal.netGainPct >= 0 ? "+" : ""}${signal.netGainPct.toFixed(1)} %`,
      Priority: "high",
      Tags: "arrows_counterclockwise,chart_with_upwards_trend",
    },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
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

  for (const pair of config.pairs) {
    const sFrom = history.prices[pair.from];
    const sTo = history.prices[pair.to];
    if (!sFrom || !sTo) continue;
    const ratioSeries = buildRatioSeries(sFrom, sTo);
    const { indicators, signal } = analyzePair(ratioSeries, pair, config.analysis, now);
    const label = `${pair.from}/${pair.to}`;
    console.log(
      `${label}: ratio ${indicators.ratio?.toPrecision(5)} | z ${indicators.zScore?.toFixed(2) ?? "?"} | ` +
        `tendance ${indicators.trend ?? "?"} | ${signal ? "OPPORTUNITÉ" : "neutre"}`
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
  console.log("Données écrites dans docs/data/.");
}

main().catch((err) => {
  console.error(`Échec de la collecte : ${err.message}`);
  process.exit(1);
});
