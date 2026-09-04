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
  positionReturn,
  rejectionReason,
  sma,
  trendOf,
  windowValues,
} from "./analysis.js";
import { loadLocalJson, simplePrice, marketChart } from "./api.js";
import { seal, positionsTopic } from "./vault.js";
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
  positions: store.loadPositions(),
  form: null, // { mode: "open"|"close", from, to, id?, qtyFrom?, qtyTo? }
  syncMsg: "",
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
const fmtQtyNum = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 });
const fmtQty = (v) => (v >= 1 ? fmtQtyNum.format(v) : fmtNum.format(v));
const fmtRatio = (v) => (v === null || v === undefined ? "?" : fmtNum.format(v));
function fmtPct(v, digits = 1) {
  if (v === null || v === undefined) return "?";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits).replace(".", ",")} %`;
}
/** "YYYY-MM-DDTHH:mm" local, format attendu par <input type="datetime-local">. */
function localNow(ms = Date.now()) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fmtWhen = (ms) =>
  new Date(ms).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

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
    publishPositions(); // no-op si rien n'a changé depuis la dernière publication
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
    const { indicators, signal } = analyzePair(
      ratioSeries,
      { ...pair, feePct },
      cfg,
      Date.now(),
      state.history.prices // garde-fou anti-effondrement sur 7 j
    );
    return { pair, feePct, ratioSeries, indicators, signal };
  });
}

// Notifications dans l'app (API Notification) + journal local des alertes,
// en complément des push ntfy envoyées par le bot quand l'app est fermée.
function maybeNotify() {
  const cooldowns = store.loadNotifCooldowns();
  const now = Date.now();

  // Priorité : boucler un switch déjà fait (référence = ta quantité de départ).
  for (const pos of openPositions()) {
    const st = posStatus(pos);
    if (!st?.ready) continue;
    const key = `return-${pos.id}`;
    if (now - (cooldowns[key] || 0) < state.settings.cooldownMin * MIN) continue;
    cooldowns[key] = now;
    const message =
      `Re-switch ${pos.current} → ${pos.origin} : ${fmtQty(st.qtyBack)} ${pos.origin} récupérés ` +
      `contre ${fmtQty(pos.qtyOrigin)} investis (${fmtPct(st.profitPct)}, frais déduits)`;
    state.localAlerts.unshift({
      id: `${now}-${key}`,
      t: now,
      from: pos.current,
      to: pos.origin,
      netGainPct: st.profitPct,
      message,
      source: "app",
    });
    notify(`Re-switch ${pos.current} → ${pos.origin}`, message);
  }

  for (const a of state.analyses) {
    if (!a.signal) continue;
    // Une position déjà ouverte sur cette crypto : c'est son retour qui compte.
    if (openPositions().some((p) => p.current === a.signal.from)) continue;
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
    notify(`Switch ${a.signal.from} → ${a.signal.to}`, message);
  }
  store.saveLocalAlerts(state.localAlerts);
  store.saveNotifCooldowns(cooldowns);
}

function notify(title, body) {
  if (!state.settings.notifyInApp || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, icon: "icons/icon-192.png" });
  } catch {
    /* certains Android n'autorisent que les notifications via service worker */
  }
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

/** Prix courant d'une crypto : direct si dispo, sinon dernier point d'historique. */
function priceOf(symbol) {
  const live = state.live[symbol];
  if (live?.usd) return live.usd;
  const series = state.history.prices[symbol] || [];
  return series.length ? series[series.length - 1][1] : null;
}

/** Frais configurés pour un swap entre deux cryptos (peu importe le sens). */
function feeFor(a, b) {
  const s = state.settings;
  return s.fees[`${a}/${b}`] ?? s.fees[`${b}/${a}`] ?? s.defaultFeePct;
}

// ------------------------------------------------------ positions (switchs faits)

const openPositions = () => state.positions.filter((p) => !p.closed);

/**
 * Publie les positions ouvertes, chiffrées, sur le canal ntfy dérivé du topic.
 * C'est le seul lien app → bot : pas de token GitHub, rien en clair.
 * Le bot les déchiffre et prend le relais des alertes quand l'app est fermée.
 */
async function publishPositions(force = false) {
  const s = state.settings;
  const topic = (s.ntfyTopic || "").trim();
  if (!topic) return;
  const open = openPositions();
  const hash = JSON.stringify(open.map((p) => [p.id, p.qtyOrigin, p.qtyCurrent])) + s.minReturnGainPct;
  if (!force && hash === s.lastSyncHash) return;
  try {
    const blob = await seal(
      { t: Date.now(), minReturnGainPct: s.minReturnGainPct, positions: open },
      topic
    );
    const res = await fetch(`https://ntfy.sh/${await positionsTopic(topic)}`, {
      method: "POST",
      // Sans priorité ni titre : ce canal est un dépôt de données, pas une alerte.
      headers: { Priority: "min", Tags: "lock" },
      body: blob,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    s.lastSyncHash = hash;
    state.syncMsg = `Positions synchronisées avec le bot à ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.`;
  } catch (err) {
    state.syncMsg = `Synchronisation impossible (${err.message}) — nouvel essai au prochain changement.`;
  }
  store.saveSettings(s);
}

/** État actuel d'une position ouverte : ce que le retour rapporterait maintenant. */
function posStatus(pos) {
  return positionReturn(
    pos,
    priceOf(pos.origin),
    priceOf(pos.current),
    feeFor(pos.origin, pos.current),
    state.settings.minReturnGainPct
  );
}

/** Ouvre le formulaire de validation d'un switch (ou de son retour). */
function openForm(form) {
  state.form = form;
  render();
}

/** Formulaire : quantités réellement données/reçues (taux réel, frais inclus). */
function switchForm() {
  const f = state.form;
  if (!f) return "";
  const title =
    f.mode === "open"
      ? `J'ai fait un switch`
      : `J'ai re-switché ${esc(f.from)} → ${esc(f.to)}`;

  // En ouverture, les deux cryptos restent modifiables : on peut ainsi saisir
  // n'importe quel switch réellement effectué, même sans recommandation en cours.
  const symbols = activeCoins().map((c) => c.symbol);
  for (const p of openPositions()) if (!symbols.includes(p.current)) symbols.push(p.current);
  const options = (sel) =>
    symbols
      .map((sym) => `<option value="${esc(sym)}" ${sym === sel ? "selected" : ""}>${esc(sym)}</option>`)
      .join("");
  const picker =
    f.mode === "open"
      ? `<div class="settings-inline">
          <div><label>J'ai donné</label><select id="form-from">${options(f.from)}</select></div>
          <div><label>J'ai reçu</label><select id="form-to">${options(f.to)}</select></div>
        </div>`
      : "";

  // Si la crypto donnée provient d'un suivi en cours, le switch prolonge
  // simplement ce suivi (la mise d'origine reste la référence). Rien à décider.
  const chained = f.mode === "open" ? openPositions().find((p) => p.current === f.from) : null;
  const chainNote = chained
    ? `<p class="note">Ces ${esc(f.from)} viennent de ton suivi démarré en
       <b>${esc(chained.origin)}</b> : le switch prolonge ce suivi, et l'objectif reste de
       récupérer plus que tes ${fmtQty(chained.qtyOrigin)} ${esc(chained.origin)} de départ.</p>`
    : "";

  return `<div class="card form-card">
    <h3>${title}</h3>
    <p class="note" style="margin-top:0">Saisis les montants réels affichés par ton exchange :
    les frais qu'il t'a pris sont ainsi pris en compte automatiquement.</p>
    ${picker}
    <div class="settings-inline">
      <div><label>Quantité donnée</label>
        <input type="number" min="0" step="any" inputmode="decimal" id="form-qty-from" value="${f.qtyFrom ?? ""}"></div>
      <div><label>Quantité reçue</label>
        <input type="number" min="0" step="any" inputmode="decimal" id="form-qty-to" value="${f.qtyTo ?? ""}"></div>
    </div>
    <label>Date et heure du switch</label>
    <input type="datetime-local" id="form-when" value="${f.when ?? localNow()}">
    ${chainNote}
    <button class="btn" id="form-save">Valider</button>
    <button class="btn btn-ghost" id="form-cancel">Annuler</button>
  </div>`;
}

function bindSwitchForm() {
  if (!state.form) return;
  $("#form-cancel").addEventListener("click", () => {
    state.form = null;
    render();
  });
  // Changer de crypto redessine le formulaire : les cases « switch enchaîné »
  // dépendent de la crypto donnée.
  for (const id of ["#form-from", "#form-to"]) {
    $(id)?.addEventListener("change", () => {
      state.form = {
        ...state.form,
        from: $("#form-from").value,
        to: $("#form-to").value,
        qtyFrom: $("#form-qty-from").value || undefined,
        qtyTo: $("#form-qty-to").value || undefined,
      };
      render();
    });
  }
  $("#form-save").addEventListener("click", () => {
    const f = state.form;
    // En ouverture, les cryptos viennent des sélecteurs (switch saisi à la main).
    if (f.mode === "open") {
      f.from = $("#form-from")?.value || f.from;
      f.to = $("#form-to")?.value || f.to;
      if (f.from === f.to) return;
    }
    const qtyFrom = Number($("#form-qty-from").value);
    const qtyTo = Number($("#form-qty-to").value);
    if (!(qtyFrom > 0) || !(qtyTo > 0)) return;
    const s = state.settings;
    const now = Date.now();

    // Date réelle du switch (saisissable : on valide souvent après coup).
    const whenInput = $("#form-when")?.value;
    const when = whenInput ? new Date(whenInput).getTime() : now;

    if (f.mode === "open") {
      const step = { t: when, from: f.from, to: f.to, qtyFrom, qtyTo };
      // La crypto donnée provient-elle d'un suivi en cours ? Si oui, le switch
      // prolonge la chaîne : la mise d'origine reste la référence du profit.
      const chain = openPositions().find((p) => p.current === f.from);
      const moved = chain ? Math.min(qtyFrom, chain.qtyCurrent) : 0;
      if (chain) {
        const share = moved / chain.qtyCurrent; // part du suivi réellement déplacée
        const received = qtyTo * (moved / qtyFrom);
        if (share >= 0.999) {
          chain.current = f.to;
          chain.qtyCurrent = received;
          chain.steps.push(step);
        } else {
          // Switch partiel : le suivi se scinde, chaque part garde sa mise d'origine.
          const originMoved = chain.qtyOrigin * share;
          chain.qtyOrigin -= originMoved;
          chain.qtyCurrent -= moved;
          state.positions.unshift({
            id: `${now}-${f.from}-${f.to}`,
            t: chain.t,
            origin: chain.origin,
            qtyOrigin: originMoved,
            current: f.to,
            qtyCurrent: received,
            steps: [...chain.steps, step],
            closed: null,
          });
        }
      }
      // Quantité donnée au-delà d'un suivi (ou sans suivi) : nouveau suivi.
      const extra = qtyFrom - moved;
      if (extra > 0) {
        state.positions.unshift({
          id: `${now}-${f.from}-${f.to}-${Math.round(extra)}`,
          t: when,
          origin: f.from,
          qtyOrigin: extra,
          current: f.to,
          qtyCurrent: qtyTo * (extra / qtyFrom),
          steps: [step],
          closed: null,
        });
      }
    } else {
      const pos = state.positions.find((p) => p.id === f.id);
      if (pos) {
        pos.closed = { t: when, qtyBack: qtyTo, profitPct: (qtyTo / pos.qtyOrigin - 1) * 100 };
      }
    }
    // Le portefeuille suit le switch réel.
    s.holdings[f.from] = Math.max(0, (Number(s.holdings[f.from]) || 0) - qtyFrom);
    if (!s.holdings[f.from]) delete s.holdings[f.from];
    s.holdings[f.to] = (Number(s.holdings[f.to]) || 0) + qtyTo;

    store.savePositions(state.positions);
    store.saveSettings(s);
    state.form = null;
    render();
    publishPositions().then(render); // le bot prend le relais app fermée
  });
}

/** Liste des positions ouvertes + leur suivi vs ta quantité de départ. */
function positionsCard() {
  const open = openPositions();
  const closed = state.positions.filter((p) => p.closed).slice(0, 5);
  if (!open.length && !closed.length) return "";

  const openRows = open
    .map((p) => {
      const st = posStatus(p);
      const wait = st
        ? st.ready
          ? `<b class="up">Re-switche maintenant : ${fmtQty(st.qtyBack)} ${esc(p.origin)} (${fmtPct(st.profitPct)})</b>`
          : `Vaut <b>${fmtQty(st.qtyBack)} ${esc(p.origin)}</b> (<b class="${pctClass(st.profitPct)}">${fmtPct(st.profitPct)}</b>) — il manque ${fmtPct(st.missingPct).replace("+", "")} pour re-switcher`
        : "Prix indisponibles";
      const since = new Date(p.t).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
      return `<div class="pos-row ${st?.ready ? "pos-ready" : ""}">
        <div class="pos-head">${fmtQty(p.qtyOrigin)} ${esc(p.origin)} → ${fmtQty(p.qtyCurrent)} ${esc(p.current)}
          <span class="alert-source">depuis le ${since}</span></div>
        <div class="pos-status">${wait}</div>
        <button class="btn btn-ghost btn-sm" data-close-pos="${esc(p.id)}">J'ai re-switché ${esc(p.current)} → ${esc(p.origin)}</button>
      </div>`;
    })
    .join("");

  const closedRows = closed
    .map(
      (p) =>
        `<div class="swap-line">${fmtQty(p.qtyOrigin)} ${esc(p.origin)} → ${fmtQty(p.closed.qtyBack)} ${esc(p.origin)} :
        <b class="${pctClass(p.closed.profitPct)}">${fmtPct(p.closed.profitPct)}</b></div>`
    )
    .join("");

  return `<div class="card">
    <h3>🔁 Mes switchs en cours</h3>
    ${open.length ? openRows : `<p class="note">Aucun switch en cours.</p>`}
    ${closed.length ? `<div class="swap-title">Terminés</div>${closedRows}` : ""}
  </div>`;
}

function bindPositions() {
  for (const btn of document.querySelectorAll("[data-close-pos]")) {
    btn.addEventListener("click", () => {
      const pos = state.positions.find((p) => p.id === btn.dataset.closePos);
      if (!pos) return;
      const st = posStatus(pos);
      openForm({
        mode: "close",
        id: pos.id,
        from: pos.current,
        to: pos.origin,
        qtyFrom: pos.qtyCurrent,
        qtyTo: st ? Number(st.qtyBack.toPrecision(6)) : "",
      });
    });
  }
  for (const btn of document.querySelectorAll("[data-open-pos]")) {
    const [from, to, qty] = btn.dataset.openPos.split("|");
    btn.addEventListener("click", () => openForm({ mode: "open", from, to, qtyFrom: qty }));
  }
}

/**
 * Relance de validation : pour chaque switch conseillé récemment (alerte de
 * l'app ou du bot), demander s'il a été fait tant qu'il n'est pas enregistré.
 * Évite d'avoir à ressaisir un switch à la main plus tard.
 */
function pendingPrompts() {
  const dismissed = store.loadDismissedPrompts();
  const cutoff = Date.now() - 3 * 24 * 60 * MIN;
  const seen = new Set();
  const out = [];
  for (const alert of [...state.localAlerts, ...state.botAlerts]) {
    if (!alert.t || alert.t < cutoff || !alert.from || !alert.to) continue;
    const key = `${alert.from}->${alert.to}`;
    if (seen.has(key) || dismissed.includes(alert.id)) continue;
    // Déjà enregistré depuis l'alerte ? Alors plus rien à demander.
    const done = state.positions.some((p) =>
      (p.steps || []).some(
        (st) => st.from === alert.from && st.to === alert.to && st.t >= alert.t - 60 * MIN
      )
    );
    if (done) continue;
    // Ne relancer que si la crypto de départ est plausiblement détenue :
    // inutile de demander pour un switch qu'il n'a pas pu faire.
    const holds =
      (Number(state.settings.holdings[alert.from]) || 0) > 0 ||
      openPositions().some((p) => p.current === alert.from);
    if (!holds) continue;
    seen.add(key);
    out.push(alert);
  }
  return out.slice(0, 3);
}

function promptCards() {
  return pendingPrompts()
    .map(
      (a) => `<div class="card prompt-card">
        <h3>As-tu fait ce switch ${esc(a.from)} → ${esc(a.to)} ?</h3>
        <p class="advice-text">Conseillé le ${fmtWhen(a.t)}. Enregistre-le pour que l'app
        surveille le bon moment de revenir en ${esc(a.from)}.</p>
        <button class="btn" data-prompt-yes="${esc(a.id)}|${esc(a.from)}|${esc(a.to)}|${a.t}">Oui, l'enregistrer</button>
        <button class="btn btn-ghost" data-prompt-no="${esc(a.id)}">Non</button>
      </div>`
    )
    .join("");
}

function bindPrompts() {
  for (const btn of document.querySelectorAll("[data-prompt-yes]")) {
    const [, from, to, t] = btn.dataset.promptYes.split("|");
    // Date pré-remplie à l'heure de l'alerte : le switch a été fait autour.
    btn.addEventListener("click", () =>
      openForm({ mode: "open", from, to, when: localNow(Number(t)) })
    );
  }
  for (const btn of document.querySelectorAll("[data-prompt-no]")) {
    btn.addEventListener("click", () => {
      store.saveDismissedPrompts([...store.loadDismissedPrompts(), btn.dataset.promptNo]);
      render();
    });
  }
}

// Carte « Conseil » en tête d'accueil : d'abord tes switchs en cours (référence =
// ta quantité de départ), sinon les signaux du marché croisés au portefeuille.
function adviceCard() {
  const s = state.settings;

  // Priorité : une position ouverte attend son retour.
  const open = openPositions();
  // withStatus est vide tant que les prix ne sont pas chargés (premier rendu).
  const withStatus = open.map((p) => ({ p, st: posStatus(p) })).filter((x) => x.st);
  if (withStatus.length) {
    const ready = withStatus.filter((x) => x.st.ready).sort((a, b) => b.st.profitPct - a.st.profitPct)[0];
    if (ready) {
      const { p, st } = ready;
      return `<div class="card advice-card advice-good">
        <h3>💡 Re-switche tes ${esc(p.current)} en ${esc(p.origin)} maintenant</h3>
        <p class="advice-text">Tu avais donné <b>${fmtQty(p.qtyOrigin)} ${esc(p.origin)}</b>, tu détiens
        ${fmtQty(p.qtyCurrent)} ${esc(p.current)}. Aujourd'hui, ce retour te rendrait
        <b>≈ ${fmtQty(st.qtyBack)} ${esc(p.origin)}</b>, soit <b class="up">${fmtPct(st.profitPct)}</b>
        de plus qu'au départ, frais du retour déduits. C'est ton profit réel : boucle la position.</p>
        <button class="btn" data-close-pos="${esc(p.id)}">J'ai re-switché</button></div>`;
    }
    const best = withStatus.sort((a, b) => b.st.profitPct - a.st.profitPct)[0];
    return `<div class="card advice-card">
      <h3>💡 Patiente, ne re-switche pas encore</h3>
      <p class="advice-text">Ton suivi ${esc(best.p.origin)} → ${esc(best.p.current)} vaut aujourd'hui
      <b>${fmtQty(best.st.qtyBack)} ${esc(best.p.origin)}</b> contre
      <b>${fmtQty(best.p.qtyOrigin)} ${esc(best.p.origin)}</b> investis
      (<b class="${pctClass(best.st.profitPct)}">${fmtPct(best.st.profitPct)}</b>).
      Re-switcher maintenant, c'est encaisser cette perte : il manque
      <b>${fmtPct(best.st.missingPct).replace("+", "")}</b> pour atteindre ton objectif de
      ${fmtPct(s.minReturnGainPct)}. L'app t'alertera dès que ce sera le cas.</p></div>`;
  }

  const held = Object.keys(s.holdings).filter((sym) => (Number(s.holdings[sym]) || 0) > 0);
  if (!held.length) {
    return `<div class="card advice-card"><h3>💡 Conseil</h3>
      <p class="advice-text">Renseigne ton portefeuille ci-dessous : l'app croisera tes quantités
      avec le marché et te dira quoi swapper pour un profit potentiel.</p></div>`;
  }

  // Recommandations : signaux dont la crypto de départ est détenue.
  const recos = [];
  for (const a of state.analyses) {
    if (!a.signal || !held.includes(a.signal.from)) continue;
    const qty = Number(s.holdings[a.signal.from]) || 0;
    const pFrom = priceOf(a.signal.from);
    const pTo = priceOf(a.signal.to);
    if (!pFrom || !pTo) continue;
    const got = ((qty * pFrom) / pTo) * (1 - a.feePct / 100);
    recos.push({ ...a.signal, qty, got });
  }
  recos.sort((x, y) => y.netGainPct - x.netGainPct);

  if (recos.length) {
    const r = recos[0];
    const others = recos
      .slice(1)
      .map(
        (o) =>
          `<div class="swap-line">Aussi : ${esc(o.from)} → ${esc(o.to)}, <b class="up">${fmtPct(o.netGainPct)}</b> net
            <button class="btn btn-ghost btn-sm" data-open-pos="${esc(o.from)}|${esc(o.to)}|${o.qty}">J'ai fait ce switch</button></div>`
      )
      .join("");
    return `<div class="card advice-card advice-good">
      <h3>💡 Il est conseillé d'échanger tes ${esc(r.from)} contre du ${esc(r.to)}</h3>
      <p class="advice-text">Tes <b>${fmtQty(r.qty)} ${esc(r.from)}</b> donneraient
      <b>≈ ${fmtQty(r.got)} ${esc(r.to)}</b>, car le ratio ${esc(r.from)}/${esc(r.to)} s'écarte de
      <b>${fmtPct(r.grossGainPct)}</b> de sa moyenne ${esc(r.refLabel ?? "24 h")} en ta faveur
      (z-score ${r.zScore.toFixed(1)}${r.rsi !== null && r.rsi !== undefined ? `, RSI ${Math.round(r.rsi)}` : ""}),
      soit <b class="up">${fmtPct(r.netGainPct)} net</b> après ${String(r.feePct).replace(".", ",")} % de frais.
      Si le ratio revient vers sa moyenne, l'aller-retour laisse ce profit en ${esc(r.from)}.</p>
      <button class="btn" data-open-pos="${esc(r.from)}|${esc(r.to)}|${r.qty}">J'ai fait ce switch</button>
      ${others}</div>`;
  }

  // Pas de signal : afficher quand même le swap le mieux placé, à titre indicatif.
  let best = null;
  for (const a of state.analyses) {
    const ind = a.indicators;
    if (!ind.dataOk || !ind.smaLong) continue;
    for (const o of [
      { from: a.pair.from, to: a.pair.to, net: (ind.ratio / ind.smaLong - 1) * 100 - a.feePct },
      { from: a.pair.to, to: a.pair.from, net: (ind.smaLong / ind.ratio - 1) * 100 - a.feePct },
    ]) {
      if (held.includes(o.from) && (!best || o.net > best.net)) best = o;
    }
  }
  const bestTxt = best
    ? ` Le mieux placé serait ${esc(best.from)} → ${esc(best.to)} (<b class="${pctClass(best.net)}">${fmtPct(best.net)}</b> net), en dessous de tes seuils.`
    : "";
  // Un écart existait mais un filtre l'a écarté : le dire plutôt que rester muet.
  const filtered = state.analyses
    .map((a) => rejectionReason(a.indicators, a.pair))
    .filter(Boolean)[0];
  const filteredTxt = filtered ? ` Un écart a été écarté : ${esc(filtered)}.` : "";
  return `<div class="card advice-card"><h3>💡 Conseil</h3>
    <p class="advice-text">Rien à faire pour l'instant : aucun swap suffisamment rentable détecté
    sur tes cryptos, frais déduits.${bestTxt}${filteredTxt}</p></div>`;
}

// Carte « Mon portefeuille » : quantités détenues + simulateur de swap
// (ce que chaque swap donnerait aux prix actuels, frais déduits).
function portfolioCard() {
  const s = state.settings;
  const coins = activeCoins();
  const inputs = coins
    .map(
      (c) => `<div><label>${esc(c.symbol)}</label>
        <input type="number" min="0" step="any" inputmode="decimal" data-holding="${esc(c.symbol)}"
          value="${s.holdings[c.symbol] ?? ""}" placeholder="0"></div>`
    )
    .join("");

  let totalUsd = 0;
  const lines = [];
  for (const c of coins) {
    const qty = Number(s.holdings[c.symbol]) || 0;
    const pFrom = priceOf(c.symbol);
    if (qty <= 0 || !pFrom) continue;
    totalUsd += qty * pFrom;
    for (const other of coins) {
      if (other.symbol === c.symbol) continue;
      const pTo = priceOf(other.symbol);
      if (!pTo) continue;
      const fee = feeFor(c.symbol, other.symbol);
      const got = ((qty * pFrom) / pTo) * (1 - fee / 100);
      lines.push(
        `<div class="swap-line">${fmtQty(qty)} ${esc(c.symbol)} → <b>${fmtQty(got)} ${esc(other.symbol)}</b>
          <span class="swap-fee">frais ${String(fee).replace(".", ",")} % déduits</span></div>`
      );
    }
  }

  return `<div class="card">
    <h3>Mon portefeuille</h3>
    <div class="holdings-row">${inputs}</div>
    ${
      lines.length
        ? `<div class="swap-total">Valeur totale : <b>${fmtPrice(totalUsd)}</b></div>
           <div class="swap-title">Si tu swapes maintenant :</div>${lines.join("")}`
        : `<p class="note">Saisis tes quantités pour voir ce que chaque swap donnerait (frais déduits).</p>`
    }
    <button class="btn btn-ghost" id="manual-switch">+ J'ai fait un switch</button>
    <p class="note">Pour enregistrer un switch fait sur ton exchange, même sans recommandation
    de l'app. Plusieurs switchs peuvent être suivis en parallèle.</p>
  </div>`;
}

function bindPortfolioInputs() {
  $("#manual-switch")?.addEventListener("click", () => {
    const syms = activeCoins().map((c) => c.symbol);
    openForm({ mode: "open", from: syms[0], to: syms[1] ?? syms[0] });
  });
  for (const input of document.querySelectorAll("[data-holding]")) {
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (v > 0) state.settings.holdings[input.dataset.holding] = v;
      else delete state.settings.holdings[input.dataset.holding];
      store.saveSettings(state.settings);
      render();
    });
  }
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
      const price = priceOf(coin.symbol);
      const delta = state.live[coin.symbol]?.change24h ?? null;
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
  $("#view-coins").innerHTML =
    errorBanner() +
    switchForm() +
    adviceCard() +
    promptCards() +
    positionsCard() +
    portfolioCard() +
    (rows || `<p class="msg-empty">Aucune crypto suivie.</p>`);
  bindSwitchForm();
  bindPositions();
  bindPortfolioInputs();
  bindPrompts();
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
      const reason = rejectionReason(ind, a.pair);
      const signalLine = a.signal
        ? `<p class="signal-line up"><b>${esc(formatSignalMessage(a.signal))}</b></p>`
        : reason
          ? `<p class="signal-line"><span class="alert-source">filtré</span> Écart détecté mais ignoré : ${esc(reason)}.</p>`
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
          <span class="l2"><i></i>Moyenne ${esc(ind.refLabel ?? "24 h")}</span>
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
      <label>Gain minimum pour re-switcher (% vs ta quantité de départ)</label>
      <input type="number" id="set-minreturn" min="0" step="0.1" value="${s.minReturnGainPct}">
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
      <label>Topic ntfy (alertes quand l'app est fermée)</label>
      <input type="text" id="set-topic" autocomplete="off" spellcheck="false"
        placeholder="le même que le secret NTFY_TOPIC" value="${esc(s.ntfyTopic || "")}">
      <button class="btn" id="save-topic">Enregistrer et synchroniser</button>
      ${state.syncMsg ? `<p class="note">${esc(state.syncMsg)}</p>` : ""}
      <p class="note">Ce topic sert aussi de clé : tes switchs en cours sont
      <b>chiffrés</b> puis déposés sur un canal dérivé (nom non devinable) que seul le bot
      sait lire. Il peut alors t'alerter app fermée quand le retour devient gagnant.
      Aucun montant ne circule en clair, et les notifications n'affichent qu'un pourcentage.</p>
    </div>`;

  $("#save-settings").addEventListener("click", () => {
    s.pwaMin = Math.max(1, Number($("#set-interval").value) || 2);
    s.zScoreTrigger = Number($("#set-zscore").value) || 2;
    s.minNetGainPct = Number($("#set-mingain").value) || 0;
    s.cooldownMin = Math.max(5, Number($("#set-cooldown").value) || 240);
    s.minReturnGainPct = Number($("#set-minreturn").value) || 0;
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

  $("#save-topic").addEventListener("click", async () => {
    s.ntfyTopic = $("#set-topic").value.trim();
    s.lastSyncHash = "";
    store.saveSettings(s);
    state.syncMsg = s.ntfyTopic ? "Synchronisation en cours…" : "Topic effacé : alertes in-app seulement.";
    render();
    await publishPositions(true);
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
