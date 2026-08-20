// Tests du canal chiffré app <-> bot.
// Usage : node bot/test-vault.js

import { webcrypto } from "node:crypto";
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const { seal, unseal, positionsTopic } = await import("../docs/js/vault.js");

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "OK " : "ÉCHEC"} - ${name}`);
  if (!cond) failures++;
}

const secret = "gst-switch-gabriel-k3x9v2";
const payload = {
  t: 1234567890,
  minReturnGainPct: 1.5,
  positions: [{ id: "p1", from: "GST", to: "GMT", qtyFrom: 1000, qtyTo: 130 }],
};

// 1. Aller-retour : ce que l'app scelle, le bot le relit à l'identique.
{
  const blob = await seal(payload, secret);
  const back = await unseal(blob, secret);
  check("aller-retour identique", JSON.stringify(back) === JSON.stringify(payload));
  check("aucun montant lisible dans le blob", !blob.includes("1000") && !blob.includes("GST"));
}

// 2. Mauvais secret : illisible, et pas d'exception qui casserait le bot.
{
  const blob = await seal(payload, secret);
  check("mauvais secret : null", (await unseal(blob, "mauvais-topic")) === null);
  check("données corrompues : null", (await unseal("nimportequoi", secret)) === null);
}

// 3. Deux scellés du même contenu diffèrent (IV aléatoire) mais se relisent.
{
  const a = await seal(payload, secret);
  const b = await seal(payload, secret);
  check("chiffrés distincts (IV aléatoire)", a !== b);
  check("les deux se déchiffrent", JSON.stringify(await unseal(b, secret)) === JSON.stringify(payload));
}

// 4. Canal de dépôt : stable, et non devinable depuis le topic d'alerte.
{
  const t1 = await positionsTopic(secret);
  const t2 = await positionsTopic(secret);
  const other = await positionsTopic(`${secret}x`);
  check("canal stable pour un même secret", t1 === t2);
  check("canal différent pour un autre secret", t1 !== other);
  check("canal ne contient pas le topic d'alerte", !t1.includes(secret));
  check("canal format ntfy valide", /^csa[0-9a-f]{24}$/.test(t1));
  console.log(`     canal dérivé : ${t1}`);
}

console.log(failures === 0 ? "\nTous les tests passent." : `\n${failures} test(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
