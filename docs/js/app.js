// Application principale : état, boucle de rafraîchissement et rendu des 4 vues.
// Les données viennent (1) des JSON commités par le bot GitHub Actions et
// (2) d'appels CoinGecko en direct pendant que l'app est ouverte. Sans bot
// (test local, avant déploiement), l'app se constitue son propre historique
// via CoinGecko et le garde en localStorage.

import {
  analyzePair,
  buildRatioSeries,
  formatSignalMessage,
  hindsightGainPct,
  sma,
  trendOf,
  windowValues,
} from "./analysis.js";
import { loadLocalJson, simplePrice, marketChart } from "./api.js";
import * as store from "./store.js";
import { drawChart } from "./chart.js";

const MIN = 60000;
const RANGES = { "24h": 24 * 60, "7j": 7 * 24 * 60, "30j": 30 * 24 * 60 };

const state = {
  config: null,
  settings: null,
  history: { updated: 0, prices: {} },
  live: {}, // symbol -> { usd, change24h }
  analyses: [], // [{ pair, feePct, ratioSeries, indicators, signal }]
  botAlerts: [],
  localAlerts: store.loadLocalAlerts(),
  usingLocalCache: false,
  view: "coins",
  range: "7j",
  error: null,
  lastRefresh: 0,
  timer: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtNum = new Intl.NumberFormat("fr-FR", { maximumSignificantDigits: 5 });
const fmtPrice = (v) => (v === null || v === undefined ? "?" : `${fmtNum.format(v)} $`);
const fmtRatio = (v) => (v === null || v === undefined ? "?" : fmtNum.format(v));
function fmtPct(v, digits = 1) {
  if (v === null || v === undefined) return "?";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits).replace(".", ",")} %`;
}
const pctClass = (v) => (v === null || v === undefined ? "flat" : v > 0.05 ? "up" : v < -0.05 ? "down" : "flat");

// ---------------------------------------------------------------- coins/pairs

function activeCoins() {
  const base = state.config.coins.filter((c) => !state.settings.hiddenSymbols.includes(c.symbol));
  return base.concat(state.settings.extraCoins);
}

function activePairs() {
  const pairs = state.config.pairs
    .filter(
      (p) =>
        !state.settings.hiddenSymbols.includes(p.from) &&
        !state.settings.hiddenSymbols.includes(p.to)
    )
    .map((p) => ({ ...p }));
  // Les cryptos ajoutées depuis l'app sont suivies contre USDC par défaut.
  const known = new Set(pairs.map((p) => `${p.from}/${p.to}`));
  for (const c of state.settings.extraCoins) {
    const key = `${c.symbol}/USDC`;
    if (c.symbol !== "USDC" && !known.has(key)) {
      pairs.push({ from: c.symbol, to: "USDC", feePct: state.settings.defaultFeePct });
    }
  }
  return pairs;
}

// --------------------------------------------------------------- data refresh

async function refresh() {
  state.error = null;
  const coins = activeCoins();
  try {
    const [botHistory, botAlerts, prices] = await Promise.all([
      loadLocalJson("data/history.json"),
      loadLocalJson("data/alerts.json"),
      simplePrice(coins.map((c) => c.id)).catch((e) => {
        state.error = `Prix en direct indisponibles (${e.message}) — nouvel essai au prochain cycle.`;
        return null;
      }),
    ]);

    if (botHistory && Object.keys(botHistory.prices || {}).length) {
      state.history = botHistory;
      state.usingLocalCache = false;
    } else {
      state.history = store.loadHistoryCache();
      state.usingLocalCache = true;
    }
    state.botAlerts = botAlerts?.alerts || [];

    // Bootstrap : toute crypto sans historique récupère ~30 j horaires.
    for (const coin of coins) {
      if (!state.history.prices[coin.symbol]?.length) {
        try {
          state.history.prices[coin.symbol] = await marketChart(coin.id, 30);
          await new Promise((r) => setTimeout(r, 1500)); // rate limit gratuit
        } catch {
          state.history.prices[coin.symbol] = state.history.prices[coin.symbol] || [];
        }
      }
    }

    // Point "en direct" ajouté à l'historique en mémoire.
    const now = Date.now();
    if (prices) {
      for (const coin of coins) {
        const p = prices[coin.id];
        if (!p?.usd) continue;
        state.live[coin.symbol] = { usd: p.usd, change24h: p.usd_24h_change ?? null };
        const series = state.history.prices[coin.symbol];
        if (!series.length || now - series[series.length - 1][0] > MIN) {
          series.push([now, p.usd]);
        }
      }
    }

    if (state.usingLocalCache) {
      const cutoff = now - (state.config.historyDays ?? 30) * 24 * 60 * MIN;
      for (const sym of Object.keys(state.history.prices)) {
        state.history.prices[sym] = state.history.prices[sym].filter(([t]) => t >= cutoff);
      }
      state.history.updated = now;
      store.saveHistoryCache(state.history);
    }

    computeAnalyses();
    maybeNotify();
    state.lastRefresh = now;
  } catch (err) {
    state.error = `Erreur de rafraîchissement : ${err.message}`;
  }
  render();
}

function analysisCfg() {
  return {
    ...state.config.analysis,
    zScoreTrigger: state.settings.zScoreTrigger,
    minNetGainPct: state.settings.minNetGainPct,
  };
}

function computeAnalyses() {
  const cfg = analysisCfg();
  state.analyses = activePairs().map((pair) => {
    const feePct = state.settings.fees[`${pair.from}/${pair.to}`] ?? pair.feePct;
    const ratioSeries = buildRatioSeries(
      state.history.prices[pair.from] || [],
      state.history.prices[pair.to] || []
    );
    const { indicators, signal } = analyzePair(ratioSeries, { ...pair, feePct }, cfg);
    return { pair, feePct, ratioSeries, indicators, signal };
  });
}

// Notifications dans l'app (API Notification) + journal local des alertes,
// en complément des push ntfy envoyées par le bot quand l'app est fermée.
function maybeNotify() {
  const cooldowns = store.loadNotifCooldowns();
  const now = Date.now();
  for (const a of state.analyses) {
    if (!a.signal) continue;
    const key = `${a.signal.from}->${a.signal.to}`;
    if (now - (cooldowns[key] || 0) < state.settings.cooldownMin * MIN) continue;
    cooldowns[key] = now;

    const message = formatSignalMessage(a.signal);
    state.localAlerts.unshift({
      id: `${now}-${key}`,
      t: now,
      from: a.signal.from,
      to: a.signal.to,
      ratio: a.signal.ratio,
      netGainPct: a.signal.netGainPct,
      feePct: a.signal.feePct,
      message,
      source: "app",
    });
    if (state.settings.notifyInApp && "Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(`Switch ${a.signal.from} → ${a.signal.to}`, {
          body: message,
          icon: "icons/icon-192.png",
        });
      } catch {
        /* certains Android n'autorisent que les notifications via service worker */
      }
    }
  }
  store.saveLocalAlerts(state.localAlerts);
  store.saveNotifCooldowns(cooldowns);
}

// -------------------------------------------------------------------- rendu

function render() {
  $("#updated").textContent = state.lastRefresh
    ? `màj ${new Date(state.lastRefresh).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`
    : "—";
  for (const section of document.querySelectorAll(".view")) section.classList.add("hidden");
  $(`#view-${state.view}`).classList.remove("hidden");
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === state.view);
  }
  ({ coins: renderCoins, pairs: renderPairs, alerts: renderAlerts, settings: renderSettings })[state.view]();
}

function errorBanner() {
  const parts = [];
  if (state.error) parts.push(`<div class="error-banner">${esc(state.error)}</div>`);
  if (state.usingLocalCache) {
    parts.push(
      `<p class="note">Mode local : historique constitué par l'app elle-même (le bot GitHub n'est pas encore déployé ou ses données sont inaccessibles).</p>`
    );
  }
  return parts.join("");
}

function coinTrend(symbol) {
  const series = state.history.prices[symbol] || [];
  const now = Date.now();
  const shortVals = windowValues(series, state.config.analysis.smaShortMin, now);
  const longVals = windowValues(series, state.config.analysis.smaLongMin, now);
  return trendOf(
    shortVals.length ? sma(shortVals, shortVals.length) : null,
    longVals.length ? sma(longVals, longVals.length) : null
  );
}

function renderCoins() {
  const rows = activeCoins()
    .map((coin) => {
      const live = state.live[coin.symbol];
      const series = state.history.prices[coin.symbol] || [];
      const price = live?.usd ?? (series.length ? series[series.length - 1][1] : null);
      const delta = live?.change24h ?? null;
      const trend = coinTrend(coin.symbol);
      const arrow = trend === "hausse" ? "↗" : trend === "baisse" ? "↘" : "→";
      const trendClass = trend === "hausse" ? "up" : trend === "baisse" ? "down" : "flat";
      return `<div class="card coin-row">
        <div>
          <div class="coin-name">${esc(coin.symbol)} <span class="${trendClass}">${arrow}</span></div>
          <div class="coin-sub">${esc(coin.name)} · tendance ${trend}</div>
        </div>
        <div class="coin-price">
          <div>${fmtPrice(price)}</div>
          <div class="coin-delta ${pctClass(delta)}">${fmtPct(delta)} / 24 h</div>
        </div>
      </div>`;
    })
    .join("");
  $("#view-coins").innerHTML = errorBanner() + (rows || `<p class="msg-empty">Aucune crypto suivie.</p>`);
}

/** Moyenne mobile glissante (fenêtre en minutes) — O(n), pour le graphique. */
function rollingSma(series, windowMin) {
  const out = [];
  let start = 0;
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i][1];
    while (series[start][0] < series[i][0] - windowMin * MIN) {
      sum -= series[start][1];
      start++;
    }
    out.push([series[i][0], sum / (i - start + 1)]);
  }
  return out;
}

function renderPairs() {
  const chips = Object.keys(RANGES)
    .map(
      (r) =>
        `<button class="chip-btn ${r === state.range ? "active" : ""}" data-range="${r}">${r}</button>`
    )
    .join("");

  const cards = state.analyses
    .map((a, idx) => {
      const ind = a.indicators;
      const badge = a.signal
        ? `<span class="badge badge-opp">🔔 Opportunité</span>`
        : `<span class="badge badge-neutral">Neutre</span>`;
      const signalLine = a.signal
        ? `<p class="signal-line up"><b>${esc(formatSignalMessage(a.signal))}</b></p>`
        : "";
      // Gain net estimé dans chaque sens si on switchait maintenant (frais déduits).
      let gainsLine = "";
      if (ind.dataOk && ind.smaLong) {
        const netFromTo = (ind.ratio / ind.smaLong - 1) * 100 - a.feePct;
        const netToFrom = (ind.smaLong / ind.ratio - 1) * 100 - a.feePct;
        gainsLine = `<span>${esc(a.pair.from)}→${esc(a.pair.to)} : <b class="${pctClass(netFromTo)}">${fmtPct(netFromTo)}</b></span>
          <span>${esc(a.pair.to)}→${esc(a.pair.from)} : <b class="${pctClass(netToFrom)}">${fmtPct(netToFrom)}</b></span>`;
      }
      return `<div class="card">
        <div class="pair-head">
          <h3>${esc(a.pair.from)} / ${esc(a.pair.to)}</h3>
          ${badge}
        </div>
        <div class="pair-stats">
          <span>Ratio <b>${fmtRatio(ind.ratio)}</b></span>
          <span>15 min <b class="${pctClass(ind.var15m)}">${fmtPct(ind.var15m)}</b></span>
          <span>1 h <b class="${pctClass(ind.var1h)}">${fmtPct(ind.var1h)}</b></span>
          <span>24 h <b class="${pctClass(ind.var24h)}">${fmtPct(ind.var24h)}</b></span>
          <span>z-score <b>${ind.zScore === null || ind.zScore === undefined ? "?" : ind.zScore.toFixed(2)}</b></span>
          <span>RSI <b>${ind.rsi === null || ind.rsi === undefined ? "?" : Math.round(ind.rsi)}</b></span>
          <span>tendance <b>${ind.trend ?? "?"}</b></span>
        </div>
        <div class="pair-stats">${gainsLine}</div>
        ${signalLine}
        <canvas class="chart" data-idx="${idx}"></canvas>
        <div class="legend">
          <span class="l1"><i></i>Ratio ${esc(a.pair.from)}/${esc(a.pair.to)}</span>
          <span class="l2"><i></i>Moyenne 24 h</span>
        </div>
      </div>`;
    })
    .join("");

  $("#view-pairs").innerHTML =
    errorBanner() +
    `<div class="range-row">${chips}</div>` +
    (cards || `<p class="msg-empty">Aucune paire surveillée.</p>`);

  for (const btn of document.querySelectorAll("#view-pairs [data-range]")) {
    btn.addEventListener("click", () => {
      state.range = btn.dataset.range;
      renderPairs();
    });
  }
  const cutoff = Date.now() - RANGES[state.range] * MIN;
  for (const canvas of document.querySelectorAll("#view-pairs canvas.chart")) {
    const a = state.analyses[Number(canvas.dataset.idx)];
    const smaFull = rollingSma(a.ratioSeries, state.config.analysis.smaLongMin);
    drawChart(
      canvas,
      a.ratioSeries.filter(([t]) => t >= cutoff),
      smaFull.filter(([t]) => t >= cutoff)
    );
  }
}

function renderAlerts() {
  const all = [...state.botAlerts.map((a) => ({ ...a, source: a.source || "bot" })), ...state.localAlerts]
    .sort((x, y) => y.t - x.t)
    .slice(0, 100);

  const currentRatio = {};
  for (const a of state.analyses) currentRatio[`${a.pair.from}/${a.pair.to}`] = a;

  const cards = all
    .map((alert) => {
      // Vérification a posteriori : que vaudrait l'aller-retour aujourd'hui ?
      const a =
        currentRatio[`${alert.from}/${alert.to}`] || currentRatio[`${alert.to}/${alert.from}`];
      let hindsight = "";
      if (a?.indicators?.ratio) {
        const inverted = !currentRatio[`${alert.from}/${alert.to}`];
        const alertRatio = inverted ? 1 / alert.ratio : alert.ratio;
        const nowRatio = inverted ? 1 / a.indicators.ratio : a.indicators.ratio;
        const g = hindsightGainPct(alertRatio, nowRatio, alert.feePct ?? 0);
        if (g !== null) {
          hindsight = `<div class="alert-hindsight">Si suivie puis inversée aujourd'hui : <b class="${pctClass(g)}">${fmtPct(g)}</b> (frais du retour déduits)</div>`;
        }
      }
      const when = new Date(alert.t).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `<div class="card">
        <div class="alert-time">${when}<span class="alert-source">${alert.source === "app" ? "app" : "bot"}</span></div>
        <div class="alert-msg">${esc(alert.message)}</div>
        ${hindsight}
      </div>`;
    })
    .join("");

  $("#view-alerts").innerHTML =
    errorBanner() +
    (cards ||
      `<p class="msg-empty">Aucune alerte pour l'instant.<br>Elles apparaîtront ici dès qu'un switch avantageux sera détecté.</p>`);
}

function renderSettings() {
  const s = state.settings;
  const feeInputs = activePairs()
    .map((p) => {
      const key = `${p.from}/${p.to}`;
      return `<div><label>Frais ${esc(key)} (%)</label>
        <input type="number" step="0.1" min="0" data-fee="${esc(key)}" value="${s.fees[key] ?? p.feePct}"></div>`;
    })
    .join("");

  const coinRows = state.config.coins
    .map((c) => {
      const hidden = s.hiddenSymbols.includes(c.symbol);
      return `<div class="coin-manage"><span>${esc(c.symbol)} — ${esc(c.name)}</span>
        <button class="btn btn-ghost btn-sm" data-toggle-coin="${esc(c.symbol)}">${hidden ? "Afficher" : "Masquer"}</button></div>`;
    })
    .concat(
      s.extraCoins.map(
        (c) => `<div class="coin-manage"><span>${esc(c.symbol)} — ${esc(c.name)} <span class="alert-source">ajoutée</span></span>
        <button class="btn btn-ghost btn-sm" data-remove-coin="${esc(c.symbol)}">Retirer</button></div>`
      )
    )
    .join("");

  const notifState =
    !("Notification" in window) ? "non supportées sur ce navigateur"
    : Notification.permission === "granted" ? "activées"
    : Notification.permission === "denied" ? "refusées (à réactiver dans les réglages Android du site)"
    : "à autoriser";

  $("#view-settings").innerHTML = `
    <div class="card settings-group">
      <h3>Rafraîchissement &amp; seuils (vue en direct)</h3>
      <div class="settings-inline">
        <div><label>Intervalle PWA (min)</label>
          <input type="number" id="set-interval" min="1" max="60" step="1" value="${s.pwaMin}"></div>
        <div><label>Seuil z-score</label>
          <input type="number" id="set-zscore" min="0.5" max="5" step="0.1" value="${s.zScoreTrigger}"></div>
      </div>
      <div class="settings-inline">
        <div><label>Gain net minimum (%)</label>
          <input type="number" id="set-mingain" min="0" step="0.1" value="${s.minNetGainPct}"></div>
        <div><label>Anti-spam (min entre alertes)</label>
          <input type="number" id="set-cooldown" min="5" step="5" value="${s.cooldownMin}"></div>
      </div>
      ${feeInputs}
      <button class="btn" id="save-settings">Enregistrer</button>
      <p class="note">Ces réglages s'appliquent à l'app. Le bot d'arrière-plan (alertes ntfy quand
      l'app est fermée) lit <b>docs/config.json</b> dans le repo GitHub : modifie ce fichier
      directement sur github.com pour changer ses seuils.</p>
    </div>

    <div class="card settings-group">
      <h3>Cryptos suivies</h3>
      ${coinRows}
      <div class="settings-inline" style="margin-top:10px">
        <div><label>Id CoinGecko</label><input id="add-coin-id" placeholder="ex : solana"></div>
        <div><label>Symbole</label><input id="add-coin-symbol" placeholder="ex : SOL"></div>
      </div>
      <button class="btn btn-ghost" id="add-coin-btn">Ajouter (suivie contre USDC)</button>
      <p class="note">L'id exact se trouve dans l'URL de la crypto sur coingecko.com.
      Pour que le <b>bot</b> la surveille aussi, ajoute-la dans docs/config.json.</p>
    </div>

    <div class="card settings-group">
      <h3>Notifications</h3>
      <p class="note" style="margin-top:0">Notifications dans l'app : ${notifState}.</p>
      <button class="btn btn-ghost" id="notif-btn">Autoriser les notifications</button>
      <p class="note">Les alertes quand l'app est <b>fermée</b> passent par l'app gratuite
      <b>ntfy</b> (voir le README, section notifications).</p>
    </div>`;

  $("#save-settings").addEventListener("click", () => {
    s.pwaMin = Math.max(1, Number($("#set-interval").value) || 2);
    s.zScoreTrigger = Number($("#set-zscore").value) || 2;
    s.minNetGainPct = Number($("#set-mingain").value) || 0;
    s.cooldownMin = Math.max(5, Number($("#set-cooldown").value) || 240);
    for (const input of document.querySelectorAll("[data-fee]")) {
      s.fees[input.dataset.fee] = Number(input.value) || 0;
    }
    store.saveSettings(s);
    scheduleTimer();
    computeAnalyses();
    render();
  });

  $("#add-coin-btn").addEventListener("click", async () => {
    const id = $("#add-coin-id").value.trim().toLowerCase();
    const symbol = $("#add-coin-symbol").value.trim().toUpperCase();
    if (!id || !symbol) return;
    if (activeCoins().some((c) => c.symbol === symbol)) return;
    s.extraCoins.push({ id, symbol, name: symbol });
    store.saveSettings(s);
    await refresh();
    state.view = "settings";
    render();
  });

  for (const btn of document.querySelectorAll("[data-toggle-coin]")) {
    btn.addEventListener("click", () => {
      const sym = btn.dataset.toggleCoin;
      const i = s.hiddenSymbols.indexOf(sym);
      if (i >= 0) s.hiddenSymbols.splice(i, 1);
      else s.hiddenSymbols.push(sym);
      store.saveSettings(s);
      computeAnalyses();
      render();
    });
  }
  for (const btn of document.querySelectorAll("[data-remove-coin]")) {
    btn.addEventListener("click", () => {
      s.extraCoins = s.extraCoins.filter((c) => c.symbol !== btn.dataset.removeCoin);
      store.saveSettings(s);
      computeAnalyses();
      render();
    });
  }
  $("#notif-btn").addEventListener("click", async () => {
    if ("Notification" in window) await Notification.requestPermission();
    render();
  });
}

// ------------------------------------------------------------------- boot

function scheduleTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(refresh, state.settings.pwaMin * MIN);
}

async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  const res = await fetch("config.json");
  state.config = await res.json();
  state.settings = store.loadSettings(state.config);

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      render();
    });
  }
  $("#refresh-btn").addEventListener("click", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - state.lastRefresh > state.settings.pwaMin * MIN) {
      refresh();
    }
  });

  render();
  await refresh();
  scheduleTimer();
}

boot().catch((err) => {
  document.getElementById("main").innerHTML =
    `<div class="error-banner">Impossible de démarrer : ${esc(err.message)}</div>`;
});
