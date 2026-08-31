#!/usr/bin/env python3
"""
pokewatch — surveille Dealabs (RSS) + pages produit (watchlist) et ping Discord
dès qu'un produit Pokémon TCG (booster / display / ETB / coffret...) passe sous ton prix max.
Tourne sur GitHub Actions. État persistant dans state.json (commit auto).
"""
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import feedparser
import requests
from bs4 import BeautifulSoup

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(ROOT, "config.json")
STATE_PATH = os.path.join(ROOT, "state.json")

WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
EXTRA_FEEDS = [u.strip() for u in os.environ.get("EXTRA_FEEDS", "").split(",") if u.strip()]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6",
           "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}

MAX_ALERTS_PER_RUN = 12
SEEN_TTL_DAYS = 45

# Ordre = priorité (display avant booster, etb avant coffret, etc.)
TYPES = [
    ("display",      [r"\bdisplay\b", r"bo[iî]te de 36", r"36 boosters", r"booster box", r"36 paquets"]),
    ("demi_display", [r"18 boosters", r"demi[- ]display", r"half[- ]display", r"18 paquets"]),
    ("etb",          [r"dresseur d.?[ée]lite", r"elite trainer", r"\betb\b"]),
    ("bundle",       [r"\bbundle\b", r"6 boosters", r"pack de 6"]),
    ("tripack",      [r"tri[- ]?pack", r"3 boosters"]),
    ("tin",          [r"\btin\b", r"bo[iî]te m[ée]tal", r"pok[ée]box m[ée]tal"]),
    ("blister",      [r"\bblister\b", r"sleeved booster", r"booster sous blister"]),
    ("coffret",      [r"\bcoffret\b", r"\bbox\b", r"ultra[- ]premium", r"\bupc\b", r"collection premium",
                      r"pok[ée]box", r"stade", r"coffret collection"]),
    ("booster",      [r"\bbooster", r"\bpaquet"]),
]
TYPE_LABEL = {
    "display": "Display (36)", "demi_display": "Demi-display (18)", "etb": "Coffret Dresseur d'Élite",
    "bundle": "Bundle 6 boosters", "tripack": "Tripack", "tin": "Tin / boîte métal",
    "blister": "Blister", "coffret": "Coffret / box", "booster": "Booster",
}

PRICE_RE = re.compile(r"(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur)", re.I)
PRICE_RE2 = re.compile(r"(?:€|eur)\s*(\d{1,4}(?:[.,]\d{1,2})?)", re.I)


# ----------------------------------------------------------------------------- utils
def log(*a):
    print(*a, flush=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        log(f"[warn] {path} illisible ({e}), reset")
        return default


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)


def norm(s):
    return re.sub(r"\s+", " ", (s or "")).strip()


def strip_html(s):
    if not s:
        return ""
    return norm(BeautifulSoup(s, "lxml").get_text(" "))


def parse_price(text):
    if not text:
        return None
    m = PRICE_RE.search(text) or PRICE_RE2.search(text)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", "."))
    except ValueError:
        return None


def detect_type(text):
    t = text.lower()
    for name, pats in TYPES:
        for p in pats:
            if re.search(p, t):
                return name
    return None


def matches_any(patterns, text):
    t = text.lower()
    return any(re.search(p, t) for p in patterns)


def item_id(*parts):
    return hashlib.sha1("|".join(norm(p) for p in parts).encode()).hexdigest()[:16]


# ----------------------------------------------------------------------------- discord
def discord(embed=None, content=None):
    if not WEBHOOK:
        log("[discord] DISCORD_WEBHOOK_URL manquant — message non envoyé:", content or embed.get("title"))
        return False
    payload = {"username": "PokéWatch"}
    if content:
        payload["content"] = content
    if embed:
        payload["embeds"] = [embed]
    for attempt in range(3):
        r = requests.post(WEBHOOK, json=payload, timeout=20)
        if r.status_code in (200, 204):
            time.sleep(1.2)
            return True
        if r.status_code == 429:
            wait = float(r.json().get("retry_after", 2)) if r.headers.get("content-type", "").startswith("application/json") else 2
            time.sleep(wait + 0.5)
            continue
        log(f"[discord] HTTP {r.status_code}: {r.text[:200]}")
        return False
    return False


def build_embed(title, url, price, ptype, threshold, source, merchant=None, desc=None, verdict="deal"):
    colors = {"deal": 0x2ECC71, "check": 0xF1C40F, "watch": 0x3498DB}
    price_txt = f"**{price:.2f} €**" if price is not None else "prix non détecté"
    if ptype:
        thr_txt = f"≤ {threshold:.2f} €" if threshold is not None else "—"
        type_txt = TYPE_LABEL.get(ptype, ptype)
    else:
        thr_txt, type_txt = "—", "non identifié"
    fields = [
        {"name": "Prix", "value": price_txt, "inline": True},
        {"name": "Type", "value": type_txt, "inline": True},
        {"name": "Seuil", "value": thr_txt, "inline": True},
        {"name": "Source", "value": source, "inline": True},
    ]
    if merchant:
        fields.append({"name": "Marchand", "value": merchant, "inline": True})
    e = {
        "title": title[:250],
        "url": url,
        "color": colors.get(verdict, 0x95A5A6),
        "fields": fields,
        "footer": {"text": "PokéWatch"},
        "timestamp": now_iso(),
    }
    if desc:
        e["description"] = desc[:300]
    return e


# ----------------------------------------------------------------------------- sources
def http_get(url, accept=None, params=None, allow_proxy=True):
    h = dict(HEADERS)
    if accept:
        h["Accept"] = accept
    r = requests.get(url, headers=h, params=params, timeout=25)
    if r.status_code in (403, 429, 503) and allow_proxy:
        log(f"[http] {url} → HTTP {r.status_code}, retry via proxy")
        r = requests.get("https://api.allorigins.win/raw", params={"url": r.url}, timeout=35)
    return r


def fetch_feed(url):
    try:
        r = http_get(url, accept="application/rss+xml, application/xml;q=0.9, */*;q=0.8")
        if r.status_code != 200:
            log(f"[rss] {url} → HTTP {r.status_code}")
            return []
        fp = feedparser.parse(r.content)
        if fp.bozo and not fp.entries:
            log(f"[rss] {url} → parse KO ({fp.bozo_exception})")
            return []
        log(f"[rss] {url} → {len(fp.entries)} items")
        return fp.entries
    except Exception as e:
        log(f"[rss] {url} → erreur {e}")
        return []


def entry_extra(entry, key_part):
    """Champ namespacé (pepper:price / pepper:merchant...) quel que soit le préfixe."""
    for k, v in entry.items():
        if key_part in k.lower() and isinstance(v, str) and v.strip():
            return v.strip()
    return None


def evaluate(cfg, title, price):
    """→ (ptype, threshold, verdict) ou None si pas d'alerte."""
    ptype = detect_type(title)
    maxp = cfg.get("max_price", {})
    if ptype:
        thr = maxp.get(ptype)
        if price is None:
            return (ptype, thr, "check") if cfg.get("alert_if_price_unknown", True) else None
        if thr is not None and price <= thr:
            return (ptype, thr, "deal")
        return None
    if cfg.get("alert_untyped_pokemon_deals", False):
        return (None, None, "check")
    return None


def is_relevant(cfg, title, blob=None):
    return matches_any(cfg.get("must_match", []), blob or title) and not matches_any(cfg.get("exclude", []), title)


# --- RSS (Dealabs & co) : items nouveaux uniquement
def src_rss(cfg, src, state, warmup):
    alerts = []
    seen = state.setdefault("seen", {})
    for e in fetch_feed(src["url"]):
        title = norm(e.get("title", ""))
        link = e.get("link", "") or ""
        desc = strip_html(e.get("summary", "") or e.get("description", ""))
        iid = item_id(link or title)
        if iid in seen:
            continue
        seen[iid] = now_iso()
        if warmup or not is_relevant(cfg, title, f"{title} {desc}"):
            continue
        price = parse_price(title)
        if price is None:
            p2 = entry_extra(e, "price")
            price = parse_price(p2) if p2 else parse_price(desc)
        ev = evaluate(cfg, title if detect_type(title) else f"{title} {desc}", price)
        if not ev:
            log(f"[skip] {src['name']}: {title} ({price})")
            continue
        ptype, thr, verdict = ev
        alerts.append(build_embed(title, link, price, ptype, thr, src["name"], entry_extra(e, "merchant"), desc, verdict))
    return alerts


# --- Catalogue suivi (Shopify / listing) : nouveau produit, baisse de prix, restock
def track_products(cfg, src, state, warmup, products):
    """products: liste de dict(key, title, price, link, available). Gère l'état & décide des alertes."""
    alerts = []
    cat = state.setdefault("catalog", {}).setdefault(src["name"], {})
    restock_ok = cfg.get("alert_restock", True)
    for p in products:
        title = p["title"]
        if not is_relevant(cfg, title):
            continue
        prev = cat.get(p["key"])
        cat[p["key"]] = {"price": p["price"], "available": p["available"], "seen": now_iso(),
                         "alerted": (prev or {}).get("alerted")}
        if warmup:
            continue
        if not p["available"]:
            continue
        ev = evaluate(cfg, title, p["price"])
        if not ev:
            continue
        ptype, thr, verdict = ev
        reason = None
        if prev is None:
            reason = "🆕 nouveau"
        elif prev.get("price") is not None and p["price"] is not None and p["price"] < prev["price"] - 0.009:
            reason = f"📉 baisse ({prev['price']:.2f} → {p['price']:.2f} €)"
        elif restock_ok and prev.get("available") is False:
            reason = "📦 restock"
        if not reason:
            continue
        if cat[p["key"]]["alerted"] == p["price"] and reason == "🆕 nouveau":
            continue
        cat[p["key"]]["alerted"] = p["price"]
        alerts.append(build_embed(title, p["link"], p["price"], ptype, thr, src["name"], None, reason, verdict))
    # purge produits disparus depuis 60 j
    cutoff = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
    for k in [k for k, v in cat.items() if v.get("seen", "") < cutoff]:
        cat.pop(k)
    return alerts


def src_shopify(cfg, src, state, warmup):
    base = src["url"].rstrip("/")
    path = src.get("path", "/products.json")
    products, page = [], 1
    try:
        while page <= 4:
            r = http_get(f"{base}{path}", accept="application/json", params={"limit": 250, "page": page})
            if r.status_code != 200:
                log(f"[shopify] {src['name']} → HTTP {r.status_code}")
                break
            data = r.json().get("products", [])
            if not data:
                break
            for pr in data:
                variants = pr.get("variants") or []
                prices = [float(v["price"]) for v in variants if v.get("price")]
                avail = any(v.get("available", True) for v in variants) if variants else True
                products.append({"key": str(pr.get("id")), "title": norm(pr.get("title", "")),
                                 "price": min(prices) if prices else None,
                                 "link": f"{base}/products/{pr.get('handle')}", "available": avail})
            if len(data) < 250:
                break
            page += 1
    except Exception as e:
        log(f"[shopify] {src['name']} → erreur {e}")
        return []
    log(f"[shopify] {src['name']} → {len(products)} produits")
    return track_products(cfg, src, state, warmup, products)


def listing_from_jsonld(soup, base):
    out = []
    for s in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(s.string or "")
        except Exception:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            d = stack.pop()
            if isinstance(d, list):
                stack.extend(d)
                continue
            if not isinstance(d, dict):
                continue
            if "@graph" in d:
                stack.extend(d["@graph"])
            if d.get("@type") == "ItemList":
                for el in d.get("itemListElement", []):
                    it = el.get("item", el) if isinstance(el, dict) else None
                    if isinstance(it, dict):
                        stack.append(it)
            t = d.get("@type")
            if t == "Product" or (isinstance(t, list) and "Product" in t):
                offers = d.get("offers") or {}
                offers = offers if isinstance(offers, list) else [offers]
                price, avail = None, True
                for o in offers:
                    if isinstance(o, dict):
                        pv = o.get("price") or o.get("lowPrice")
                        try:
                            pv = float(str(pv).replace(",", ".")) if pv is not None else None
                        except ValueError:
                            pv = None
                        if pv is not None:
                            price = pv if price is None else min(price, pv)
                        av = str(o.get("availability", "")).lower()
                        if "outofstock" in av or "soldout" in av:
                            avail = False
                link = d.get("url") or d.get("@id") or ""
                if link and not link.startswith("http"):
                    link = base + link
                name = norm(d.get("name", ""))
                if name:
                    out.append({"key": link or name, "title": name, "price": price, "link": link or base, "available": avail})
    return out


def listing_from_selectors(soup, base, sel):
    out = []
    for card in soup.select(sel["item"]):
        t = card.select_one(sel["title"])
        if not t:
            continue
        title = norm(t.get_text())
        pr = card.select_one(sel.get("price", ".price"))
        price = parse_price(pr.get_text() + " €") if pr else None
        a = card.select_one(sel.get("link", "a"))
        link = (a.get("href") if a else "") or ""
        if link and not link.startswith("http"):
            link = base + ("" if link.startswith("/") else "/") + link
        avail = not re.search(r"rupture|indisponible|[ée]puis[ée]|sold out", card.get_text(" ").lower())
        out.append({"key": link or title, "title": title, "price": price, "link": link or base, "available": avail})
    return out


def src_listing(cfg, src, state, warmup):
    url = src["url"]
    base = re.match(r"https?://[^/]+", url).group(0)
    try:
        r = http_get(url)
        if r.status_code != 200:
            log(f"[listing] {src['name']} → HTTP {r.status_code}")
            return []
        soup = BeautifulSoup(r.text, "lxml")
    except Exception as e:
        log(f"[listing] {src['name']} → erreur {e}")
        return []
    products = listing_from_jsonld(soup, base)
    if not products and src.get("selectors"):
        products = listing_from_selectors(soup, base, src["selectors"])
    log(f"[listing] {src['name']} → {len(products)} produits")
    if not products:
        return []
    return track_products(cfg, src, state, warmup, products)


SOURCE_HANDLERS = {"rss": src_rss, "shopify": src_shopify, "listing": src_listing}


def process_sources(cfg, state, warmup):
    alerts = []
    sources = [s for s in cfg.get("sources", []) if s.get("enabled", True)]
    for u in EXTRA_FEEDS:
        sources.append({"type": "rss", "name": "Dealabs alertes perso" if "dealabs" in u else "RSS perso", "url": u})
    for src in sources:
        h = SOURCE_HANDLERS.get(src.get("type"))
        if not h:
            log(f"[src] type inconnu: {src}")
            continue
        try:
            alerts += h(cfg, src, state, warmup)
        except Exception as e:
            log(f"[src] {src.get('name')} → erreur {e}")
    return alerts


# ----------------------------------------------------------------------------- watchlist (pages produit)
def extract_price_from_page(html_text):
    soup = BeautifulSoup(html_text, "lxml")
    price, available, name = None, True, None

    for s in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(s.string or "")
        except Exception:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            d = stack.pop()
            if not isinstance(d, dict):
                continue
            if "@graph" in d:
                stack.extend(d["@graph"])
            t = d.get("@type", "")
            if (t == "Product" or (isinstance(t, list) and "Product" in t)) and "offers" in d:
                name = name or d.get("name")
                offers = d["offers"]
                offers = offers if isinstance(offers, list) else [offers]
                for o in offers:
                    if not isinstance(o, dict):
                        continue
                    p = o.get("price") or o.get("lowPrice")
                    if p is not None:
                        try:
                            pv = float(str(p).replace(",", "."))
                            price = pv if price is None else min(price, pv)
                        except ValueError:
                            pass
                    av = str(o.get("availability", "")).lower()
                    if "outofstock" in av or "soldout" in av or "discontinued" in av:
                        available = False
            for v in d.values():
                if isinstance(v, (dict, list)):
                    stack.append(v)
        if price is not None:
            break

    if price is None:
        for sel in [("meta", {"property": "product:price:amount"}), ("meta", {"itemprop": "price"}),
                    ("span", {"itemprop": "price"})]:
            tag = soup.find(*sel)
            if tag:
                price = parse_price((tag.get("content") or tag.get_text()) + " €")
                if price:
                    break
    if not name:
        og = soup.find("meta", {"property": "og:title"})
        name = og.get("content") if og else (soup.title.get_text() if soup.title else None)
    return price, available, norm(name)


def process_watchlist(cfg, state):
    alerts = []
    wl = cfg.get("watchlist", [])
    wstate = state.setdefault("watch", {})
    for item in wl:
        url, mx = item.get("url"), item.get("max_price")
        if not url or mx is None:
            continue
        try:
            r = requests.get(url, headers=HEADERS, timeout=25)
            if r.status_code != 200:
                log(f"[watch] {url} → HTTP {r.status_code}")
                continue
            price, available, name = extract_price_from_page(r.text)
        except Exception as e:
            log(f"[watch] {url} → erreur {e}")
            continue
        name = item.get("name") or name or url
        st = wstate.setdefault(url, {})
        st.update({"last_price": price, "available": available, "checked": now_iso()})
        log(f"[watch] {name} → {price} € dispo={available}")
        if price is None or not available:
            st["was_available"] = available
            continue
        restock = st.get("was_available") is False and cfg.get("alert_restock", True)
        st["was_available"] = available
        if price <= float(mx) and (st.get("alerted_price") != price or restock):
            st["alerted_price"] = price
            merchant = re.sub(r"^https?://(www\.)?", "", url).split("/")[0]
            alerts.append(build_embed(name, url, price, item.get("type"), float(mx), "Watchlist", merchant,
                                      "📦 restock" if restock else None, verdict="watch"))
        elif price > float(mx):
            st.pop("alerted_price", None)  # ré-alerte si ça rebaisse plus tard
    return alerts


# ----------------------------------------------------------------------------- main
def main():
    cfg = load_json(CONFIG_PATH, {})
    state = load_json(STATE_PATH, {})
    warmup = not state.get("seen")

    # purge des vieux ids
    cutoff = datetime.now(timezone.utc) - timedelta(days=SEEN_TTL_DAYS)
    seen = state.setdefault("seen", {})
    for k in [k for k, ts in seen.items() if datetime.fromisoformat(ts) < cutoff]:
        seen.pop(k, None)

    alerts = process_sources(cfg, state, warmup)
    alerts += process_watchlist(cfg, state)

    if warmup:
        ncat = sum(len(v) for v in state.get("catalog", {}).values())
        discord(content=f"✅ PokéWatch actif — {len(seen)} deals Dealabs et {ncat} produits boutiques indexés. "
                        "J'alerte sur les nouveautés, baisses de prix et restocks à partir de maintenant.")

    sent = 0
    for emb in alerts[:MAX_ALERTS_PER_RUN]:
        if discord(embed=emb):
            sent += 1
    if len(alerts) > MAX_ALERTS_PER_RUN:
        discord(content=f"⚠️ {len(alerts) - MAX_ALERTS_PER_RUN} alertes supplémentaires non envoyées (limite par run).")

    state["last_run"] = now_iso()
    save_json(STATE_PATH, state)
    log(f"[done] alertes: {sent}/{len(alerts)} | seen: {len(seen)} | warmup={warmup}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"[fatal] {e}")
        sys.exit(1)
