// Réglages utilisateur (localStorage). Ils s'appliquent à la vue en direct de
// la PWA ; les seuils du bot de fond se règlent dans config.json (repo GitHub).

const SETTINGS_KEY = "csa-settings-v1";
const POSITIONS_KEY = "csa-positions-v1";
const HISTORY_CACHE_KEY = "csa-history-cache-v1";
const LOCAL_ALERTS_KEY = "csa-local-alerts-v1";
const NOTIF_COOLDOWN_KEY = "csa-notif-cooldowns-v1";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage plein ou indisponible : non bloquant */
  }
}

/** Réglages par défaut dérivés de config.json, surchargés par le localStorage. */
export function loadSettings(config) {
  const defaults = {
    pwaMin: config.refresh?.pwaMin ?? 2,
    zScoreTrigger: config.analysis.zScoreTrigger,
    minNetGainPct: config.analysis.minNetGainPct,
    cooldownMin: config.analysis.cooldownMin,
    defaultFeePct: 2.0,
    fees: Object.fromEntries(config.pairs.map((p) => [`${p.from}/${p.to}`, p.feePct])),
    extraCoins: [],
    hiddenSymbols: [],
    notifyInApp: true,
    holdings: {}, // symbol -> quantité détenue (simulateur de swap)
    minReturnGainPct: 1.0, // gain minimum vs ta quantité de départ pour re-switcher
  };
  const saved = read(SETTINGS_KEY, {});
  return { ...defaults, ...saved, fees: { ...defaults.fees, ...(saved.fees || {}) } };
}

export function saveSettings(settings) {
  write(SETTINGS_KEY, settings);
}

/** Cache d'historique local (mode sans bot : avant déploiement / hors GitHub Pages). */
export function loadHistoryCache() {
  return read(HISTORY_CACHE_KEY, { updated: 0, prices: {} });
}
export function saveHistoryCache(cache) {
  write(HISTORY_CACHE_KEY, cache);
}

/** Alertes générées par la PWA elle-même (complément de celles du bot). */
export function loadLocalAlerts() {
  return read(LOCAL_ALERTS_KEY, []);
}
export function saveLocalAlerts(alerts) {
  write(LOCAL_ALERTS_KEY, alerts.slice(0, 100));
}

/**
 * Switchs réellement effectués et validés dans l'app.
 * { id, t, from, to, qtyFrom, qtyTo, closed: null | { t, qtyBack, profitPct } }
 * qtyTo / qtyFrom = taux d'entrée RÉEL (frais de l'exchange déjà dedans).
 */
export function loadPositions() {
  return read(POSITIONS_KEY, []);
}
export function savePositions(positions) {
  write(POSITIONS_KEY, positions.slice(0, 200));
}

export function loadNotifCooldowns() {
  return read(NOTIF_COOLDOWN_KEY, {});
}
export function saveNotifCooldowns(map) {
  write(NOTIF_COOLDOWN_KEY, map);
}
