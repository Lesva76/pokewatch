// PokéWatch — commande Discord /carte  (Cloudflare Worker, gratuit)
// Secrets Cloudflare : DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID, DISCORD_TOKEN
// 1) Déployer  2) ouvrir https://<worker>/register  3) coller l'URL du worker dans
//    "Interactions Endpoint URL" de l'app Discord (Developer Portal).

const TCGDEX = "https://api.tcgdex.net/v2/fr";
const T = { PING: 1, CMD: 2, AUTOCOMPLETE: 4 };
const R = { PONG: 1, MSG: 4, DEFER: 5, CHOICES: 8 };

let SETS = null; // cache set id → {name, releaseDate}

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

    if (it.type === T.AUTOCOMPLETE && it.data?.name === "carte") {
      const focused = (it.data.options || []).find(o => o.focused);
      return json({ type: R.CHOICES, data: { choices: await autocomplete(focused?.value || "") } });
    }

    if (it.type === T.CMD && it.data?.name === "carte") {
      const opts = Object.fromEntries((it.data.options || []).map(o => [o.name, o.value]));
      ctx.waitUntil(handleCarte(opts, it, env));
      return json({ type: R.DEFER });
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
  const cmd = {
    name: "carte", description: "Prix actuel + potentiel d'une carte Pokémon (Cardmarket)",
    options: [
      { name: "carte", type: 3, required: true, autocomplete: true,
        description: "Nom + numéro (ex: Dracaufeu ex 125) — l'autocomplétion propose les cartes" },
    ],
  };
  const r = await fetch(`https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/commands`, {
    method: "PUT", headers: { "content-type": "application/json", authorization: `Bot ${env.DISCORD_TOKEN}` },
    body: JSON.stringify([cmd]),
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
  if (SETS) return SETS;
  const list = await fetch(`${TCGDEX}/sets`).then(r => r.ok ? r.json() : []);
  SETS = Object.fromEntries(list.map(s => [s.id, { name: s.name, releaseDate: s.releaseDate }]));
  return SETS;
}

async function searchCards(name) {
  const q = name.split(" ")[0];
  if (q.length < 2) return [];
  const list = await fetch(`${TCGDEX}/cards?name=${encodeURIComponent(q)}`).then(r => r.ok ? r.json() : []);
  const want = name;
  let hits = list.filter(c => norm(c.name) === want);
  if (!hits.length) hits = list.filter(c => norm(c.name).startsWith(want));
  if (!hits.length) hits = list.filter(c => norm(c.name).includes(want) || want.includes(norm(c.name)));
  if (!hits.length) hits = list;
  return hits;
}

async function autocomplete(input) {
  try {
    if (input.startsWith("id:")) return [];
    const { name, num } = parseQuery(input);
    if (name.length < 2) return [];
    const [hits, sets] = await Promise.all([searchCards(name), getSets()]);
    let c = hits;
    if (num) c = c.filter(x => numOf(x.localId) === num).concat(c.filter(x => numOf(x.localId).startsWith(num) && numOf(x.localId) !== num));
    c = c.slice().reverse().slice(0, 25); // récents en premier
    return c.map(x => {
      const setId = x.id.split("-")[0];
      const label = `${x.name} — n°${x.localId} · ${sets[setId]?.name || setId}`;
      return { name: label.slice(0, 100), value: `id:${x.id}` };
    });
  } catch { return []; }
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
      if (!hits.length) return followup(it, env, { content: `❌ Aucune carte trouvée pour **${input}**. Essaie le nom FR + numéro, ex : \`Dracaufeu ex 125\`.` });
      if (hits.length > 1) {
        const sets = await getSets();
        const lines = hits.slice(-12).reverse().map(c => `• **${c.name}** — n°${c.localId} · ${sets[c.id.split("-")[0]]?.name || c.id}`).join("\n");
        return followup(it, env, { content: `🔎 ${hits.length} cartes correspondent — refais \`/carte\` en choisissant dans l'autocomplétion, ou ajoute le numéro :\n${lines}` });
      }
      cardId = hits[0].id;
    }

    const card = await fetch(`${TCGDEX}/cards/${cardId}`).then(r => r.ok ? r.json() : null);
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
