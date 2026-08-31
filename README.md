# PokéWatch

Alerte Discord dès qu'un booster / display / ETB / coffret Pokémon passe sous ton prix max, ou revient en stock.
Tourne toutes les 10 min sur GitHub Actions, gratuit, sans PC allumé.

## Sources (config.json → `sources`)
- `rss` : Dealabs nouveaux + hot (+ ton flux d'alertes perso via le secret `EXTRA_FEEDS`)
- `shopify` : boutiques spécialisées lues en JSON (RelicTCG, Boostrclub…) → nouveauté / baisse / restock
- `listing` : pages catégorie des retailers (Micromania, Cultura, King Jouet, JouéClub, Smyths, Philibert…) → idem
- `watchlist` : pages produit précises avec ton prix max → baisse + restock

Chaque source a `"enabled": true/false`. Si une source répond 403 dans les logs (Actions → pokewatch → Run watcher), passe-la à `false` ou dis-le moi.

## Réglages
- `max_price` : seuils par type (€). Au-dessus → silence.
- `exclude` : mots-clés qui coupent (peluches, sleeves, singles gradés, coréen/japonais…).
- `alert_if_price_unknown` : alerte quand même si le prix n'est pas lisible.
- `alert_untyped_pokemon_deals` : `true` pour recevoir TOUT deal Pokémon TCG.
- `alert_restock` : alerte quand un produit sous seuil repasse dispo.

## Notes
- Premier run = indexation silencieuse + message « ✅ PokéWatch actif ». Ensuite, uniquement les nouveautés.
- Max 12 alertes par run (anti-spam).
- Repo public inactif 60 jours → GitHub coupe le cron. Les commits auto de `state.json` maintiennent l'activité.
- Amazon bloque tout → Keepa pour les alertes prix Amazon.
