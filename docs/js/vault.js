// Canal privé entre la PWA et le bot, sans token GitHub et sans donnée en clair.
//
// Problème : le bot (GitHub Actions) doit connaître les switchs validés dans
// l'app pour alerter app fermée, mais l'app ne peut pas écrire dans le repo
// sans token, et les montants ne doivent apparaître nulle part en clair.
//
// Solution : les deux côtés partagent un unique secret déjà existant — le topic
// ntfy. On en dérive (1) un nom de canal de dépôt non devinable depuis le topic
// d'alerte, (2) une clé AES-GCM. L'app y publie ses positions chiffrées ; le bot
// les déchiffre et les persiste chiffrées dans le repo.
//
// Node < 20 : le bot doit poser globalThis.crypto = webcrypto avant l'import.

const SALT = new TextEncoder().encode("crypto-switch-alert/v1");
const PBKDF2_ROUNDS = 120000;

const subtle = () => globalThis.crypto.subtle;
const bytes = (s) => new TextEncoder().encode(s);

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Nom du canal ntfy où l'app dépose ses positions.
 * Dérivé du topic d'alerte par SHA-256 : connaître l'un ne donne pas l'autre.
 */
export async function positionsTopic(secret) {
  const digest = await subtle().digest("SHA-256", bytes(`positions|${secret}`));
  return `csa${[...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function keyFrom(secret) {
  const material = await subtle().importKey("raw", bytes(secret), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", salt: SALT, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Chiffre un objet JSON → "base64(iv).base64(chiffré)". */
export async function seal(obj, secret) {
  const key = await keyFrom(secret);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle().encrypt({ name: "AES-GCM", iv }, key, bytes(JSON.stringify(obj)));
  return `${toB64(iv)}.${toB64(data)}`;
}

/** Déchiffre une chaîne produite par seal(). null si secret faux ou données corrompues. */
export async function unseal(payload, secret) {
  try {
    const [ivB64, dataB64] = String(payload).split(".");
    if (!ivB64 || !dataB64) return null;
    const key = await keyFrom(secret);
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: fromB64(ivB64) },
      key,
      fromB64(dataB64)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}
