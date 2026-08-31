#!/usr/bin/env python3
"""
PokéWatch LOCAL — boucle toutes les 60 s sur ton PC (IP résidentielle : Micromania, Cultura, etc. passent).
Utilise config.local.json (retailers uniquement) et state.local.json (indépendant du cloud → pas de doublons).
Lancer : double-clic sur run_local.bat
"""
import os, sys, time, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("POKEWATCH_CONFIG", os.path.join(ROOT, "local", "config.local.json"))
os.environ.setdefault("POKEWATCH_STATE", os.path.join(ROOT, "local", "state.local.json"))
INTERVAL = int(os.environ.get("POKEWATCH_INTERVAL", "60"))

if not os.environ.get("DISCORD_WEBHOOK_URL"):
    p = os.path.join(ROOT, "local", "webhook.txt")
    if os.path.exists(p):
        os.environ["DISCORD_WEBHOOK_URL"] = open(p, encoding="utf-8").read().strip()
    else:
        print("Colle l'URL du webhook Discord dans local/webhook.txt (une ligne) puis relance.")
        sys.exit(1)

while True:
    t0 = time.time()
    subprocess.call([sys.executable, os.path.join(ROOT, "watcher.py")])
    time.sleep(max(5, INTERVAL - (time.time() - t0)))
