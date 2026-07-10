// Accès aux données : API CoinGecko (gratuite, sans clé) + fichiers JSON du repo.

const API = "https://api.coingecko.com/api/v3";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** JSON local du site (data/history.json…) — null si absent ou hors-ligne. */
export async function loadLocalJson(path) {
  try {
    // cache-bust : les data sont recommitées régulièrement par le bot
    return await fetchJson(`${path}?t=${Math.floor(Date.now() / 60000)}`);
  } catch {
    return null;
  }
}

/** Prix actuels + variation 24 h pour une liste d'ids CoinGecko (1 seul appel). */
export async function simplePrice(ids) {
  return fetchJson(
    `${API}/simple/price?ids=${encodeURIComponent(ids.join(","))}` +
      `&vs_currencies=usd&include_24hr_change=true`
  );
}

/** Historique ~30 j horaire d'une crypto (utilisé en bootstrap local). */
export async function marketChart(id, days = 30) {
  const data = await fetchJson(
    `${API}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`
  );
  return (data.prices || []).map(([t, v]) => [Math.round(t), v]);
}
