#!/usr/bin/env python3
"""Seed all products into the Bakaloo Demo Store for QA testing."""
import urllib.request
import urllib.error
import json

BASE = "https://bakaloo-api.shotlin.in/api/v1"
SHOP_ID = "dff3fede-28a4-4521-8fd8-35f0ae200c9d"

def post(url, data, headers):
    req = urllib.request.Request(url, data=json.dumps(data).encode(), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

print("Getting admin token...")
resp = post(f"{BASE}/admin/auth/login", {"email": "admin@bakaloo.com", "password": "Admin@123"}, {"Content-Type": "application/json"})
admin_token = resp["data"]["accessToken"]
print(f"Admin token obtained ({len(admin_token)} chars)")

admin_headers = {
    "Authorization": f"Bearer {admin_token}",
    "Content-Type": "application/json",
    "X-Shop-Id": SHOP_ID,
}

print("\nFetching all products...")
all_products = []
page = 1
while True:
    data = get(f"{BASE}/products?limit=100&page={page}")
    products = data.get("data", [])
    if not products:
        break
    all_products.extend(products)
    pagination = data.get("pagination", {})
    if page >= pagination.get("totalPages", 1):
        break
    page += 1

print(f"Found {len(all_products)} products")

success_count = 0
skip_count = 0
fail_count = 0

for p in all_products:
    pid = p["id"]
    name = p["name"]
    price = float(p.get("price", 0) or 0)
    sale_price = p.get("sale_price")
    if sale_price:
        sale_price = float(sale_price)

    payload = {
        "product_id": pid,
        "stock_quantity": 100,
        "is_available": True,
        "max_order_qty": 10,
    }
    if price > 0:
        payload["price"] = price
    if sale_price and sale_price > 0:
        payload["sale_price"] = sale_price

    result = post(f"{BASE}/shop-products", payload, admin_headers)

    if result.get("success"):
        success_count += 1
        print(f"  OK {name[:50]}")
    elif "already" in result.get("message", "").lower() or result.get("code") in ("DUPLICATE", "CONFLICT"):
        skip_count += 1
    else:
        fail_count += 1
        print(f"  FAIL {name[:40]}: {result.get('message','')[:60]}")

print(f"\nResult: {success_count} added, {skip_count} skipped, {fail_count} failed")
