#!/usr/bin/env python3
"""Create Phone Cases + Screen Guards under Accessories & Storage with 10 real products (photos/prices from Amazon.in PDPs, scraped at run time).
Idempotent: skips categories/products whose name already exists. Needs TOKEN_FILE."""
import json, os, re, subprocess, sys, html, urllib.request, urllib.error, tempfile
API = os.environ.get("API", "https://api.dealker.agnixstudio.in/api/v1")
TOKEN = open(os.environ["TOKEN_FILE"]).read().strip()
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

CATS = {"Phone Cases": "Back covers and cases for popular phones", "Screen Guards": "Tempered glass screen protectors"}
P = {
    "Phone Cases": [("B0C5S9WV88", "Spigen Liquid Air Back Cover Case for iPhone 15", "Spigen"),
        ("B0GV86366S", "Spigen Caseology Quartz Crystal Mag Case for iPhone 15", "Spigen"),
        ("B0CPXVRXGN", "JETech Slim Case for Samsung Galaxy S24 Ultra (Black)", "JETech"),
        ("B0CPXXS142", "JETech Magnetic Case for Samsung Galaxy S24 (Clear, MagSafe Compatible)", "JETech"),
        ("B0CRD7XMKY", "TheGiftKart Shockproof Crystal Clear Back Cover for Redmi Note 13 5G", "TheGiftKart")],
    "Screen Guards": [("B0CG29HWSS", "POPIO Military-Grade Gorilla Tempered Glass for iPhone 15 / 16", "POPIO"),
        ("B0CVH9XHR2", "Czartech Auto-Align Tempered Glass for iPhone 15", "Czartech"),
        ("B0F277VT4X", "OpenTech Military-Grade Gorilla Tempered Glass for Samsung Galaxy S24 Ultra", "OpenTech"),
        ("B0FWCT5BVY", "SupCares Tempered Glass for OnePlus Nord CE 4 with Installation Kit", "SupCares"),
        ("B0CWNN78MB", "Skyddshield Gorilla Tempered Glass for Redmi Note 13 / Poco X6 Neo", "Skyddshield")],
}
ROOT_ID = os.environ.get("ROOT_ID")

def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"authorization": "Bearer " + TOKEN, "content-type": "application/json"})
    try: return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e: raise SystemExit(f"{method} {path} -> {e.code} {e.read().decode()[:500]}")

def num(s): return float(s.replace(",", ""))

def pdp(asin):
    h = subprocess.run(["curl", "-s", "--compressed", "-A", UA, "-H", "accept-language: en-IN,en;q=0.9", "https://www.amazon.in/dp/" + asin],
                       capture_output=True, text=True).stdout
    price = re.findall(r'a-price-whole">([\d,]+)', h)
    mrp = re.findall(r'a-text-price[^>]*>\s*<span class="a-offscreen">\s*₹([\d,]+(?:\.\d+)?)', h)
    imgs = list(dict.fromkeys(re.findall(r'"hiRes":"([^"]+)"', h)))[:3]
    bullets = [html.unescape(re.sub(r"<[^>]+>", "", b)).strip() for b in re.findall(r'<li[^>]*class="a-spacing-mini"[^>]*>\s*<span[^>]*>(.*?)</span>', h, re.S)][:4]
    if not price or not imgs: raise SystemExit("no data for " + asin)
    p = num(price[0]); m = num(mrp[0]) if mrp else None
    if m and (m < p or m > 4 * p): m = None
    return p, m, imgs, bullets

def upload(url):
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f: path = f.name
    subprocess.run(["curl", "-s", "--compressed", "-A", UA, "-o", path, url], check=True)
    out = subprocess.run(["curl", "-s", "-X", "POST", API + "/uploads/image", "-H", "authorization: Bearer " + TOKEN,
        "-F", "file=@" + path, "-F", "folder=products"], capture_output=True, text=True).stdout
    d = json.loads(out)["data"]; os.unlink(path)
    return d.get("url") or d.get("secure_url")

cats = call("GET", "/categories")["data"]
by_name = {c["name"]: c for c in cats}
def ensure_cat(name, desc, parent=None, image=None):
    if name in by_name: return by_name[name]["id"]
    body = {"name": name, "description": desc, "parent_id": parent, "is_active": True}
    if image: body["image_url"] = image
    c = call("POST", "/categories", body)["data"]; by_name[name] = c; print("category", name); return c["id"]

root = ROOT_ID
existing = {p["name"] for pg in (1, 2, 3) for p in call("GET", f"/products?limit=100&page={pg}")["data"]}
for cname, items in P.items():
    cid = ensure_cat(cname, CATS[cname], root)
    first_img = None
    for asin, name, brand in items:
        if name in existing: print("skip", name); continue
        price, mrp, imgs, bullets = pdp(asin)
        cdn = [upload(u) for u in imgs[:3]]
        first_img = first_img or cdn[0]
        body = {"name": name, "description": " ".join(bullets)[:900] or name, "price": mrp or price, "categoryId": cid,
                "stock": 60, "unit": "piece", "thumbnailUrl": cdn[0], "images": cdn, "isActive": True,
                "tags": ["accessories", cname.lower()]}
        if mrp: body["salePrice"] = price
        if brand: body["brand"] = brand
        r = call("POST", "/products", body)
        print("product", name, price, mrp)
    if first_img and not by_name[cname].get("image_url"):
        call("PUT", f"/categories/{cid}", {"image_url": first_img})
