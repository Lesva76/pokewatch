# PokéWatch

Alerte Discord dès qu'un booster / display / ETB / coffret Pokémon passe sous ton prix max.
Sources : Dealabs (RSS nouveaux + hot, + ton flux d'alertes perso) et une watchlist de pages produit.
Tourne toutes les 10 min sur GitHub Actions, gratuit, sans PC allumé.

## Setup (5 min)

1. **Discord** : ton serveur → salon → Modifier → Intégrations → Webhooks → Nouveau → copier l'URL.
2. **GitHub** : nouveau repo (privé ou public), upload de tous les fichiers de ce dossier
   (garde bien `.github/workflows/watch.yml`).
3. Repo → Settings → Secrets and variables → Actions → New repository secret :
   - `DISCORD_WEBHOOK_URL` = l'URL du webhook
   - (optionnel) `EXTRA_FEEDS` = URL de ton « Flux RSS de mes alertes » Dealabs
     (compte Dealabs → Fil d'alertes → alerte « pokémon » → lien RSS en bas). Plusieurs URLs = séparées par des virgules.
4. Onglet Actions → `pokewatch` → Run workflow. Premier run = warm-up : il marque tout l'existant comme vu
   et t'envoie « ✅ PokéWatch actif ». Ensuite ça part tout seul.

## Réglages (`config.json`)

- `max_price` : seuils par type (€). Au-dessus → pas d'alerte.
- `exclude` : mots-clés qui coupent l'alerte (peluches, sleeves, singles gradés…).
- `alert_if_price_unknown` : alerte quand même si le prix n'est pas lisible dans le titre.
- `alert_untyped_pokemon_deals` : `true` pour recevoir TOUT deal Pokémon TCG même sans type détecté.
- `watchlist` : pages produit à checker en direct, ex :
  ```json
  {"name": "Display EV Mega Evolution", "type": "display", "max_price": 135,
   "url": "https://www.cultura.com/p-xxxx.html"}
  ```
  Ré-alerte à chaque baisse de prix sous le seuil, silence si rupture. Amazon bloque → inutile de l'y mettre.

## Notes

- GitHub retarde parfois les crons de quelques minutes en heure de pointe.
- Si le log affiche `HTTP 403` sur Dealabs même après le proxy : mets ton flux d'alertes perso dans `EXTRA_FEEDS`, il passe mieux.
- Repo public inactif 60 jours → GitHub coupe le cron. Les commits auto de `state.json` maintiennent l'activité.
