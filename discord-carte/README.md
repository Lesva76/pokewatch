# /carte — bot Discord prix + potentiel (Cloudflare Worker)

Tape `/carte` dans Discord, écris le nom (l'autocomplétion propose les cartes avec numéro + set), et tu reçois :
prix Cardmarket (tendance, min, 24 h / 7 j / 30 j, holo), TCGplayer US, fiche (set, date, rareté, illustrateur),
et un indice « Potentiel » /5 expliqué (rareté, momentum, âge du set, popularité).

## Déploiement (une fois)
1. Discord Developer Portal → New Application « PokéWatch » → Bot → Reset Token (à coller dans Cloudflare, jamais ailleurs).
   Note l'**Application ID** et la **Public Key** (onglet General Information).
2. Cloudflare → Workers & Pages → Create → Import a repository → ce repo, root directory `discord-carte`.
   Settings → Variables and Secrets : `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_TOKEN`.
3. Ouvre `https://<ton-worker>.workers.dev/register` → doit afficher `register → 200`.
4. Developer Portal → General Information → **Interactions Endpoint URL** = `https://<ton-worker>.workers.dev` → Save.
5. Inviter le bot : OAuth2 → URL Generator → scope `applications.commands` → ouvrir l'URL → choisir le serveur.

Données : [TCGdex](https://tcgdex.dev) (gratuit, sans clé, noms FR, Cardmarket maj quotidienne).

Worker : https://pokewatch-carte.alexis-valles76290.workers.dev (déployé automatiquement par Cloudflare Workers Builds à chaque commit dans `discord-carte/`).
