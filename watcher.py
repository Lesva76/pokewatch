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


# ----------------------------------------------------------------------------- feeds
def fetch_feed(url):
    try:
        r = requests.get(url, headers={**HEADERS, "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8"},
                         timeout=25)
        if r.status_code in (403, 429, 503):
            # anti-bot (Cloudflare) sur l'IP GitHub → on retente via un proxy public
            log(f"[feed] {url} → HTTP {r.status_code}, retry via proxy")
            r = requests.get("https://api.allorigins.win/raw", params={"url": url}, timeout=30)
        if r.status_code != 200:
            log(f"[feed] {url} → HTTP {r.status_code}")
            return []
        fp = feedparser.parse(r.content)
        if fp.bozo and not fp.entries:
            log(f"[feed] {url} → parse KO ({fp.bozo_exception})")
            return []
        log(f"[feed] {url} → {len(fp.entries)} items")
        return fp.entries
    except Exception as e:
        log(f"[feed] {url} → erreur {e}")
        return []


def entry_extra(entry, key_part):
    """Récupère un champ namespacé type pepper:price / pepper:merchant, quel que soit le préfixe."""
    for k, v in entry.items():
        if key_part in k.lower() and isinstance(v, str) and v.strip():
            return v.strip()
    return None


def process_feeds(cfg, state, warmup):
    alerts = []
    feeds = list(cfg.get("feeds", [])) + EXTRA_FEEDS
    seen = state.setdefault("seen", {})
    must = cfg.get("must_match", [])
    excl = cfg.get("exclude", [])
    maxp = cfg.get("max_price", {})

    for url in feeds:
        for e in fetch_feed(url):
            title = norm(e.get("title", ""))
            link = e.get("link", "") or ""
            desc = strip_html(e.get("summary", "") or e.get("description", ""))
            iid = item_id(link or title)
            if iid in seen:
                continue
            seen[iid] = now_iso()
            if warmup:
                continue

            blob = f"{title} {desc}"
            if not matches_any(must, blob):
                continue
            if matches_any(excl, title):
                log(f"[skip-exclude] {title}")
                continue

            ptype = detect_type(title) or detect_type(desc)
            price = parse_price(title)
            if price is None:
                p2 = entry_extra(e, "price")
                price = parse_price(p2) if p2 else None
            if price is None:
                price = parse_price(desc)
            merchant = entry_extra(e, "merchant")

            if ptype:
                thr = maxp.get(ptype)
                if price is None:
                    if not cfg.get("alert_if_price_unknown", True):
                        continue
                    verdict = "check"
                elif thr is not None and price <= thr:
                    verdict = "deal"
                else:
                    log(f"[skip-price] {title} ({price}€ > {thr}€)")
                    continue
            else:
                if not cfg.get("alert_untyped_pokemon_deals", False):
                    log(f"[skip-untyped] {title}")
                    continue
                thr, verdict = None, "check"

            src = "Dealabs" if "dealabs" in url else re.sub(r"^https?://(www\.)?", "", url).split("/")[0]
            alerts.append(build_embed(title, link, price, ptype, thr, src, merchant, desc, verdict))
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
            continue
        if price <= float(mx) and st.get("alerted_price") != price:
            st["alerted_price"] = price
            merchant = re.sub(r"^https?://(www\.)?", "", url).split("/")[0]
            alerts.append(build_embed(name, url, price, item.get("type"), float(mx), "Watchlist", merchant,
                                      verdict="watch"))
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

    alerts = process_feeds(cfg, state, warmup)
    alerts += process_watchlist(cfg, state)

    if warmup:
        discord(content=f"✅ PokéWatch actif — {len(seen)} deals existants ignorés, j'alerte sur les nouveaux à partir de maintenant.")

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
