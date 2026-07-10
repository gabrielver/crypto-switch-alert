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
