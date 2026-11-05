#!/usr/bin/env python3
"""List admin-catalogue products of the given category ids in the storefront shop (shop_products), so customers see them.
Usage: enroll-shop-products.py <category_id> [...]   (idempotent; skips ones already listed)"""
import json, os, sys, urllib.request, urllib.error
API = os.environ.get("API", "https://api.dealker.agnixstudio.in/api/v1")
TOKEN = open(os.environ["TOKEN_FILE"]).read().strip()
SHOP = json.load(urllib.request.urlopen(API + "/theme/tabs"))["data"]["shop_id"]

def call(method, path, body=None, shop=False):
    h = {"authorization": "Bearer " + TOKEN, "content-type": "application/json"}
    if shop: h["x-shop-id"] = SHOP
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try: return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e: return json.loads(e.read() or b"{}")

for cid in sys.argv[1:]:
    d = call("POST", "/admin/merch-sections/preview-rules", {"rules": {"category_ids": [cid]}, "limit": 50})["data"]
    for p in d["products"]:
        price = float(p["price"]); sale = float(p["sale_price"]) if p.get("sale_price") else None
        body = {"product_id": p["id"], "stock_quantity": 60, "is_available": True, "max_order_qty": 10, "price": price}
        if sale and sale < price: body["sale_price"] = sale
        r = call("POST", "/shop-products", body, shop=True)
        print(("ok   " if r.get("success") else "skip ") + p["name"][:55], "" if r.get("success") else (r.get("message") or "")[:60])
