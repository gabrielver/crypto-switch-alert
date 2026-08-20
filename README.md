# Crypto Switch Alert — GST / GMT / USDC

Mini web app (PWA) qui surveille les prix de plusieurs cryptos via l'API gratuite
CoinGecko et **t'alerte quand un switch d'une crypto à une autre semble avantageux**
(écart significatif du ratio de prix par rapport à sa moyenne, frais déduits).

**Alerte seulement — aucun trading automatique.** L'app ne touche jamais à tes fonds :
elle notifie une opportunité, c'est toi qui fais (ou pas) le switch sur ton exchange.

> ⚠️ Ce n'est pas un conseil financier. Les signaux sont de l'analyse statistique
> simple (retour à la moyenne) : un écart peut aussi continuer de se creuser.

## Architecture (100 % gratuite)

```
Toutes les ~5-15 min                        Quand tu ouvres l'app
┌──────────────────────┐                    ┌───────────────────────┐
│ GitHub Actions (cron)│                    │ PWA (GitHub Pages)    │
│  bot/collect.js      │── commit ─────────▶│ lit docs/data/*.json  │
│  - prix CoinGecko    │   history.json     │ + prix CoinGecko en   │
│  - analyse           │   alerts.json      │   direct (config.)    │
│  - push ntfy.sh ─────┼──▶ 📱 notification │ même module d'analyse │
└──────────────────────┘    Android (ntfy)  └───────────────────────┘
```

- **Zéro dépendance, zéro build** : Node ≥ 18 pour le bot, JavaScript vanilla pour la PWA.
- Le module d'analyse ([docs/js/analysis.js](docs/js/analysis.js)) est **partagé** entre
  le bot et l'app : mêmes indicateurs, mêmes messages.
- Historique des prix : fichiers JSON commités dans le repo par le bot (pas de base à héberger).
- Notifications app fermée : [ntfy.sh](https://ntfy.sh) (gratuit, sans compte).

## Lancer en local

```bash
# 1. Tests du module d'analyse
node bot/test-analysis.js

# 2. Une collecte (crée docs/data/history.json et alerts.json ;
#    sans NTFY_TOPIC, analyse sans notification)
node bot/collect.js

# 3. Servir la PWA
python -m http.server 8000 --directory docs
# puis ouvrir http://localhost:8000
```

Sans données du bot, la PWA fonctionne quand même : elle télécharge ~30 jours
d'historique CoinGecko et le garde en localStorage (bandeau « Mode local »).

## Déployer gratuitement (une fois, ~10 minutes)

1. **Créer un repo GitHub** (public : Actions et Pages illimités gratuits) et pousser ce dossier :
   ```bash
   git remote add origin https://github.com/TON-COMPTE/crypto-switch-alert.git
   git push -u origin main
   ```
2. **Choisir un topic ntfy secret** — c'est juste un mot de passe d'abonnement, ex :
   `gst-switch-gabriel-k3x9v2`. N'importe qui connaissant le topic peut lire tes alertes,
   d'où le suffixe aléatoire.
3. **Ajouter le secret** : sur GitHub → *Settings → Secrets and variables → Actions →
   New repository secret* → nom `NTFY_TOPIC`, valeur ton topic.
4. **Activer GitHub Pages** : *Settings → Pages → Source : Deploy from a branch →
   Branch `main`, dossier `/docs`*. L'app sera sur `https://TON-COMPTE.github.io/crypto-switch-alert/`.
5. **Activer le workflow** : onglet *Actions* → accepter l'exécution → lancer
   `watch-prices` une première fois via *Run workflow*. Ensuite il tourne tout seul
   toutes les ~5-15 min (cadence réelle du cron GitHub, pas garantie à la minute).

## Notifications sur Android (app fermée)

1. Installer **ntfy** depuis le Play Store (gratuit).
2. Dans ntfy : **+ → S'abonner au sujet** → entrer ton topic (le même que le secret `NTFY_TOPIC`).
3. C'est tout : chaque opportunité détectée par le bot arrive en notification push.

## Installer la PWA sur Android

1. Ouvrir l'URL GitHub Pages dans **Chrome**.
2. Menu ⋮ → **« Ajouter à l'écran d'accueil »** (ou « Installer l'application »).
3. L'icône apparaît sur l'écran d'accueil et s'ouvre en plein écran comme une app.

## Ajouter une crypto à surveiller

Éditer **[docs/config.json](docs/config.json)** (directement sur github.com depuis le
téléphone, ou en local + push) :

```jsonc
"coins": [
  ...,
  { "id": "solana", "symbol": "SOL", "name": "Solana" }   // id = fin de l'URL CoinGecko
],
"pairs": [
  ...,
  { "from": "SOL", "to": "USDC", "feePct": 2.0 }
]
```

Au cycle suivant, le bot télécharge automatiquement 30 jours d'historique pour la
nouvelle crypto. (L'écran Réglages de l'app permet aussi d'ajouter une crypto « locale »,
suivie contre USDC, visible seulement dans l'app.)

## Réglages et seuils

| Paramètre (`docs/config.json` → `analysis`) | Rôle | Défaut |
|---|---|---|
| `zScoreTrigger` | Écart (en écarts-types vs moyenne 24 h) qui déclenche une alerte | 2.0 |
| `minNetGainPct` | Gain net minimum (frais déduits) pour alerter | 1.0 % |
| `feePct` (par paire) | Frais de swap estimés — **à ajuster selon ton exchange** | 2.0 % |
| `cooldownMin` | Délai minimum entre deux alertes identiques | 240 min |
| `smaShortMin` / `smaLongMin` | Fenêtres des moyennes mobiles courte/longue | 60 / 1440 min |
| `refresh.pwaMin` | Rafraîchissement de l'app quand elle est ouverte | 2 min |

Les mêmes seuils sont réglables dans l'écran **Réglages** de l'app pour la vue en
direct ; ceux du bot (alertes de fond) se changent dans `config.json` sur GitHub.

Frais STEPN : le défaut de 2 % est prudent — vérifie les frais réels affichés dans
l'app STEPN au moment du swap et ajuste `feePct`, sinon les alertes seront trop
optimistes ou trop rares.

## Portefeuille, simulateur & conseil personnalisé

En haut de l'onglet **Cryptos**, saisis les quantités que tu détiens (GST, GMT, USDC…).
Elles sont mémorisées sur ton téléphone (localStorage), rien n'est envoyé nulle part. L'app
affiche alors :

- **💡 Conseil** : le croisement de ton portefeuille avec les signaux du marché —
  « Il est conseillé d'échanger tes GST contre du GMT car le ratio s'écarte de X % de sa
  moyenne 24 h en ta faveur, soit +Y % net après frais », avec les quantités estimées à
  l'arrivée. S'il n'y a rien de rentable, l'app le dit et montre le swap le mieux placé
  (même s'il est sous les seuils).
- **La valeur totale** du portefeuille en dollars.
- **Le simulateur** : ce que chaque swap donnerait aux prix actuels, frais déduits
  (ex : « 1 000 GST → 126,9 GMT »).

## Suivi des switchs (le plus important)

Une alerte de marché dit « le ratio est anormalement haut ». Elle ne sait pas à quel
prix **toi** tu es entré. C'est le suivi de switchs qui répond à « quand revendre » :

1. L'app conseille un switch (ex : GST → GMT). Tu le fais sur ton exchange.
2. Tu cliques **« J'ai fait ce switch »** et tu saisis les montants réels
   (donné 1 000 GST / reçu 130 GMT). Les frais que l'exchange t'a réellement pris sont
   ainsi inclus dans ton taux d'entrée — pas besoin de les estimer.
3. L'app surveille alors le **retour** : à chaque rafraîchissement, elle calcule ce que
   te rendrait le re-switch GMT → GST, frais déduits, et le compare à tes **1 000 GST de
   départ**. Tant que c'est en dessous de ton objectif, elle affiche « Patiente, ne
   re-switche pas encore » avec le manque exact.
4. Dès que le retour dépasse ton objectif (réglage *Gain minimum pour re-switcher*,
   1 % par défaut), tu reçois l'alerte « Re-switche maintenant : 1 080 GST récupérés
   contre 1 000 investis (+8 %) ».
5. Tu valides le retour, la position se ferme et le profit **réel** est archivé dans
   « Terminés ».

Le portefeuille est mis à jour automatiquement à chaque validation.

### Alertes de retour quand l'app est fermée (sans token, sans fuite)

Le bot tourne sur GitHub, tes positions vivent sur ton téléphone : il faut un pont.
Ici, pas de token GitHub à coller dans l'app et aucun montant en clair.

1. Dans **Réglages → Topic ntfy**, saisis ton topic (le même que le secret `NTFY_TOPIC`).
2. L'app chiffre tes switchs en cours (AES-256-GCM, clé dérivée du topic par PBKDF2) et
   les publie sur un **canal ntfy dérivé** : son nom est un SHA-256 du topic, donc
   connaître ton topic d'alerte ne permet pas de le trouver.
3. Le bot, qui connaît le topic par le secret GitHub, dérive le même canal, déchiffre, et
   range le paquet **toujours chiffré** dans `docs/data/positions.json`. Le repo peut
   rester public : ce fichier est illisible sans le topic.
4. Toutes les 5-15 min, le bot compare les prix à ton taux d'entrée et t'envoie la notif
   quand le retour dépasse ton objectif — app fermée comprise.

ntfy ne garde ses messages que quelques heures ; le dépôt chiffré dans le repo sert de
mémoire longue durée, donc une position reste suivie même si tu n'ouvres pas l'app
pendant des jours.

**Le texte des notifications ne contient qu'un pourcentage** (« Re-switch GMT → GST :
+9,1 % vs ton entrée »), jamais tes montants : lui seul transite en clair, puisque ton
téléphone doit l'afficher.

Tant qu'une position est ouverte, le bot **ignore les signaux de marché** sur les cryptos
concernées : un seul message à la fois, pas de conseil contradictoire.

Sans topic saisi dans l'app, tout fonctionne comme avant : alertes de retour in-app
uniquement, alertes de marché par ntfy.

**Pourquoi tu pouvais switcher à perte avant :** les alertes de marché comparent le ratio
à sa moyenne, pas à ton point d'entrée. Avec le suivi, la référence devient ta propre
quantité de départ — re-switcher n'est conseillé que si tu récupères **plus** que ce que
tu avais, frais du retour compris.

## Comment sont détectées les opportunités ?

Pour chaque paire (ex : GST/GMT), sur la série du **ratio** de prix :

1. Variations sur 15 min / 1 h / 24 h.
2. Moyennes mobiles 1 h et 24 h → tendance (hausse / baisse / stable).
3. **Z-score** du ratio par rapport à sa moyenne 24 h : mesure si l'écart actuel est
   anormal (au-delà de `zScoreTrigger` écarts-types).
4. RSI 14 sur le ratio (sur-achat / sur-vente, affiché en confirmation).
5. Gain net estimé = écart à la moyenne − frais. Alerte seulement si z-score **et**
   gain net dépassent les seuils → les micro-mouvements absorbés par les frais ne
   déclenchent rien.
6. Anti-spam : cooldown par sens de switch.

L'onglet **Alertes** garde l'historique et affiche pour chaque alerte passée ce que
l'aller-retour vaudrait aujourd'hui — pour vérifier a posteriori si les recommandations
étaient bonnes et ajuster les seuils.

La couche d'analyse est volontairement modulaire : pour ajouter plus tard du sentiment
de marché, des news ou un modèle de prédiction, il suffit d'ajouter dans `analysis.js`
des fonctions produisant des objets *signal* au même format — bot et PWA les
afficheront sans autre modification.

## Limites connues

- Cron GitHub : cadence réelle 5 à ~15 min (suffisant pour du retour à la moyenne,
  pas pour du scalping).
- API CoinGecko gratuite : ~5-15 requêtes/min ; le bot n'en fait qu'une par cycle,
  l'app une par rafraîchissement — large marge.
- Les notifications **in-app** ne fonctionnent que l'app ouverte ; app fermée, c'est
  ntfy qui prend le relais.
