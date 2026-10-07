# Product Options / Families — Backend Contract

## Overview

Bakaloo supports multi-option grocery products (e.g., Tomato 250g / 500g / 1kg / 2kg / 5kg, Maggi 95g / 3×95g / 4×95g) through a **product family** grouping model.

## Data Model

### Why `products` rows represent purchasable options

Each purchasable option (e.g., "Tomato 500g") is a distinct row in the `products` table. This means:

- **Cart identity is unchanged**: `(product_id, shop_id)` uniquely identifies a cart line item
- **Stock deduction is unchanged**: each option has its own `shop_products` row with independent stock
- **Order items are unchanged**: `order_items.product_id` points to the exact selected option
- **No migration of existing data**: products without a family remain single-option products

### Why `product_variants` remains legacy

The existing `product_variants` table (migration 015) stores flat variant rows (name, price, stock) that are:
- Only used for display on the product detail page (`json_agg(v)` subquery)
- NOT integrated with `shop_products`, cart, or orders
- NOT used for stock deduction or pricing

The new family/option system is built alongside it without modification. A future migration may deprecate `product_variants` once the family system is proven.

### How `product_families` groups products

```
product_families
├── id (UUID PK)
├── name ("Tomato", "Maggi Double Masala Noodles")
├── slug (unique, URL-safe)
├── category_id (optional FK → categories)
├── thumbnail_url (family-level image)
├── description
├── is_active
└── created_at, updated_at
```

Products link to a family via `products.product_family_id` (nullable FK). When NULL, the product behaves as a standalone single-option product.

### New columns on `products`

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `product_family_id` | UUID NULL | NULL | Links to product_families |
| `option_label` | VARCHAR(100) NULL | NULL | Display label ("500g", "4×95g") |
| `option_sort_order` | INTEGER | 0 | Sort position in option popup |
| `is_default_option` | BOOLEAN | false | Shown as representative in listings |
| `food_type` | VARCHAR(20) | 'NONE' | VEG / NON_VEG / EGG / NONE |
| `origin_tag` | VARCHAR(20) | 'NONE' | IMPORTED / LOCAL / NONE |
| `custom_badges` | JSONB | '[]' | ["Bestseller", "New", "Organic"] |
| `display_delivery_minutes` | INTEGER NULL | NULL | Delivery time shown on card |

### How `shop_products` provides store price/stock

Each option (product row) gets its own `shop_products` entry per store:
- `UNIQUE(shop_id, product_id)` — one listing per option per shop
- Independent `price`, `sale_price`, `stock_quantity`, `max_order_qty`
- Stock deduction targets the exact `shop_products` row

### How cart uses exact `product_id + shop_id`

Redis cart line items: `{ productId, shopId, quantity }`

When a customer selects "Tomato 1kg" from the option popup, the Flutter app sends the exact `product_id` of the 1kg option. The backend resolves the shop and creates a cart line with that specific product_id.

Different options = different product_ids = separate cart lines. No ambiguity.

## API Endpoints

### Product Listing (enhanced)

`GET /api/v1/products?groupOptions=true`

New fields in response:
- `product_family_id` — family UUID or null
- `option_label` — display label or null
- `option_count` — number of available sibling options (1 for standalone)
- `food_type` — VEG / NON_VEG / EGG / NONE
- `origin_tag` — IMPORTED / LOCAL / NONE
- `custom_badges` — array of badge strings
- `display_delivery_minutes` — delivery time or null
- `family_name` — family name or null

When `groupOptions=true`:
- Only one representative per family is returned (prefer default option)
- `option_count` shows how many siblings exist
- Standalone products always appear

### Product Options

`GET /api/v1/products/:id/options`

Returns all purchasable options for a product's family:

```json
{
  "success": true,
  "data": {
    "family": { "id": "...", "name": "Tomato", "slug": "tomato" },
    "options": [
      {
        "id": "product-uuid",
        "name": "Tomato 500g",
        "option_label": "500g",
        "price": 25,
        "sale_price": 20,
        "shop_product_id": "sp-uuid",
        "shop_id": "shop-uuid",
        "sp_stock_quantity": 30,
        "sp_max_order_qty": 10,
        "sp_is_available": true,
        "food_type": "VEG",
        "origin_tag": "LOCAL",
        "custom_badges": [],
        "avg_rating": 4.2,
        "rating_count": 156
      }
    ]
  }
}
```

For authenticated customers: only options available in their allocated shops are returned.

### Product Families (Admin)

- `GET /api/v1/admin/product-families` — List families (paginated)
- `GET /api/v1/admin/product-families/:id` — Get family detail
- `POST /api/v1/admin/product-families` — Create family
- `PATCH /api/v1/admin/product-families/:id` — Update family
- `DELETE /api/v1/admin/product-families/:id` — Deactivate family

## How Flutter Should Use This

1. **Product listing**: Check `option_count`. If > 1, show "X options" badge under ADD button.
2. **ADD button tap**: If `option_count > 1`, call `GET /products/:id/options` and show bottom sheet. If `option_count == 1`, add directly.
3. **Option selection**: Use the option's `id` (product_id) when calling add-to-cart.
4. **Cart display**: The cart enrichment response already includes product name and unit — the option label is part of the product name.

## Backward Compatibility

- Products without `product_family_id` = single-option products (no popup, option_count=1)
- All new columns have safe defaults (NULL, 'NONE', '[]', 0, false)
- Existing product create/update payloads continue to work (new fields are optional)
- Existing cart/order flows are completely unchanged
- The `product_variants` table is not modified
- The `shop_products` UNIQUE constraint is not modified


## Phase 3: Cart / Order Exact Option Identity

Phase 3 hardens the cart and order flow so multiple product options remain
distinct line items end-to-end, and so order items can be audited back to
the exact `shop_products` row that was fulfilled.

### Cart Identity Rules

A cart line item is uniquely identified by `(productId, shopId)`. Because
each option (e.g. Tomato 500g vs Tomato 1kg) is a distinct `products` row,
this identity is naturally option-aware — Tomato 500g and Tomato 1kg are
already separate cart lines.

The cart API now accepts THREE ways to identify a line:

1. **`shopProductId`** (preferred for the option popup) — exact, no
   ambiguity. Backend resolves productId/shopId from `shop_products`.
2. **`productId` + `shopId`** — legacy precise path. Unchanged.
3. **`productId` only** — legacy auto-resolve. If the user's allocations
   carry the product in more than one shop, the API returns
   `CART_SHOP_REQUIRED`.

If any combination is internally inconsistent (e.g. `shopProductId` points
to a different productId than the caller passed) the API returns
`CART_ITEM_IDENTITY_CONFLICT`.

If `shopProductId` is omitted and the cart already has multiple lines that
match `productId` alone, the API returns `CART_ITEM_AMBIGUOUS` instead of
silently mutating sibling options.

### Recommended Flutter Add-To-Cart Payload

When the Flutter option popup is implemented (Phase 5), prefer:

```json
POST /api/v1/cart/items
{ "shopProductId": "<uuid>", "quantity": 1 }
```

This guarantees the exact selected option is added regardless of how many
allocated shops carry the same master product.

### Backward-Compatible Payload (still supported)

```json
POST /api/v1/cart/items
{ "productId": "<uuid>", "quantity": 1 }
```

The backend auto-resolves the shop when only one allocated shop carries
the product. Multi-shop coverage triggers `CART_SHOP_REQUIRED` and the UI
should retry with `shopId` (or, better, with `shopProductId`).

### Update / Remove Identity Rules

```http
PUT /api/v1/cart/items/:productId
{ "quantity": 5, "shopProductId": "<uuid>" }   # preferred
{ "quantity": 5, "shopId": "<uuid>" }          # legacy precise
{ "quantity": 5 }                              # legacy auto, must be unambiguous
```

```http
DELETE /api/v1/cart/items/:productId?shopProductId=<uuid>
DELETE /api/v1/cart/items/:productId?shopId=<uuid>
DELETE /api/v1/cart/items/:productId
```

The `:productId` path param is kept for backward compatibility with the
existing route table. When `shopProductId` is supplied in the body/query
it takes precedence and the path productId is verified for consistency.

### Cart Enrichment Response Fields

Each enriched cart item now includes (camelCase API):

- `productId`, `shopId`, `shopProductId`
- `productFamilyId`, `familyName`, `optionLabel`, `netQuantity`
- `name`, `slug`, `unit`, `image`, `thumbnailUrl`
- `price` (list/MRP), `salePrice`, `originalPrice`, `effectivePrice`
- `discountAmount`, `discountPercent`
- `quantity`, `subtotal`, `lineTotal`
- `stockQuantity`, `maxOrderQty`
- `inStock`, `isAvailable`
- `foodType` (`VEG`/`NON_VEG`/`EGG`/`NONE`)
- `originTag` (`IMPORTED`/`LOCAL`/`NONE`)
- `customBadges` (string array)
- `displayDeliveryMinutes` (integer or null)

Pricing precedence: `shop_products.sale_price` → `shop_products.price` →
`products.sale_price` → `products.price`. The enriched response uses the
shop-level override whenever present.

### Order Item Metadata Rules

`order_items` now persists `shop_product_id` and `shop_id` (migration 049,
both NULLABLE so legacy rows remain valid). New orders created via
`OrderSplitter` populate both columns.

The `orders.items` JSONB also carries:

- `productId`, `shopId`, `shopProductId`
- `productFamilyId`, `familyName`, `optionLabel`, `netQuantity`
- `thumbnailUrl`, `foodType`, `originTag`
- `name`, `price`, `quantity`, `unit`, `total`

Order pricing calculation is unchanged — only the response/JSONB shape is
enriched. Stock deduction continues to lock the exact `shop_products` row
via `findByIdForUpdate` + `applyStockUpdate`, ensuring 500g and 1kg
options decrement independent stock counters.

### Backward Compatibility

- Existing Redis cart entries (`{ productId, shopId, quantity }`) load and
  save unchanged. No migration is performed.
- Old order_items rows have NULL `shop_product_id` / `shop_id` — historical
  orders remain queryable.
- Old Flutter clients sending only `{ productId, quantity }` continue to
  work; no client update is required by Phase 3.
- `product_variants` table is not touched.
