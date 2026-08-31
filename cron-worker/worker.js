// PokéWatch CRON — Cloudflare Worker déclenché chaque minute (gratuit).
// Surveille Dealabs (RSS) + boutiques Shopify, alerte Discord via webhook.
// Bindings : KV "STATE" ; secret DISCORD_WEBHOOK_URL. Cron : * * * * * (wrangler.toml)

const CONFIG = {
  must_match: [/pok[eé]mon/i, /pkmn/i, /\btcg\b/i, /jcc pok/i],
  exclude: [/peluche/i, /figurine/i, /funko/i, /lego/i, /sac [àa] dos/i, /classeur/i, /portfolio/i, /sleeves/i,
            /prot[èe]ge[- ]cartes/i, /playmat/i, /tapis de jeu/i, /deck box/i, /\bswitch\b/i, /jeu vid[ée]o/i, /manette/i,
            /console/i, /amiibo/i, /t-shirt/i, /pyjama/i, /gourde/i, /trousse/i, /cahier/i, /agenda/i, /puzzle/i,
            /lot de \d+ cartes/i, /carte [àa] l.unit[ée]/i, /\bsingle/i, /psa \d/i, /grad[ée]e/i, /cor[ée]en/i, /japonais/i,
            /japanese/i, /\bjp\b/i, /\bkr\b/i, /chinois/i, /\banglais\b/i, /occasion/i, /pack commun/i, /pack rare/i],
  max_price: { display: 189, demi_display: 99, etb: 49.9, bundle: 29.9, tripack: 15, coffret: 29.9, tin: 22, blister: 7, booster: 5 },
  alert_if_price_unknown: true,
  feeds: [
    { name: "Dealabs nouveaux", url: "https://www.dealabs.com/rss/nouveaux" },
    { name: "Dealabs hot", url: "https://www.dealabs.com/rss/hot" },
  ],
  shopify: [
    { name: "RelicTCG", url: "https://www.relictcg.com" },
    { name: "Boostrclub", url: "https://boostrclub.com" },
  ],
  max_alerts: 12,
};

const TYPES = [
  ["display", [/\bdisplay\b/, /bo[iî]te de 36/, /36 boosters/, /booster box/, /36 paquets/]],
  ["demi_display", [/18 boosters/, /demi[- ]display/, /half[- ]display/, /18 paquets/]],
  ["etb", [/dresseur d.?[ée]lite/, /elite trainer/, /\betb\b/]],
  ["bundle", [/\bbundle\b/, /6 boosters/, /pack de 6/]],
  ["tripack", [/tri[- ]?pack/, /3 boosters/]],
  ["tin", [/\btin\b/, /bo[iî]te m[ée]tal/, /pok[ée]box m[ée]tal/]],
  ["blister", [/\bblister\b/, /sleeved booster/, /booster sous blister/]],
  ["coffret", [/\bcoffret\b/, /\bbox\b/, /ultra[- ]premium/, /\bupc\b/, /collection premium/, /pok[ée]box/, /stade/]],
  ["booster", [/\bbooster/, /\bpaquet/]],
];
const LABEL = { display: "Display (36)", demi_display: "Demi-display (18)", etb: "Coffret Dresseur d'Élite", bundle: "Bundle 6 boosters",
  tripack: "Tripack", tin: "Tin / boîte métal", blister: "Blister", coffret: "Coffret / box", booster: "Booster" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); },
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/run") { const r = await run(env); return json(r); }
    if (u.pathname === "/state") { return json(await loadState(env)); }
    return new Response("PokéWatch cron — en ligne");
  },
};

const json = o => new Response(JSON.stringify(o, null, 1), { headers: { "content-type": "application/json" } });
const norm = s => (s || "").replace(/\s+/g, " ").trim();
const low = s => (s || "").toLowerCase();
const decode = s => (s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
const parsePrice = t => { const m = (t || "").match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur)/i) || (t || "").match(/(?:€|eur)\s*(\d{1,4}(?:[.,]\d{1,2})?)/i); return m ? parseFloat(m[1].replace(",", ".")) : null; };
const detectType = t => { const l = low(t); for (const [n, ps] of TYPES) if (ps.some(p => p.test(l))) return n; return null; };
const relevant = (title, blob) => CONFIG.must_match.some(r => r.test(blob || title)) && !CONFIG.exclude.some(r => r.test(title));
async function hash(s) { const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)); return [...new Uint8Array(b)].slice(0, 8).map(x => x.toString(16).padStart(2, "0")).join(""); }

function evaluate(title, price) {
  const t = detectType(title);
  if (!t) return null;
  const thr = CONFIG.max_price[t];
  if (price == null) return CONFIG.alert_if_price_unknown ? { t, thr, verdict: "check" } : null;
  return price <= thr ? { t, thr, verdict: "deal" } : null;
}

async function loadState(env) {
  const s = await env.STATE.get("state", "json");
  return s || { seen: {}, catalog: {}, last_run: null };
}

async function get(url, accept) {
  return fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9", Accept: accept || "*/*" }, cf: { cacheTtl: 0 } });
}

// ------------------------------------------------------------ RSS Dealabs
function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const pick = tag => { const r = it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)); return r ? decode(r[1]).trim() : ""; };
    items.push({ title: norm(pick("title")), link: pick("link") || pick("guid"), desc: norm(pick("description")).slice(0, 400),
      merchant: pick("pepper:merchant"), price: parsePrice(pick("pepper:price")) });
  }
  return items;
}

async function srcRss(feed, state, warm) {
  const out = [];
  let r; try { r = await get(feed.url, "application/rss+xml, application/xml;q=0.9, */*;q=0.8"); } catch (e) { console.log(feed.name, "fetch KO", e.message); return out; }
  if (!r.ok) { console.log(feed.name, "HTTP", r.status); return out; }
  const items = parseRss(await r.text());
  console.log(feed.name, items.length, "items");
  for (const it of items) {
    const id = await hash(it.link || it.title);
    if (state.seen[id]) continue;
    state.seen[id] = Date.now(); state.dirty = true;
    if (warm || !relevant(it.title, it.title + " " + it.desc)) continue;
    const price = parsePrice(it.title) ?? it.price ?? parsePrice(it.desc);
    const ev = evaluate(detectType(it.title) ? it.title : it.title + " " + it.desc, price);
    if (!ev) continue;
    out.push(embed(it.title, it.link, price, ev, feed.name, it.merchant, it.desc));
  }
  return out;
}

// ------------------------------------------------------------ Shopify
async function srcShopify(shop, state, warm) {
  const out = [];
  const cat = state.catalog[shop.name] || (state.catalog[shop.name] = {});
  const first = !Object.keys(cat).length;
  let r; try { r = await get(`${shop.url}/products.json?limit=250`, "application/json"); } catch (e) { console.log(shop.name, "fetch KO", e.message); return out; }
  if (!r.ok) { console.log(shop.name, "HTTP", r.status); return out; }
  const prods = (await r.json()).products || [];
  console.log(shop.name, prods.length, "produits");
  for (const p of prods) {
    const title = norm(p.title);
    if (!relevant(title)) continue;
    const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(x => !isNaN(x));
    const price = prices.length ? Math.min(...prices) : null;
    const avail = (p.variants || []).some(v => v.available !== false);
    const key = String(p.id), prev = cat[key];
    if (!prev || prev.price !== price || prev.available !== avail) state.dirty = true;
    cat[key] = { price, available: avail, seen: Date.now(), alerted: prev?.alerted };
    if (warm || first || !avail) continue;
    const ev = evaluate(title, price);
    if (!ev) continue;
    let reason = null;
    if (!prev) reason = "🆕 nouveau";
    else if (prev.price != null && price != null && price < prev.price - 0.009) reason = `📉 baisse (${prev.price.toFixed(2)} → ${price.toFixed(2)} €)`;
    else if (prev.available === false) reason = "📦 restock";
    if (!reason || (cat[key].alerted === price && reason === "🆕 nouveau")) continue;
    cat[key].alerted = price; state.dirty = true;
    out.push(embed(title, `${shop.url}/products/${p.handle}`, price, ev, shop.name, null, reason));
  }
  const cutoff = Date.now() - 60 * 864e5;
  for (const k of Object.keys(cat)) if (cat[k].seen < cutoff) { delete cat[k]; state.dirty = true; }
  return out;
}

// ------------------------------------------------------------ Discord
function embed(title, url, price, ev, source, merchant, desc) {
  const colors = { deal: 0x2ECC71, check: 0xF1C40F };
  const fields = [
    { name: "Prix", value: price != null ? `**${price.toFixed(2)} €**` : "prix non détecté", inline: true },
    { name: "Type", value: LABEL[ev.t], inline: true },
    { name: "Seuil", value: `≤ ${ev.thr.toFixed(2)} €`, inline: true },
    { name: "Source", value: source, inline: true },
  ];
  if (merchant) fields.push({ name: "Marchand", value: merchant, inline: true });
  return { title: title.slice(0, 250), url, color: colors[ev.verdict], fields, description: desc ? desc.slice(0, 300) : undefined,
    footer: { text: "PokéWatch ⚡ 1 min" }, timestamp: new Date().toISOString() };
}

async function discord(env, payload) {
  if (!env.DISCORD_WEBHOOK_URL) { console.log("webhook manquant"); return false; }
  const r = await fetch(env.DISCORD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "PokéWatch", ...payload }) });
  if (r.status === 429) { await new Promise(x => setTimeout(x, 2000)); return discord(env, payload); }
  return r.ok;
}

// ------------------------------------------------------------ main
async function run(env) {
  const state = await loadState(env);
  const warm = !Object.keys(state.seen).length;
  const cutoff = Date.now() - 45 * 864e5;
  for (const k of Object.keys(state.seen)) if (state.seen[k] < cutoff) { delete state.seen[k]; state.dirty = true; }

  let alerts = [];
  for (const f of CONFIG.feeds) alerts.push(...await srcRss(f, state, warm));
  for (const s of CONFIG.shopify) alerts.push(...await srcShopify(s, state, warm));

  if (warm) await discord(env, { content: `⚡ PokéWatch 1 min actif — ${Object.keys(state.seen).length} deals et ${Object.values(state.catalog).reduce((a, c) => a + Object.keys(c).length, 0)} produits indexés. Alertes en temps quasi réel à partir de maintenant.` });
  let sent = 0;
  for (const e of alerts.slice(0, CONFIG.max_alerts)) { if (await discord(env, { embeds: [e] })) sent++; await new Promise(x => setTimeout(x, 600)); }
  if (alerts.length > CONFIG.max_alerts) await discord(env, { content: `⚠️ ${alerts.length - CONFIG.max_alerts} alertes non envoyées (limite par run).` });

  state.last_run = new Date().toISOString();
  if (state.dirty || warm) { delete state.dirty; await env.STATE.put("state", JSON.stringify(state)); }
  return { sent, alerts: alerts.length, seen: Object.keys(state.seen).length, warm, last_run: state.last_run };
}
