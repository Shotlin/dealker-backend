#!/usr/bin/env python3
"""
Seed the Theme Builder pages (theme_tabs + section_manifests) for the four stores through the
real admin API, so every page stays editable in the dashboard.

Usage:  seed-store-pages.py <store.tab> [<store.tab> ...]     e.g. mobile.mobile mobile.headphones
Env:    API (default live), TOKEN_FILE, ASSETS (dir with banners/*.png), SPEC (python module path)
Idempotent per tab: wipes that tab's sections, re-creates them in order. Uploaded banner URLs are cached
in assets/urls.json so reruns don't re-upload.
"""
import json, os, subprocess, sys, urllib.request, urllib.error, copy

API = os.environ.get("API", "https://api.dealker.agnixstudio.in/api/v1")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ASSETS = os.environ.get("ASSETS", os.path.join(ROOT, "vibe_images", "store_assets"))
TOKEN = open(os.environ["TOKEN_FILE"]).read().strip()
URLS_FILE = os.path.join(ASSETS, "urls.json")
URLS = json.load(open(URLS_FILE)) if os.path.exists(URLS_FILE) else {}


SHOP = None  # when set, calls hit that shop's own layout scope (x-shop-id)


def call(method, path, body=None):
    hdr = {"authorization": "Bearer " + TOKEN, "content-type": "application/json"}
    if SHOP:
        hdr["x-shop-id"] = SHOP
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None, headers=hdr)
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> {e.code} {e.read().decode()[:400]}")


def upload(rel):
    """Upload assets/<rel> once; returns its CDN url."""
    if rel in URLS:
        return URLS[rel]
    out = subprocess.run(["curl", "-s", "-X", "POST", API + "/uploads/image", "-H", "authorization: Bearer " + TOKEN,
                          "-F", "file=@" + os.path.join(ASSETS, rel), "-F", "folder=banners"],
                         capture_output=True, text=True).stdout
    d = json.loads(out)
    url = (d.get("data") or {}).get("url") or (d.get("data") or {}).get("secure_url")
    if not url:
        raise SystemExit("upload failed " + out[:300])
    URLS[rel] = url
    json.dump(URLS, open(URLS_FILE, "w"), indent=1)
    return url


def tab_id(store, key):
    for t in call("GET", f"/admin/theme-tabs?store_key={store}")["data"]:
        if t["key"] == key and t.get("status", "active") == "active" and t["store_key"] == store:
            return t["id"]
    return None


def ensure_tab(store, key, label, order, icon=None, color=None):
    tid = tab_id(store, key)
    body = {"store_key": store, "key": key, "label": label, "sort_order": order, "is_default": key == "all"}
    if icon:
        body["image_url"] = icon
    if color:
        body["text_color"] = color
    if tid:
        call("PUT", f"/admin/theme-tabs/{tid}", body)
        return tid
    return call("POST", "/admin/theme-tabs", body)["data"]["id"]


def wipe(tid):
    for s in call("GET", f"/admin/sections/{tid}")["data"]:
        call("DELETE", f"/admin/sections/{s['id']}")


def add(tid, section_type, config, binding=None):
    body = {"section_type": section_type, "config": config, "visible": True}
    if binding:
        body["merch_binding"] = binding
    return call("POST", f"/admin/sections/{tid}", body)["data"]


def resolve(o):
    """Replace "@asset:<relpath>" strings with the uploaded CDN url."""
    if isinstance(o, str) and o.startswith("@asset:"):
        return upload(o[7:])
    if isinstance(o, (list, tuple)):
        return type(o)(resolve(x) for x in o)
    if isinstance(o, dict):
        return {k: resolve(v) for k, v in o.items()}
    return o


def build(tid, sections):
    """Write the page to the platform default AND to the storefront shop's own scope (a shop-scoped
    layout, when present, overrides the default for that shop's customers)."""
    global SHOP
    shop = json.load(urllib.request.urlopen(API + "/theme/tabs"))["data"]["shop_id"]
    for scope in (None, shop):
        SHOP = scope
        wipe(tid)
        for st, cfg, bind in sections:
            add(tid, st, cfg, bind)
    SHOP = None
    print(f"  {len(sections)} sections written (default + shop scope)")


if __name__ == "__main__":
    sys.path.insert(0, HERE)
    import store_specs  # noqa: E402
    targets = sys.argv[1:]
    for tgt in targets:
        store, key = tgt.split(".")
        spec = store_specs.SPECS[(store, key)]
        print(f"== {store}/{key}")
        tid = ensure_tab(store, key, spec["label"], spec["order"], spec.get("icon"), spec.get("color"))
        store_specs.CTX = (store, key)
        build(tid, resolve(spec["sections"](upload)))
