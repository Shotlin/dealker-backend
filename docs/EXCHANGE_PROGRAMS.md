# Exchange programmes (exchange for any product)

Customers can trade in an old device against **any** product the business chooses, not just phones. The dashboard owns the rules; the customer app only reads them.

Migration: `223_exchange_programs.sql`. Code: `src/modules/sell-requests/exchange-programs.service.js` (+ routes in `sell-requests.routes.js`). Test: `tests/integration/exchange-programs.integration.test.js`.

## Model

| Table | Meaning |
|---|---|
| `exchange_device_types` | Kinds of OLD device accepted: `key` (stored in `sell_device_models.category`), `label`, `icon` (`phone, tablet, laptop, headphones, earbuds, watch, speaker, camera, console, other`), and which questions the app asks (`needs_imei`, `has_screen`, `has_battery`, `has_camera`). Seeded: Smartphone, Tablet, Laptop, Headphones, Smartwatch, Speaker. |
| `exchange_programs` | "Products in these categories (incl. sub-categories, or these product ids) can be bought with a trade-in of these device types". `max_value_pct` caps the credit as a share of the new product's price (₹1,000 headphones at 60% -> at most ₹600 off). |
| `sell_device_models` | Catalogue of accepted old models with `base_price` (value in mint condition, top variant). Now accepts any device type key (CHECK constraint removed). |

A product with **no active programme shows no exchange**. Valuation is unchanged: server-side, same engine and deduction rules as Sell (age, condition, battery, accessories…). Non-phone devices send neutral defaults for questions they do not have (e.g. battery 100) — the app decides from the type flags.

IMEI: phones/tablets need a Luhn-valid IMEI (blocklist checked). Other types take no IMEI; the server stores an `NA-xxxx` placeholder (or the serial if given). `sell_requests.imei` is now `VARCHAR(32)` with format check `15 digits OR 3-32 alphanumerics/-`.

## API

Customer (`/api/v1/exchange-requests`)
- `GET /for-product/:productId` (public) → `{ eligible, price, maxValue, types:[{key,label,icon,needsImei,hasScreen,hasBattery,hasCamera,models,upTo,typical,from}] }`. `upTo/typical/from` come from the live catalogue (max / median / min `base_price` of the type's models) capped at the programme share of the price.
- `GET /options/:productId` (auth) → same + `models` (only the accepted types).
- `POST /quote` now also takes `productId` and returns `credit` = `min(value, cap)`.
- `POST /` with `exchange.productId`: the old device's type must be accepted for that product (`NOT_ELIGIBLE` otherwise) and `exchange.tradeInValue` is the capped credit.

Dashboard (`/api/v1/manage/exchange-requests`, permission `exchange_requests.view|manage`, platform staff)
- `GET/POST /types`, `PUT /types/:key`
- `GET/POST /programs`, `PUT/DELETE /programs/:id`
- Device models are still edited at `POST/PUT /manage/sell-requests/models` (permission `sell_requests.settings`); `category` must be an existing device type.

UI: Dashboard → Sell Requests → Settings → **Exchange programmes** tab (programmes + old-device types) and **Device catalogue** tab (models).

## Seeding everyday devices

`node scripts/seed-exchange-catalogue.mjs` adds 31 headphone / smartwatch / speaker models with realistic mint-condition values, copies brand logos from `assets/brand-logos/` to `$UPLOAD_DIR/brands/` and links them (`UPLOADS_BASE_URL` = public URL of that folder), and — only when no programme exists — creates starter programmes by matching your category names (phone/tablet, laptop, headphones/earbuds/audio, watch, speaker). Safe to re-run. Review the programmes in the dashboard afterwards.

## Known gaps
- A customer's saved exchange is still linked to the order by staff (`link-order`), as before; there is no in-cart "apply exchange" yet.
- Programmes target categories and product ids; the dashboard UI offers categories only (product ids are supported by the API).
- Brands without a logo file show a letter badge in the app.
