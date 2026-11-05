"""Page specs for seed-store-pages.py. Each tab = list of (section_type, config, merch_binding)."""
import json, copy, urllib.request, os

API = os.environ.get("API", "https://api.dealker.agnixstudio.in/api/v1")
_all = json.load(urllib.request.urlopen(API + "/theme/tabs/all/sections?store_key=mobile"))["data"]["sections"]


def _tpl(t, n=0):
    return copy.deepcopy([s for s in _all if s["type"] == t][n])


FEE = _tpl("fee_strip")["config"]
BRANDS = {c["brand_name"]: c for c in _tpl("top_brands")["config"]["cards"]}
CATIMG = {g["label"]: g["image_url"] for g in _tpl("category_hub")["config"]["tabs"][0]["grid"]}
for_chip = {c["label"]: c["image_url"] for c in _tpl("steal_deals")["config"]["tabs"][0]["chips"]}

# category ids (live)
C_MOBILE = "d057cdb7-a74d-4829-803d-3258a0569f68"
C_HEAD = "c06f3dc3-ffd0-44be-b6c5-344cdddf31f4"
C_WATCH = "ce9788bb-7add-4fc3-9cb0-f2c61d547b13"
C_CHARGE = "4012e270-d5f3-478a-b7a4-3759eb831bce"
C_SPEAK = "1eade306-4d82-4f06-b3bc-24df118fef7c"
C_ACC = "2da15ccc-be64-43f7-971d-0b651c7efa95"


def bind(cats=None, limit=12, sort="best_selling", **rules):
    r = {"sort": sort, **rules}
    if cats:
        r["category_ids"] = cats
    return {"source": "category", "category_ids": cats or [], "product_ids": [], "tags": [], "limit": limit,
            "rules": r, "auto_fill": True}


def promo(up, names):
    return ("promo_carousel", {"height": 200, "images": [up(n) for n in names], "banner_source": "custom"}, None)


def fee():
    return ("fee_strip", copy.deepcopy(FEE), None)


def brands(names, title="Top Brands"):
    return ("top_brands", {"title": title, "cards": [BRANDS[n] for n in names if n in BRANDS]}, None)


def hub(label, tiles):
    """tiles: (label, image_url, category_id, search_query)"""
    return ("category_hub", {"see_all_label": "See All", "tabs": [{"label": label, "grid": [
        {"label": l, "image_url": i, "category_id": c, "search_query": q} for l, i, c, q in tiles]}]}, None)


def deal(title, cats, min_discount, limit=6, ends="", **rules):
    cfg = {"title": title, "ends_at": ends, "bg_color": "#FFF1B8", "off_color": "#E0262F", "card_color": "#FFFFFF",
           "text_color": "#111111", "button_color": "#111111", "button_label": "Grab Deal →"}
    return ("deal_of_day", cfg, bind(cats, limit, "discount", min_discount=min_discount, **rules))


CTX = ("mobile", "all")  # set by seed-store-pages.py before each tab is built
ART = {  # (store, tab) -> (left, right) transparent art shown in the price-sale header
    ("mobile", "mobile"): ("art.phone", "electronics.watches"), ("mobile", "electronics"): ("electronics.watches", "electronics.speakers"),
    ("mobile", "headphones"): ("electronics.headphones", "art.earbuds"), ("mobile", "accessories"): ("accessories.chargers", "accessories.powerbanks"),
    ("mobile_part", "*"): ("mobile_part.screens", "mobile_part.batteries"),
    ("accessories", "*"): ("accessories.cases", "accessories.powerbanks"),
    ("electronics", "*"): ("electronics.watches", "electronics.headphones"),
}


def _art():
    a = ART.get(CTX) or ART.get((CTX[0], "*")) or ("art.phone", "art.earbuds")
    return ["@asset:icons/%s.png" % x for x in a]


def price_sale(title, cats, tiers):
    base = _tpl("price_sale")["config"]
    tab0 = base["tabs"][0]
    tabs = []
    for mx in tiers:
        t = {k: v for k, v in tab0.items() if k not in ("products",)}
        l, r = _art()
        t.update({"header_left_url": l, "header_right_url": r, "max_price": mx, "price_text": f"₹{mx:,}", "sub_label": f"₹{mx:,}", "category_ids": cats,
                  "product_ids": []})
        tabs.append(t)
    return ("price_sale", {"title": title, "subtitle": "Best brands at flat", "see_all_label": "", "tabs": tabs}, None)


def rail(title, cats, limit=10, sort="best_selling", style="DEALKER_MARKETPLACE_BOX", **rules):
    return ("product_carousel", {"title": title, "show_title": True, "auto_scroll": False,
                                 "product_card_style": style}, bind(cats, limit, sort, **rules))


def grid(title, cats, limit=8, sort="best_selling", **rules):
    return ("category_product_grid", {"title": title, "columns": 2, "card_shape": "rounded", "image_ratio": "1:1",
                                      "show_quick_add": True}, bind(cats, limit, sort, **rules))


def banner_rail(up, header, cats, limit=10, sort="discount", panel="#E3E6F4", **rules):
    return ("banner_rail", {"panel_color": panel, "see_all_label": "See All", "header_image_url": up(header)},
            bind(cats, limit, sort, **rules))


def spotlight(brand, tagline, cats, more, limit=10, **rules):
    cfg = {"tagline": tagline, "brand_name": brand, "more_title": more,
           "brand_logo_url": BRANDS.get(brand, {}).get("logo_url", "")}
    return ("brand_spotlight", cfg, bind(cats, limit, "best_selling", brands=[brand], **rules))


def trending(title="Trending Near You"):
    return ("trending_products", {"limit": 6, "title": title, "card_style": "compact", "accent_color": "#FF6B35"}, None)


# --------------------------------------------------------------------- MOBILE STORE
def mobile_mobile(up):
    cats = [C_MOBILE]
    return [
        promo(up, ["banners/mobile-mobile-1.png", "banners/mobile-mobile-2.png"]),
        fee(),
        hub("Shop by brand", [(b, BRANDS[b]["logo_url"], C_MOBILE, b) for b in
                              ["Apple", "Samsung", "OnePlus", "Redmi", "realme", "Google"]]),
        deal("PHONE DEAL OF THE DAY", cats, 15),
        price_sale("Phones by budget", cats, [15000, 20000, 30000, 50000, 100000]),
        brands(["Apple", "Samsung", "OnePlus", "Redmi", "realme", "Google"], "Top Phone Brands"),
        rail("New launches", cats, 10, "newest"),
        banner_rail(up, "banners/mobile-mobile-2.png", cats, 10, "discount", min_price=40000),
        spotlight("Samsung", "Galaxy Days · Limited Time Deals", cats, "More from Samsung"),
        spotlight("OnePlus", "Never Settle · Flagship Offers", cats, "More from OnePlus"),
        grid("5G phones under ₹20,000", cats, 8, "best_selling", max_price=20000),
        grid("Best sellers", cats, 8, "best_selling"),
        trending(),
    ]


def mobile_headphones(up):
    cats = [C_HEAD]
    return [
        promo(up, ["banners/mobile-headphones-1.png", "banners/mobile-headphones-2.png"]),
        fee(),
        hub("Shop by brand", [(b, BRANDS[b]["logo_url"], C_HEAD, b) for b in
                              ["Apple", "Samsung", "Sony", "JBL", "boAt", "realme"]]),
        deal("AUDIO DEAL OF THE DAY", cats, 10),
        price_sale("Audio by budget", cats, [1999, 2999, 5000, 10000, 30000]),
        brands(["Sony", "JBL", "boAt", "Apple", "Samsung"], "Top Audio Brands"),
        rail("TWS earbuds", cats, 10, "best_selling", max_price=5000),
        banner_rail(up, "banners/mobile-headphones-2.png", cats, 10, "discount", min_discount=10),
        spotlight("boAt", "Plug into Nirvana · Value Deals", cats, "More from boAt"),
        spotlight("JBL", "Pure Bass · Top Picks", cats, "More from JBL"),
        grid("Premium noise cancelling", cats, 6, "price_desc", min_price=10000),
        grid("Best sellers", cats, 8, "best_selling"),
        trending(),
    ]


def mobile_electronics(up):
    cats = [C_WATCH, C_SPEAK, C_ACC]
    return [
        promo(up, ["banners/mobile-electronics-1.png", "banners/mobile-electronics-2.png"]),
        fee(),
        hub("Shop by category", [("Smart Watches", CATIMG.get("Smart Watches", ""), C_WATCH, ""),
                                 ("Speakers", CATIMG.get("Speakers & Soundbars", CATIMG.get("Headphones", "")), C_SPEAK, ""),
                                 ("Storage & more", CATIMG.get("Accessories & Storage", ""), C_ACC, "")]),
        deal("GADGET DEAL OF THE DAY", cats, 10),
        price_sale("Gadgets by budget", cats, [999, 2999, 5000, 10000, 30000]),
        rail("Smart watches", [C_WATCH], 10, "best_selling"),
        banner_rail(up, "banners/mobile-electronics-2.png", cats, 10, "discount", min_discount=10),
        rail("Speakers & soundbars", [C_SPEAK], 8, "best_selling"),
        grid("Storage, routers & more", [C_ACC], 8, "best_selling"),
        grid("Best sellers", cats, 8, "best_selling"),
        trending(),
    ]


def mobile_accessories(up):
    cats = [C_CHARGE, C_ACC]
    return [
        promo(up, ["banners/mobile-accessories-1.png", "banners/mobile-accessories-2.png"]),
        fee(),
        hub("Shop by category", [("Chargers", CATIMG.get("Chargers & Power Banks", ""), C_CHARGE, "Charger"),
                                 ("Power Banks", CATIMG.get("Chargers & Power Banks", ""), C_CHARGE, "Power Bank"),
                                 ("Cases & covers", CATIMG.get("Accessories & Storage", ""), C_ACC, "Case"),
                                 ("Mouse & more", CATIMG.get("Accessories & Storage", ""), C_ACC, "Mouse")]),
        deal("ACCESSORY DEAL OF THE DAY", cats, 10),
        price_sale("Accessories by budget", cats, [499, 999, 1999, 3999]),
        brands(["Apple", "Samsung"], "Top Accessory Brands"),
        rail("Chargers & adapters", [C_CHARGE], 10, "best_selling"),
        banner_rail(up, "banners/mobile-accessories-2.png", [C_CHARGE], 10, "discount", min_discount=10),
        grid("Cases, mouse & more", [C_ACC], 8, "best_selling"),
        grid("Best sellers", cats, 8, "best_selling"),
        trending(),
    ]



# ------------------------------------------------------------ catalogue lookups (live)
def _all_products():
    out = []
    for pg in (1, 2, 3):
        out += json.load(urllib.request.urlopen(f"{API}/products?limit=100&page={pg}"))["data"]
    return out


_PRODUCTS = _all_products()
_CATS = {c["name"]: c for c in json.load(urllib.request.urlopen(API + "/categories"))["data"]}


def cid(name):
    return _CATS[name]["id"]


def cimg(name):
    return _CATS[name].get("image_url") or ""


def ids_named(*subs, limit=12):
    out = []
    for p in _PRODUCTS:
        if any(sub.lower() in p["name"].lower() for sub in subs) and p["id"] not in out:
            out.append(p["id"])
    return out[:limit]


def pinned(ids, limit=12):
    return {"source": "manual", "category_ids": [], "product_ids": ids, "tags": [], "limit": limit}


def rail_ids(title, ids, limit=12):
    return ("product_carousel", {"title": title, "show_title": True, "auto_scroll": False,
                                 "product_card_style": "DEALKER_MARKETPLACE_BOX"}, pinned(ids, limit))


def grid_ids(title, ids, limit=8):
    return ("category_product_grid", {"title": title, "columns": 2, "card_shape": "rounded", "image_ratio": "1:1",
                                      "show_quick_add": True}, pinned(ids, limit))


def deal_ids(title, ids, ends=""):
    cfg = {"title": title, "ends_at": ends, "bg_color": "#FFF1B8", "off_color": "#E0262F", "card_color": "#FFFFFF",
           "text_color": "#111111", "button_color": "#111111", "button_label": "Grab Deal \u2192"}
    return ("deal_of_day", cfg, pinned(ids, 6))


def banner_ids(up, header, ids, panel="#E3E6F4"):
    return ("banner_rail", {"panel_color": panel, "see_all_label": "See All", "header_image_url": up(header)}, pinned(ids, 12))


def tiles(*names):
    return [(n, cimg(n), cid(n), "") for n in names]


# ------------------------------------------------------------ MOBILE PART
def _part_tab(slug, cat, bn, tiers, rail_title, sub_title):
    def f(up):
        cats = [cid(cat)]
        return [
            promo(up, [f"banners/mobilepart-{bn}-1.png"]), fee(),
            hub("Shop by type", tiles("Screens & Displays", "Batteries", "Charging Ports & Flex", "Repair Tools & Kits")),
            deal(f"{sub_title} DEAL OF THE DAY", cats, 20, 5),
            price_sale(f"{sub_title} by budget", cats, tiers),
            rail(rail_title, cats, 10, "best_selling"),
            banner_rail(up, f"banners/mobilepart-{bn}-1.png", cats, 10, "discount", min_discount=20),
            grid("Top rated picks", cats, 6, "rating"), grid("Best sellers", cats, 8, "best_selling"), trending(),
        ]
    return f


def mobilepart_all(up):
    allc = [cid("Screens & Displays"), cid("Batteries"), cid("Charging Ports & Flex"), cid("Repair Tools & Kits")]
    return [
        promo(up, ["banners/mobilepart-all-1.png", "banners/mobilepart-all-2.png"]), fee(),
        hub("Shop by type", tiles("Screens & Displays", "Batteries", "Charging Ports & Flex", "Repair Tools & Kits")),
        deal("SPARES DEAL OF THE DAY", allc, 20, 6),
        price_sale("Spares by budget", allc, [499, 999, 1999, 3000, 5000]),
        rail("Display combos", [cid("Screens & Displays")], 8, "best_selling"),
        banner_rail(up, "banners/mobilepart-all-2.png", allc, 10, "discount", min_discount=20),
        rail("Replacement batteries", [cid("Batteries")], 8, "best_selling"),
        rail("Repair tools & kits", [cid("Repair Tools & Kits")], 8, "best_selling"),
        grid("Charging ports & flex", [cid("Charging Ports & Flex")], 6, "best_selling"),
        grid("Best sellers", allc, 8, "best_selling"), trending("Technicians love these"),
    ]


# ------------------------------------------------------------ ACCESSORIES STORE
def _acc_pins():
    return dict(
        chargers=ids_named("Samsung 25W", "Apple 20W", "Anker 20W"),
        banks=ids_named("PowerCore", "Power Bank", "Powerbank"),
        cases=ids_named("Spigen", "JETech", "TheGiftKart"),
        guards=ids_named("Tempered Glass", "Gorilla", "Auto-Align"),
        misc=ids_named("Logitech", "Mouse"),
    )


def acc_all(up):
    k = _acc_pins()
    allp = k["chargers"] + k["banks"] + k["cases"] + k["guards"] + k["misc"]
    return [
        promo(up, ["banners/accessories-all-1.png", "banners/accessories-all-2.png"]), fee(),
        hub("Shop by category", tiles("Phone Cases", "Screen Guards") + [
            ("Chargers", cimg("Chargers & Power Banks"), cid("Chargers & Power Banks"), "Charger"),
            ("Power Banks", cimg("Chargers & Power Banks"), cid("Chargers & Power Banks"), "Power Bank")]),
        deal("ACCESSORY DEAL OF THE DAY", [cid("Chargers & Power Banks"), cid("Phone Cases"), cid("Screen Guards")], 15, 6),
        price_sale("Accessories by budget", [cid("Chargers & Power Banks"), cid("Phone Cases"), cid("Screen Guards"),
                                             cid("Accessories & Storage")], [299, 499, 999, 1999, 3999]),
        rail_ids("Phone cases", k["cases"]),
        banner_ids(up, "banners/accessories-all-2.png", k["banks"] + k["chargers"]),
        rail_ids("Screen guards", k["guards"]),
        rail("Chargers & power banks", [cid("Chargers & Power Banks")], 10, "best_selling"),
        grid("Best sellers", [cid("Chargers & Power Banks"), cid("Phone Cases"), cid("Screen Guards")], 8, "best_selling"),
        trending(),
    ]


def acc_cases(up):
    k = _acc_pins(); cats = [cid("Phone Cases")]
    return [promo(up, ["banners/accessories-cases-1.png"]), fee(),
            hub("Shop accessories", tiles("Phone Cases", "Screen Guards")),
            deal("CASE DEAL OF THE DAY", cats, 20, 5), price_sale("Cases by budget", cats, [299, 999, 1999]),
            brands(["Apple", "Samsung"], "Cases for top brands"), rail("Best-selling cases", cats, 10),
            banner_ids(up, "banners/accessories-cases-1.png", k["cases"]),
            grid("Top rated picks", cats, 6, "rating"), grid("All cases", cats + [cid("Accessories & Storage")], 8), trending()]


def acc_guards(up):
    cats = [cid("Screen Guards")]
    return [promo(up, ["banners/accessories-guards-1.png"]), fee(),
            hub("Shop accessories", tiles("Screen Guards", "Phone Cases")),
            deal("GUARD DEAL OF THE DAY", cats, 30, 5), price_sale("Guards by budget", cats, [299, 399]),
            rail("Best-selling guards", cats, 10), banner_rail(up, "banners/accessories-guards-1.png", cats, 10, "discount", min_discount=30),
            grid("Top rated picks", cats, 6, "rating"), grid("All screen guards", cats, 8), trending()]


def acc_chargers(up):
    k = _acc_pins()
    return [promo(up, ["banners/accessories-chargers-1.png"]), fee(),
            hub("Shop accessories", tiles("Phone Cases", "Screen Guards") + [("Power Banks", cimg("Chargers & Power Banks"), cid("Chargers & Power Banks"), "Power Bank")]),
            deal_ids("CHARGER DEAL OF THE DAY", k["chargers"]), price_sale("Chargers by budget", [cid("Chargers & Power Banks")], [1099, 1299, 1599]),
            brands(["Apple", "Samsung"], "Top charger brands"), rail_ids("Fast chargers & adapters", k["chargers"]),
            banner_ids(up, "banners/accessories-chargers-1.png", k["chargers"]), grid_ids("Best sellers", k["chargers"]), trending()]


def acc_powerbanks(up):
    k = _acc_pins()
    return [promo(up, ["banners/accessories-powerbanks-1.png"]), fee(),
            hub("Shop accessories", tiles("Phone Cases", "Screen Guards")),
            deal_ids("POWER BANK DEAL OF THE DAY", k["banks"]), price_sale("Power banks by budget", [cid("Chargers & Power Banks")], [1199, 2999, 3999]),
            rail_ids("Top power banks", k["banks"]), banner_ids(up, "banners/accessories-powerbanks-1.png", k["banks"]),
            grid_ids("Best sellers", k["banks"]), trending()]


# ------------------------------------------------------------ ELECTRONICS STORE
def el_all(up):
    cats = [C_WATCH, C_SPEAK, C_HEAD, C_ACC]
    return [
        promo(up, ["banners/electronics-all-1.png", "banners/electronics-all-2.png"]), fee(),
        hub("Shop by category", [("Smart Watches", CATIMG.get("Smart Watches", cimg("Smart Watches")), C_WATCH, ""),
                                 ("Speakers", cimg("Speakers & Soundbars"), C_SPEAK, ""),
                                 ("Headphones", CATIMG.get("Headphones", cimg("Headphones & Earbuds")), C_HEAD, ""),
                                 ("Storage & more", cimg("Accessories & Storage"), C_ACC, "")]),
        deal("ELECTRONICS DEAL OF THE DAY", cats, 15, 6),
        price_sale("Electronics by budget", cats, [1999, 3000, 5000, 10000, 30000]),
        brands(["Apple", "Samsung", "Sony", "JBL", "boAt"], "Top Electronics Brands"),
        rail("Smart watches", [C_WATCH], 8), banner_rail(up, "banners/electronics-all-2.png", cats, 10, "discount", min_discount=15),
        rail("Headphones & earbuds", [C_HEAD], 10), rail("Speakers & soundbars", [C_SPEAK], 8),
        grid("Best sellers", cats, 8), trending(),
    ]


def _el_tab(bn, cats, label, brand_names, tiers, deal_title):
    def f(up):
        return [promo(up, [f"banners/electronics-{bn}-1.png"]), fee(),
                hub("Shop by category", [("Smart Watches", cimg("Smart Watches"), C_WATCH, ""), ("Speakers", cimg("Speakers & Soundbars"), C_SPEAK, ""),
                                         ("Headphones", cimg("Headphones & Earbuds"), C_HEAD, ""), ("Storage & more", cimg("Accessories & Storage"), C_ACC, "")]),
                deal(deal_title, cats, 10, 6), price_sale(f"{label} by budget", cats, tiers),
                brands(brand_names, f"Top {label} brands"), rail(f"Best-selling {label.lower()}", cats, 10),
                banner_rail(up, f"banners/electronics-{bn}-1.png", cats, 10, "discount", min_discount=10),
                grid("Top rated picks", cats, 6, "rating"), grid("Best sellers", cats, 8), trending()]
    return f


def el_storage(up):
    ids = ids_named("Samsung T7", "TP-Link", "Logitech", "Portronics")
    cats = [C_ACC]
    return [promo(up, ["banners/electronics-storage-1.png"]), fee(),
            hub("Shop by category", [("Smart Watches", cimg("Smart Watches"), C_WATCH, ""), ("Speakers", cimg("Speakers & Soundbars"), C_SPEAK, ""),
                                     ("Headphones", cimg("Headphones & Earbuds"), C_HEAD, ""), ("Storage & more", cimg("Accessories & Storage"), C_ACC, "")]),
            deal_ids("GADGET DEAL OF THE DAY", ids), price_sale("Gadgets by budget", cats + [C_SPEAK], [999, 2999, 5000, 10000]),
            rail_ids("SSDs, routers & mice", ids), banner_ids(up, "banners/electronics-storage-1.png", ids),
            grid("Best sellers", cats + [C_SPEAK], 8), trending()]


SPECS = {
    ("mobile", "mobile"): {"label": "Mobile", "order": 1, "sections": mobile_mobile},
    ("mobile", "electronics"): {"label": "Electronics", "order": 2, "sections": mobile_electronics},
    ("mobile", "headphones"): {"label": "Headphones", "order": 3, "sections": mobile_headphones},
    ("mobile", "accessories"): {"label": "Accessories", "order": 4, "sections": mobile_accessories},

    ("mobile_part", "all"): {"label": "All", "order": 0, "sections": mobilepart_all},
    ("mobile_part", "screens"): {"label": "Screens", "order": 1, "sections": _part_tab("screens", "Screens & Displays", "screens", [2000, 2500, 3000], "Display combo folders", "DISPLAY")},
    ("mobile_part", "batteries"): {"label": "Batteries", "order": 2, "sections": _part_tab("batteries", "Batteries", "batteries", [1000, 1500, 2000, 3000], "Replacement batteries", "BATTERY")},
    ("mobile_part", "ports"): {"label": "Charging Ports", "order": 3, "sections": _part_tab("ports", "Charging Ports & Flex", "ports", [400, 550, 1000], "Charging port flex cables", "PORT")},
    ("mobile_part", "tools"): {"label": "Tools", "order": 4, "sections": _part_tab("tools", "Repair Tools & Kits", "tools", [400, 800, 5000], "Repair tool kits", "TOOL")},
    ("accessories", "all"): {"label": "All", "order": 0, "sections": acc_all},
    ("accessories", "cases"): {"label": "Cases", "order": 1, "sections": acc_cases},
    ("accessories", "chargers"): {"label": "Chargers", "order": 2, "sections": acc_chargers},
    ("accessories", "powerbanks"): {"label": "Power Banks", "order": 3, "sections": acc_powerbanks},
    ("accessories", "guards"): {"label": "Screen Guards", "order": 4, "sections": acc_guards},
    ("electronics", "all"): {"label": "All", "order": 0, "sections": el_all},
    ("electronics", "watches"): {"label": "Smart Watches", "order": 1, "sections": _el_tab("watches", [C_WATCH], "Smart watches", ["Apple", "Samsung"], [2000, 5000, 10000, 30000], "WATCH DEAL OF THE DAY")},
    ("electronics", "speakers"): {"label": "Speakers", "order": 2, "sections": _el_tab("speakers", [C_SPEAK], "Speakers", ["JBL"], [2000, 7000], "SPEAKER DEAL OF THE DAY")},
    ("electronics", "headphones"): {"label": "Headphones", "order": 3, "sections": _el_tab("headphones", [C_HEAD], "Headphones", ["Sony", "JBL", "boAt", "Apple", "Samsung"], [1999, 5000, 10000, 30000], "AUDIO DEAL OF THE DAY")},
    ("electronics", "storage"): {"label": "Storage & More", "order": 4, "sections": el_storage},
}
