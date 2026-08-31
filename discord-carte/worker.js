// PokéWatch — commande Discord /carte  (Cloudflare Worker, gratuit)
// Secrets Cloudflare : DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID, DISCORD_TOKEN
// 1) Déployer  2) ouvrir https://<worker>/register  3) coller l'URL du worker dans
//    "Interactions Endpoint URL" de l'app Discord (Developer Portal).

const TCGDEX = "https://api.tcgdex.net/v2/fr";
const T = { PING: 1, CMD: 2, COMPONENT: 3, AUTOCOMPLETE: 4 };
const R = { PONG: 1, MSG: 4, DEFER: 5, DEFER_UPDATE: 6, UPDATE: 7, CHOICES: 8 };
const PER = 25; // cartes par page (max Discord pour un menu déroulant)

let SETS = null, SETS_AT = 0; // cache set id → {name, releaseDate}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/register") return registerCommands(env);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/debug") return debug(env);
    if (req.method !== "POST") return new Response("PokéWatch /carte — en ligne");

    const body = await req.text();
    if (!(await verify(req, body, env.DISCORD_PUBLIC_KEY))) return new Response("bad signature", { status: 401 });
    const it = JSON.parse(body);

    if (it.type === T.PING) return json({ type: R.PONG });

    if (it.type === T.AUTOCOMPLETE) {
      const focused = (it.data.options || []).find(o => o.focused);
      const v = focused?.value || "";
      const choices = it.data?.name === "set" ? await autocompleteSet(v) : await autocomplete(v);
      return json({ type: R.CHOICES, data: { choices } });
    }

    if (it.type === T.CMD && it.data?.name === "carte") {
      const opts = Object.fromEntries((it.data.options || []).map(o => [o.name, o.value]));
      ctx.waitUntil(handleCarte(opts, it, env));
      return json({ type: R.DEFER });
    }

    if (it.type === T.CMD && it.data?.name === "set") {
      const opts = Object.fromEntries((it.data.options || []).map(o => [o.name, o.value]));
      ctx.waitUntil(handleSet(opts, it, env));
      return json({ type: R.DEFER });
    }

    if (it.type === T.COMPONENT) {
      const cid = it.data?.custom_id || "";
      if (cid === "pick") { // une carte choisie dans le menu → fiche complète en nouveau message
        ctx.waitUntil(handleCarte({ carte: it.data.values[0] }, it, env));
        return json({ type: R.DEFER });
      }
      if (cid.startsWith("pg|")) { // page précédente / suivante
        ctx.waitUntil(turnPage(cid, it, env));
        return json({ type: R.DEFER_UPDATE });
      }
      return json({ type: R.DEFER_UPDATE });
    }
    return json({ type: R.MSG, data: { content: "Commande inconnue", flags: 64 } });
  },
};

// ------------------------------------------------------------------ Discord plumbing
async function importEd25519(pubKeyHex) {
  try {
    return [await crypto.subtle.importKey("raw", hex(pubKeyHex), { name: "Ed25519" }, false, ["verify"]), { name: "Ed25519" }];
  } catch {
    const alg = { name: "NODE-ED25519", namedCurve: "NODE-ED25519" };
    return [await crypto.subtle.importKey("raw", hex(pubKeyHex), alg, false, ["verify"]), alg];
  }
}

async function verify(req, body, pubKeyHex) {
  const sig = req.headers.get("x-signature-ed25519");
  const ts = req.headers.get("x-signature-timestamp");
  if (!sig || !ts || !pubKeyHex) return false;
  try {
    const [key, alg] = await importEd25519(pubKeyHex);
    return await crypto.subtle.verify(alg, key, hex(sig), new TextEncoder().encode(ts + body));
  } catch { return false; }
}

async function debug(env) {
  const out = { app_id: !!env.DISCORD_APPLICATION_ID, public_key: !!env.DISCORD_PUBLIC_KEY, token: !!env.DISCORD_TOKEN };
  try { const [, alg] = await importEd25519(env.DISCORD_PUBLIC_KEY || "00".repeat(32)); out.ed25519 = alg.name; }
  catch (e) { out.ed25519 = "KO: " + e.message; }
  try { const r = await fetch(`${TCGDEX}/sets`); out.tcgdex = r.status; } catch (e) { out.tcgdex = "KO: " + e.message; }
  return json(out);
}
const hex = h => new Uint8Array(h.match(/.{1,2}/g).map(b => parseInt(b, 16)));
const json = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

async function followup(it, env, payload) {
  return fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${it.token}/messages/@original`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

async function registerCommands(env) {
  if (!env.DISCORD_TOKEN || !env.DISCORD_APPLICATION_ID) return new Response("DISCORD_TOKEN / DISCORD_APPLICATION_ID manquants", { status: 500 });
  const cmds = [
    {
      name: "carte", description: "Prix actuel + potentiel d'une carte Pokémon (Cardmarket)",
      options: [
        { name: "carte", type: 3, required: true, autocomplete: true,
          description: "Nom + numéro (ex: Dracaufeu ex 125) — l'autocomplétion propose les cartes" },
      ],
    },
    {
      name: "set", description: "Parcourir toutes les cartes d'un set (les plus récents en premier)",
      options: [
        { name: "set", type: 3, required: false, autocomplete: true,
          description: "Nom du set — laisse vide pour les dernières sorties" },
      ],
    },
  ];
  const r = await fetch(`https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/commands`, {
    method: "PUT", headers: { "content-type": "application/json", authorization: `Bot ${env.DISCORD_TOKEN}` },
    body: JSON.stringify(cmds),
  });
  return new Response(`register → ${r.status}\n${await r.text()}`);
}

// ------------------------------------------------------------------ TCGdex
const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const numOf = s => { const m = String(s || "").match(/[A-Za-z]{0,3}\d+/); return m ? m[0].replace(/^0+(?=\d)/, "").toUpperCase() : ""; };

// "Dracaufeu ex 125/197" → { name: "dracaufeu ex", num: "125" }
function parseQuery(q) {
  q = (q || "").trim();
  const m = q.match(/^(.*?)[\s#n°]*([A-Za-z]{0,3}\d{1,3})(?:\s*\/\s*\d+)?\s*$/);
  if (m && norm(m[1])) return { name: norm(m[1]), num: numOf(m[2]) };
  return { name: norm(q), num: "" };
}

async function getSets() {
  if (SETS && Date.now() - SETS_AT < 6 * 3600e3) return SETS;
  const list = await fetch(`${TCGDEX}/sets`).then(r => r.ok ? r.json() : []);
  if (list.length) {
    SETS = Object.fromEntries(list.map(s => [s.id, { name: s.name, releaseDate: s.releaseDate, cardCount: s.cardCount }]));
    SETS_AT = Date.now();
  }
  return SETS || {};
}

// libellé « Dracaufeu-ex — n°125 · Flammes Obsidiennes (2023) », tronqué à 100 caractères
function cardLabel(c, sets) {
  const s = sets[c.id.split("-")[0]] || {};
  const yr = s.releaseDate ? ` (${s.releaseDate.slice(0, 4)})` : "";
  const head = `${c.name} — n°${c.localId} · `;
  let sn = s.name || c.id.split("-")[0];
  if ((head + sn + yr).length > 100) sn = sn.slice(0, Math.max(3, 100 - head.length - yr.length - 1)) + "…";
  return (head + sn + yr).slice(0, 100);
}
const setDate = (c, sets) => (sets[c.id.split("-")[0]] || {}).releaseDate || "0000-00-00";

// ------------------------------------------------------------------ recherche large (on remplit les 25 choix Discord)
const QCACHE = new Map(); // terme → cartes (cache mémoire du worker)

async function fetchByName(lang, term) {
  const key = `${lang}:${term}`;
  if (QCACHE.has(key)) return QCACHE.get(key);
  let list = [];
  try {
    const r = await fetch(`https://api.tcgdex.net/v2/${lang}/cards?name=${encodeURIComponent(term)}`);
    if (r.ok) list = await r.json();
  } catch {}
  if (QCACHE.size > 80) QCACHE.clear();
  QCACHE.set(key, list);
  return list;
}

// termes envoyés à l'API : mot le plus long, premier mot, préfixe (rattrape les fautes de frappe)
const STOP = /^(ex|gx|v|vmax|vstar|de|la|le|du|des|et)$/;
function terms(name) {
  const words = name.split(" ").filter(w => w.length >= 2 && !STOP.test(w));
  const bylen = words.slice().sort((a, b) => b.length - a.length);
  const out = [];
  for (const w of [bylen[0], name.split(" ")[0], bylen[0] && bylen[0].slice(0, 5), bylen[1]])
    if (w && w.length >= 2 && !out.includes(w)) out.push(w);
  return out.slice(0, 3);
}

// wide = on garde aussi les correspondances faibles + on interroge l'anglais
async function searchCards(name, wide = false) {
  const ts = terms(name);
  if (!ts.length) return [];
  const seen = new Map();
  const add = list => { for (const c of list) if (c && c.id && !seen.has(c.id)) seen.set(c.id, c); };

  add((await Promise.all(ts.map(t => fetchByName("fr", t)))).flat());
  if (wide || seen.size < 25) add((await Promise.all(ts.map(t => fetchByName("en", t)))).flat());

  const words = name.split(" ").filter(Boolean);
  const scored = [...seen.values()].map(c => {
    const n = norm(c.name);
    let s = 10;
    if (n === name) s = 100;
    else if (n.startsWith(name)) s = 80;
    else if (n.includes(name)) s = 65;
    else if (words.length && words.every(w => n.includes(w))) s = 50;
    else if (n.includes(ts[0])) s = 35;
    else if (words.some(w => w.length >= 3 && n.includes(w))) s = 20;
    return { c, s };
  }).filter(x => wide || x.s > 10);
  return scored.sort((a, b) => b.s - a.s).map(x => x.c);
}

async function autocomplete(input) {
  try {
    if (input.startsWith("id:")) return [];
    const { name, num } = parseQuery(input);
    if (name.length < 2) return [];
    let [hits, sets] = await Promise.all([searchCards(name), getSets()]);
    if (hits.length < 25) hits = await searchCards(name, true); // 2e passe, cache → quasi gratuit

    const date = c => (sets[c.id.split("-")[0]] || {}).releaseDate || "0000-00-00";
    const rank = c => {
      const n = norm(c.name);
      let s = n === name ? 4 : n.startsWith(name) ? 3 : n.includes(name) ? 2 : 1;
      if (num) { const ln = numOf(c.localId); s += ln === num ? 20 : ln.startsWith(num) ? 10 : 0; }
      return s;
    };
    const out = hits.sort((a, b) => rank(b) - rank(a) || date(b).localeCompare(date(a))).slice(0, 25);

    return out.map(x => ({ name: cardLabel(x, sets), value: `id:${x.id}` }));
  } catch { return []; }
}

// ------------------------------------------------------------------ sets : autocomplétion + navigateur paginé
async function autocompleteSet(input) {
  const sets = await getSets();
  const q = norm(input);
  let list = Object.entries(sets).map(([id, s]) => ({ id, ...s }));
  if (q.length >= 2) list = list.filter(s => norm(s.name).includes(q) || norm(s.id).includes(q));
  list.sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || ""));
  return list.slice(0, 25).map(s => ({
    name: `${s.name}${s.releaseDate ? " (" + s.releaseDate.slice(0, 4) + ")" : ""}${s.cardCount?.total ? " · " + s.cardCount.total + " cartes" : ""}`.slice(0, 100),
    value: `sid:${s.id}`,
  }));
}

// kind "n" = recherche par nom, "s" = set entier. key est encodé pour tenir dans custom_id (100 car.)
async function cardsFor(kind, key, sets) {
  if (kind === "s") {
    const set = await fetch(`${TCGDEX}/sets/${key}`).then(r => r.ok ? r.json() : null);
    const cards = (set?.cards || []).slice().sort((a, b) => {
      const na = parseInt(a.localId, 10), nb = parseInt(b.localId, 10);
      return (isNaN(na) ? 1e9 : na) - (isNaN(nb) ? 1e9 : nb);
    });
    return { cards, title: `${set?.name || key} — ${cards.length} cartes` };
  }
  const cards = await searchCards(norm(key), true);
  cards.sort((a, b) => setDate(b, sets).localeCompare(setDate(a, sets)));
  return { cards, title: `${cards.length} cartes pour « ${key} »` };
}

async function browsePayload(kind, key, page) {
  const sets = await getSets();
  const { cards, title } = await cardsFor(kind, key, sets);
  if (!cards.length) return { content: `❌ Rien trouvé pour **${key}**.`, embeds: [], components: [] };

  const pages = Math.max(1, Math.ceil(cards.length / PER));
  page = Math.max(0, Math.min(page, pages - 1));
  const slice = cards.slice(page * PER, page * PER + PER);

  const lines = slice.map((c, i) => `\`${String(page * PER + i + 1).padStart(3)}\` ${cardLabel(c, sets)}`).join("\n");
  const k = encodeURIComponent(String(key)).slice(0, 80);
  const embed = {
    title: title.slice(0, 250),
    description: lines.slice(0, 4000),
    color: 0x5865F2,
    footer: { text: `Page ${page + 1}/${pages} · choisis une carte dans le menu pour voir son prix` },
  };
  const options = slice.map(c => {
    const s = sets[c.id.split("-")[0]] || {};
    return {
      label: `${c.name} — n°${c.localId}`.slice(0, 100),
      value: `id:${c.id}`,
      description: `${s.name || c.id.split("-")[0]}${s.releaseDate ? " · " + s.releaseDate.slice(0, 4) : ""}`.slice(0, 100),
    };
  });
  return {
    content: "",
    embeds: [embed],
    components: [
      { type: 1, components: [{ type: 3, custom_id: "pick", placeholder: "Voir le prix d'une carte…", options }] },
      { type: 1, components: [
        { type: 2, style: 2, label: "◀", custom_id: `pg|${kind}|${page - 1}|${k}`, disabled: page === 0 },
        { type: 2, style: 2, label: `Page ${page + 1}/${pages}`, custom_id: "noop", disabled: true },
        { type: 2, style: 2, label: "▶", custom_id: `pg|${kind}|${page + 1}|${k}`, disabled: page >= pages - 1 },
      ] },
    ],
  };
}

async function turnPage(cid, it, env) {
  try {
    const [, kind, pageStr, ...rest] = cid.split("|");
    const key = decodeURIComponent(rest.join("|"));
    return followup(it, env, await browsePayload(kind, key, parseInt(pageStr, 10) || 0));
  } catch (e) {
    return followup(it, env, { content: `⚠️ Erreur : ${e.message}` });
  }
}

async function handleSet(opts, it, env) {
  try {
    const raw = opts.set || "";
    let id = raw.startsWith("sid:") ? raw.slice(4) : null;
    if (!id) {
      const sets = await getSets();
      const q = norm(raw);
      const list = Object.entries(sets).map(([sid, s]) => ({ sid, ...s }))
        .sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || ""));
      id = (q ? list.find(s => norm(s.name).includes(q)) : list[0])?.sid;
      if (!id) return followup(it, env, { content: `❌ Set introuvable pour **${raw}**. Utilise l'autocomplétion.` });
    }
    return followup(it, env, await browsePayload("s", id, 0));
  } catch (e) {
    return followup(it, env, { content: `⚠️ Erreur : ${e.message}` });
  }
}

const pct = (a, b) => (a && b) ? ((a - b) / b * 100) : null;
const eur = v => (v == null || v === 0) ? "—" : `${Number(v).toFixed(2)} €`;
const fmtPct = p => p == null ? "" : ` (${p >= 0 ? "+" : ""}${p.toFixed(0)} %)`;

function potentiel(card, cm, set) {
  let score = 2, rareBonus = 0; const why = [];
  const rar = norm(card.rarity);
  if (/illustration speciale|special illustration|hyper rare|secret/.test(rar)) { rareBonus = 1.5; why.push("rareté top (SIR / hyper) → demande collectionneurs durable"); }
  else if (/illustration rare|ultra rare|shiny/.test(rar)) { rareBonus = 1; why.push("rareté élevée"); }
  else if (/double rare|holo rare|rare/.test(rar)) { rareBonus = 0.25; }
  else if (/commune|common/.test(rar)) { rareBonus = -1.5; why.push("commune / peu commune → quasi jamais de plus-value"); }
  score += rareBonus;

  const trend = cm?.trend || cm?.["trend-holo"], a7 = cm?.avg7 || cm?.["avg7-holo"], a30 = cm?.avg30 || cm?.["avg30-holo"];
  const m30 = pct(trend, a30);
  if (m30 != null) {
    if (m30 > 15) { score += 1; why.push(`momentum fort : +${m30.toFixed(0)} % vs moyenne 30 j`); }
    else if (m30 > 5) { score += 0.5; why.push(`légère hausse (+${m30.toFixed(0)} % / 30 j)`); }
    else if (m30 < -12) { score -= 1; why.push(`en baisse (${m30.toFixed(0)} % / 30 j)`); }
    else why.push("prix stable sur 30 j");
  }
  if (set?.releaseDate) {
    const months = (Date.now() - new Date(set.releaseDate)) / 2.6e9;
    if (months < 6) { score -= 0.5; why.push("set récent : les prix baissent souvent 6-12 mois après la sortie"); }
    else if (months > 30) { score += 0.5; why.push("set ancien / plus imprimé → l'offre se raréfie"); }
  }
  const n = norm(card.name);
  if (rareBonus >= 1 && /dracaufeu|pikachu|evoli|mew|rayquaza|lugia|umbreon|noctali|gardevoir|mewtwo|lucario/.test(n)) { score += 0.5; why.push("Pokémon très recherché"); }
  if (trend >= 100) why.push("carte déjà chère : hausse en % plus lente, mais valeur refuge");
  if (cm?.low && trend && cm.low < trend * 0.6) why.push(`écart min/tendance important (${eur(cm.low)} vs ${eur(trend)}) → des bonnes affaires à chasser`);
  score = Math.max(0, Math.min(5, score));
  const label = score >= 4 ? "🔥 Intéressant" : score >= 3 ? "🙂 Correct" : score >= 2 ? "😐 Neutre" : "❄️ Faible";
  return { score, label, why };
}

async function handleCarte(opts, it, env) {
  try {
    const input = opts.carte || "";
    let cardId = null, hits = [];
    if (input.startsWith("id:")) cardId = input.slice(3);
    else {
      const { name, num } = parseQuery(input);
      hits = await searchCards(name);
      if (num) { const byNum = hits.filter(c => numOf(c.localId) === num); if (byNum.length) hits = byNum; }
      const exact = hits.filter(c => norm(c.name) === name); if (exact.length) hits = exact;
      if (!hits.length) return followup(it, env, { content: `❌ Aucune carte trouvée pour **${input}**. Essaie le nom FR + numéro, ex : \`Dracaufeu ex 125\`.` });
      if (hits.length > 1) return followup(it, env, await browsePayload("n", input, 0));
      cardId = hits[0].id;
    }

    let card = await fetch(`${TCGDEX}/cards/${cardId}`).then(r => r.ok ? r.json() : null);
    if (!card) card = await fetch(`https://api.tcgdex.net/v2/en/cards/${cardId}`).then(r => r.ok ? r.json() : null);
    if (!card) return followup(it, env, { content: "❌ Carte introuvable." });
    const set = await fetch(`${TCGDEX}/sets/${card.set.id}`).then(r => r.ok ? r.json() : null);
    const cm = card.pricing?.cardmarket, tp = card.pricing?.tcgplayer;
    const holo = cm && (cm["trend-holo"] || cm["avg-holo"]);
    const pot = potentiel(card, cm, set);

    const fields = [];
    if (cm && (cm.trend || cm.avg)) {
      const t = cm.trend || cm.avg, a7 = cm.avg7, a30 = cm.avg30;
      fields.push({ name: "💶 Cardmarket", inline: true,
        value: `Tendance **${eur(t)}**\nMin ${eur(cm.low)} · 24 h ${eur(cm.avg1)}\n7 j ${eur(a7)}${fmtPct(pct(t, a7))}\n30 j ${eur(a30)}${fmtPct(pct(t, a30))}` });
      if (holo) fields.push({ name: "✨ Holo / reverse", inline: true,
        value: `Tendance **${eur(cm["trend-holo"])}**\nMin ${eur(cm["low-holo"])}\n7 j ${eur(cm["avg7-holo"])}\n30 j ${eur(cm["avg30-holo"])}` });
    } else fields.push({ name: "💶 Cardmarket", value: "pas de prix référencé pour cette carte", inline: true });
    if (tp) {
      const v = tp.holofoil || tp.normal || tp["reverse-holofoil"] || Object.values(tp).find(x => x && typeof x === "object");
      if (v?.marketPrice) fields.push({ name: "🇺🇸 TCGplayer", value: `Market **$${v.marketPrice}**\nLow $${v.lowPrice ?? "—"}`, inline: true });
    }
    fields.push({ name: `📈 Potentiel : ${pot.label} (${pot.score.toFixed(1)}/5)`, inline: false,
      value: (pot.why.length ? pot.why.map(w => "• " + w).join("\n") : "• pas assez de données") + "\n_Indicateurs basés sur les tendances Cardmarket — pas un conseil financier._" });

    const cmUrl = cm?.idProduct ? `https://www.cardmarket.com/fr/Pokemon/Products/Singles?idProduct=${cm.idProduct}`
      : `https://www.cardmarket.com/fr/Pokemon/Products/Search?searchString=${encodeURIComponent(card.name + " " + card.localId)}`;
    const embed = {
      title: `${card.name} — n°${card.localId}/${card.set.cardCount?.official ?? "?"}`,
      url: cmUrl,
      description: `${card.set.name}${set?.releaseDate ? " · sorti le " + set.releaseDate : ""} · ${card.rarity || "rareté ?"}${card.illustrator ? " · illu. " + card.illustrator : ""}`,
      color: pot.score >= 4 ? 0xE67E22 : pot.score >= 3 ? 0x2ECC71 : pot.score >= 2 ? 0x95A5A6 : 0x3498DB,
      thumbnail: card.image ? { url: `${card.image}/high.webp` } : undefined,
      fields,
      footer: { text: `Cardmarket maj ${cm?.updated ? cm.updated.slice(0, 10) : "?"} · données TCGdex · demandé par ${it.member?.user?.global_name || it.member?.user?.username || "?"}` },
    };
    return followup(it, env, { embeds: [embed] });
  } catch (e) {
    return followup(it, env, { content: `⚠️ Erreur : ${e.message}` });
  }
}
