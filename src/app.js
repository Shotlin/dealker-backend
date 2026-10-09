import Fastify from "fastify";
import { env } from "./config/env.js";
import { query } from "./config/database.js";
import { redis } from "./config/redis.js";
import { sanitize } from "./middlewares/sanitize.js";
import { installRouteCollector } from "./utils/permission-audit.js";

/**
 * Dealker — Flipkart-style Indian multi-vendor marketplace API.
 *
 * Built on the meet-commerce-backend kernel (Fastify 4 + pg + Redis) with
 * grocery/quick-commerce/CRM subsystems removed. Modules follow the same
 * convention: src/modules/<name>/<name>.routes.js registered below.
 */
export const buildApp = async () => {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.LOG_PRETTY && {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }),
    },
    trustProxy: true,
    ajv: {
      customOptions: {
        removeAdditional: "all",
        useDefaults: true,
        coerceTypes: "array",
      },
    },
  });

  // ─── PLUGINS (order matters) ────────────────────────────
  await app.register(import("./plugins/errorHandler.plugin.js"));
  await app.register(import("./plugins/cors.plugin.js"));
  await app.register(import("./plugins/helmet.plugin.js"));
  // Captures the exact raw request bytes onto `request.rawBody` for any
  // route registered with `config: { rawBody: true }` (payment and
  // shipping-provider webhooks set this) — required for verifying webhook
  // signatures against what was actually signed. `global: false` keeps this
  // strictly opt-in per route; every other route's JSON body parsing is
  // unaffected. Must be registered before the routes that use it, and
  // before rate-limiting so a webhook retry storm can't be limited out by
  // the JSON-route rate limiter.
  await app.register(import("fastify-raw-body"), {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });
  await app.register(import("./plugins/rateLimit.plugin.js"));
  await app.register(import("./plugins/auth.plugin.js"));
  await app.register(import("./plugins/swagger.plugin.js"));
  await app.register(import("./plugins/multipart.plugin.js"));
  if (process.env.DISABLE_SOCKETIO !== "true") {
    await app.register(import("./plugins/socketio.plugin.js"));
  }

  // ─── GLOBAL HOOKS ──────────────────────────────────────
  app.addHook("onRequest", sanitize);

  // Never allow an intermediary (Cloudflare, carrier proxy, on-device HTTP
  // cache) to serve a stale copy of a *user-scoped* API response. Any
  // request that resolved an authenticated user is marked no-store so a
  // logged-in customer's cart / wallet / orders / seller-scoped catalog can
  // never be cached and replayed to a different network or user. Anonymous
  // public responses (master catalog, theme, banners) are left untouched so
  // their ETag/Cache-Control edge caching keeps working.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.user && request.user.id) {
      reply.header(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, private",
      );
      reply.header("Pragma", "no-cache");
      reply.header("Expires", "0");
    }
    return payload;
  });

  // ─── PERMISSION AUDIT ROUTE COLLECTOR ────
  // Install BEFORE any module routes register so the `onRoute` hook fires
  // for every dashboard endpoint. The collected array is exposed via
  // `app.permissionAuditRoutes` so `src/server.js` can run the audit
  // after `app.ready()`.
  app.decorate("permissionAuditRoutes", installRouteCollector(app));

  // ─── MODULE ROUTES ─────────────────────────────────────

  // Auth — fully implemented
  await app.register(import("./modules/auth/auth.routes.js"), {
    prefix: "/api/v1/auth",
  });

  // Users — fully implemented
  await app.register(import("./modules/users/users.routes.js"), {
    prefix: "/api/v1/users",
  });

  // Categories — fully implemented
  await app.register(import("./modules/categories/categories.routes.js"), {
    prefix: "/api/v1/categories",
  });

  // Products — master catalog (global catalogue entity shared by vendors)
  await app.register(import("./modules/products/products.routes.js"), {
    prefix: "/api/v1/products",
  });

  // Guest location verification. It creates a signed device storefront
  // session only; no guest account/address is written to the database.
  await app.register(import("./modules/storefront/storefront.routes.js"), {
    prefix: "/api/v1/storefront",
  });

  // Uploads
  await app.register(import("./modules/uploads/uploads.routes.js"), {
    prefix: "/api/v1/uploads",
  });

  // Cart
  await app.register(import("./modules/cart/cart.routes.js"), {
    prefix: "/api/v1/cart",
  });

  // Orders — parent customer orders (multi-vendor checkout)
  await app.register(import("./modules/orders/orders.routes.js"), {
    prefix: "/api/v1/orders",
  });

  // Customer refund requests (item-level / full-order, tied to seller orders)
  await app.register(import("./modules/refund-requests/refund-requests.routes.js"), {
    prefix: "/api/v1/refund-requests",
  });

  // Admin review of refund requests (list / approve / reject)
  await app.register(import("./modules/refund-requests/admin-refund-requests.routes.js"), {
    prefix: "/api/v1/admin/refund-requests",
  });

  // Staff-only investigation (case file) for each refund request
  await app.register(import("./modules/refund-requests/refund-case.routes.js"), {
    prefix: "/api/v1/admin/refund-requests",
  });

  // Listings: every product is one seller's listing (admin or vendor), with local photo uploads
  await app.register(import("@fastify/static"), {
    root: (await import("./modules/uploads/local-uploads.routes.js")).UPLOAD_DIR,
    prefix: "/uploads/",
    decorateReply: false,
    // Uploaded photos are embedded by the dashboard and customer apps on other origins; helmet's
    // default `same-origin` CORP would make every browser refuse to render them.
    setHeaders: (res) => res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"),
  });
  await app.register(import("./modules/uploads/local-uploads.routes.js"), { prefix: "/api/v1/uploads/local" });
  await app.register(async (i) => i.register((await import("./modules/listings/listings.routes.js")).adminListingRoutes), {
    prefix: "/api/v1/admin/listings",
  });
  await app.register(async (i) => i.register((await import("./modules/listings/listings.routes.js")).vendorListingRoutes), {
    prefix: "/api/v1/vendor/listings",
  });

  // Dedicated order page (everything about one order, in plain language)
  await app.register(import("./modules/order-overview/order-overview.routes.js"), { prefix: "/api/v1/admin/order-overview" });

  // Admin vendor KYC review (documents, decisions, history)
  await app.register(import("./modules/vendor-kyc-admin/kyc-admin.routes.js"), { prefix: "/api/v1/admin/vendor-kyc" });

  // Vendor-to-vendor B2B: requirements, quotes, split awards, escrow, dispatch, receipt
  await app.register(async (i) => i.register((await import("./modules/b2b/b2b.routes.js")).vendorB2bRoutes), {
    prefix: "/api/v1/vendor/b2b",
  });
  await app.register(async (i) => i.register((await import("./modules/b2b/b2b.routes.js")).adminB2bRoutes), {
    prefix: "/api/v1/admin/b2b",
  });

  // Customer support chat (customer app) + admin inbox
  await app.register(async (i) => i.register((await import("./modules/support/support.routes.js")).customerSupportRoutes), {
    prefix: "/api/v1/support",
  });
  await app.register(async (i) => i.register((await import("./modules/support/support.routes.js")).adminSupportRoutes), {
    prefix: "/api/v1/admin/support",
  });

  // Vendors — vendor entities, profiles, KYC review, vendor staff
  await app.register(import("./modules/vendors/vendors.routes.js"), {
    prefix: "/api/v1/vendors",
  });

  await app.register(import("./modules/vendors/vendor-kyc.routes.js"), {
    prefix: "/api/v1/vendor-kyc",
  });

  await app.register(import("./modules/vendors/vendor-staff.routes.js"), {
    prefix: "/api/v1/vendor-staff",
  });

  // Catalogue & Product Proposals — vendor new-product requests
  await app.register(import("./modules/catalogue/catalogue.routes.js"), {
    prefix: "/api/v1/catalogue",
  });
  await app.register(import("./modules/catalogue/proposal-media.routes.js"), {
    prefix: "/api/v1/catalogue",
  });

  // Vendor Procurement — B2B vendor↔vendor supply (requirements / RFQ / quotes / supply orders)
  await app.register(import("./modules/vendor-procurement/vendor-procurement.routes.js"), {
    prefix: "/api/v1/vendor-procurement",
  });
  await app.register(import("./modules/vendor-procurement/vendor-procurement.vendor.routes.js"), {
    prefix: "/api/v1/vendor-procurement/vendor",
  });

  // Cart, Loyalty & Quote Engine — checkout quote (real coupon/GST/loyalty math)
  await app.register(import("./modules/cart-quote/cart-quote.routes.js"), {
    prefix: "/api/v1/cart-quote",
  });

  // Admin Reports & Dashboards
  await app.register(import("./modules/reports/reports.routes.js"), {
    prefix: "/api/v1/reports",
  });

  // Payments — Razorpay orders, verify, webhook, reconciliation
  await app.register(import("./modules/payments/payments.routes.js"), {
    prefix: "/api/v1/payments",
  });

  // Wallet — INR-denominated marketplace credit (refunds, cashback, partial payment)
  await app.register(import("./modules/wallet/wallet.routes.js"), {
    prefix: "/api/v1/wallet",
  });

  // Coupons — platform/vendor/category/product/delivery coupons
  await app.register(import("./modules/coupons/coupons.routes.js"), {
    prefix: "/api/v1/coupons",
  });

  // Cart Milestones — graduated cart-value rewards ladder
  await app.register(
    import("./modules/cart-milestones/cart-milestones.routes.js"),
    {
      prefix: "/api/v1/cart-milestones",
    },
  );

  // Addresses
  await app.register(import("./modules/addresses/addresses.routes.js"), {
    prefix: "/api/v1/addresses",
  });

  // Razorpay settings [ADMIN] — dashboard-managed TEST/PRODUCTION credentials
  await app.register(
    import("./modules/razorpay-settings/razorpay-settings.routes.js"),
    {
      prefix: "/api/v1/admin/razorpay-settings",
    },
  );

  // Shiprocket settings [ADMIN] — dashboard-managed API-user credentials
  await app.register(import("./modules/shiprocket/shiprocket.routes.js"), {
    prefix: "/api/v1/admin/shiprocket",
  });

  // Admin — aggregator (auth, orders, overview, team, banners, finance)
  await app.register(import("./modules/admin/admin.routes.js"), {
    prefix: "/api/v1/admin",
  });

  // Banners (public) — active banners for web storefront
  await app.register(import("./modules/banners/banners.routes.js"), {
    prefix: "/api/v1/banners",
  });

  // Theme (public) — active theme for the web storefront
  await app.register(import("./modules/themes/public.routes.js"), {
    prefix: "/api/v1/theme",
  });

  // Wishlist
  await app.register(import("./modules/wishlist/wishlist.routes.js"), {
    prefix: "/api/v1/wishlist",
  });

  // Reviews
  await app.register(import("./modules/reviews/reviews.routes.js"), {
    prefix: "/api/v1/reviews",
  });

  // Shops — vendor fulfilment locations (marketplace shops/warehouses)
  await app.register(import("./modules/shops/shops.routes.js"), {
    prefix: "/api/v1/shops",
  });

  // Shop Staff — role-based access management
  await app.register(import("./modules/shop-staff/shop-staff.routes.js"), {
    prefix: "/api/v1/shop-staff",
  });

  // Alias mount at /shops/:shopId/staff so the dashboard's canonical URL
  // pattern resolves without a separate URL rewrite layer.
  await app.register(import("./modules/shop-staff/shop-staff.routes.js"), {
    prefix: "/api/v1/shops/:shopId/staff",
  });

  // Shop Products — per-vendor seller listings (inventory and pricing)
  await app.register(
    import("./modules/shop-products/shop-products.routes.js"),
    {
      prefix: "/api/v1/shop-products",
    },
  );

  // Seller Listings — nested per-shop write surface + HQ approval
  {
    const {
      shopProductsNestedRoutes,
      shopStockMovementsRoutes,
      shopProductsAdminRoutes,
    } = await import("./modules/shop-products/shop-products.routes.js");
    await app.register(shopProductsNestedRoutes, {
      prefix: "/api/v1/shops/:shopId/products",
    });
    // Stock-movements ledger reader
    await app.register(shopStockMovementsRoutes, {
      prefix: "/api/v1/shops/:shopId/stock-movements",
    });
    // HQ-only admin approve/reject — feature-flagged
    await app.register(shopProductsAdminRoutes, {
      prefix: "/api/v1/admin/shop-products",
    });
  }

  // Seller Orders — one seller_order per vendor/shop group per parent order
  const { sellerOrdersRoutes } = await import(
    "./modules/seller-orders/seller-orders.routes.js"
  );
  await app.register(sellerOrdersRoutes, {
    prefix: "/api/v1/seller-orders",
  });

  // Shop Transactions — read-only append-only ledger
  await app.register(
    import("./modules/shop-transactions/shop-transactions.routes.js"),
    {
      prefix: "/api/v1/shop-transactions",
    },
  );

  // Product Families — option grouping for multi-option products
  await app.register(
    import("./modules/product-families/product-families.routes.js"),
    {
      prefix: "/api/v1/admin/product-families",
    },
  );

  // Allocation — user-shop allocation (pincode + haversine) — local boost signal
  await app.register(import("./modules/allocation/allocation.routes.js"), {
    prefix: "/api/v1/allocation",
  });

  // Shop Financials — read-only paginated financials per period
  await app.register(
    import("./modules/shop-financials/shop-financials.routes.js"),
    {
      prefix: "/api/v1/shop-financials",
    },
  );

  // Shop Finance — vendor-scoped finance endpoints
  await app.register(import("./modules/shop-finance/routes.js"), {
    prefix: "/api/v1/shop-finance",
  });

  // Admin Finance — platform-scoped finance endpoints
  await app.register(import("./modules/admin/finance/routes.js"), {
    prefix: "/api/v1/admin/finance",
  });

  // Audit Logs — read-only endpoints
  {
    const { adminAuditLogsRoutes, shopAuditLogsRoutes } =
      await import("./modules/audit-logs/audit-logs.routes.js");
    await app.register(adminAuditLogsRoutes, {
      prefix: "/api/v1/admin/audit-logs",
    });
    await app.register(shopAuditLogsRoutes, {
      prefix: "/api/v1/shop-audit-logs",
    });
  }

  // Admin Reports — platform-scoped global reports
  await app.register(import("./modules/admin/reports/routes.js"), {
    prefix: "/api/v1/admin/reports",
  });

  // Shop Reports — vendor-scoped reports
  await app.register(import("./modules/shop-reports/routes.js"), {
    prefix: "/api/v1/shop-reports",
  });

  // Notifications
  await app.register(
    import("./modules/notifications/notifications.routes.js"),
    {
      prefix: "/api/v1/notifications",
    },
  );

  // GET /api/v1/notifications/event-flags — the customer-facing half of
  // order-notification-settings (migration 144).
  const { orderNotificationEventFlagsRoutes } = await import(
    "./modules/order-notification-settings/order-notification-settings.routes.js"
  );
  await app.register(orderNotificationEventFlagsRoutes, {
    prefix: "/api/v1/notifications",
  });

  // Fee Settings (admin) — canonical dynamic fee + distance-based local
  // delivery fee engine (local delivery leg of marketplace shipping)
  await app.register(import("./modules/fee-settings/fee-settings.routes.js"), {
    prefix: "/api/v1/admin/fee-settings",
  });

  // Pincode Mappings (admin) — curated pincode -> city/area/state overrides,
  // consumed by /api/v1/addresses/validate-pincode
  await app.register(
    import("./modules/pincode-mappings/pincode-mappings.routes.js"),
    {
      prefix: "/api/v1/admin/pincode-mappings",
    },
  );

  // Order Notification Settings (admin) — per-lifecycle-event editable
  // title/message + independent notification/banner enabled toggles
  const { adminOrderNotificationSettingsRoutes } = await import(
    "./modules/order-notification-settings/order-notification-settings.routes.js"
  );
  await app.register(adminOrderNotificationSettingsRoutes, {
    prefix: "/api/v1/admin/order-notification-settings",
  });

  // Wallet Settings (admin) — max wallet balance + transfer amount limits
  await app.register(
    import("./modules/wallet-settings/wallet-settings.routes.js"),
    {
      prefix: "/api/v1/admin/wallet-settings",
    },
  );

  // ─── MARKETPLACE MODULES (new, additive) ───────────────

  // Loyalty — admin-configurable points program (earning, capped redemption,
  // pending → available lifecycle, append-only ledger). Admin settings surface.
  const { adminLoyaltyRoutes } = await import(
    "./modules/loyalty/loyalty.routes.js"
  );
  await app.register(adminLoyaltyRoutes, {
    prefix: "/api/v1/admin/loyalty",
  });

  // Referrals — customer referral program (codes, qualification, rewards)
  const { referralsRoutes, referralsAdminRoutes } = await import(
    "./modules/referrals/referrals.routes.js"
  );
  await app.register(referralsRoutes, {
    prefix: "/api/v1/referrals",
  });
  await app.register(referralsAdminRoutes, {
    prefix: "/api/v1/admin/referrals",
  });

  // Auctions — paid-registration ascending auctions (customer API + admin/vendor management)
  const { auctionsRoutes, auctionManageRoutes } = await import(
    "./modules/auctions/auctions.routes.js"
  );
  await app.register(auctionsRoutes, { prefix: "/api/v1/auctions" });
  await app.register(auctionManageRoutes, { prefix: "/api/v1/manage/auctions" });

  // Sell requests (customer sells an old device) and Exchange requests (buys new + trades in the old)
  // — two separate sections sharing one valuation engine; see sell-requests.routes.js
  const { sellRequestsRoutes, sellRequestManageRoutes, exchangeRequestsRoutes, exchangeRequestManageRoutes } = await import(
    "./modules/sell-requests/sell-requests.routes.js"
  );
  await app.register(sellRequestsRoutes, { prefix: "/api/v1/sell-requests" });
  await app.register(sellRequestManageRoutes, { prefix: "/api/v1/manage/sell-requests" });
  await app.register(exchangeRequestsRoutes, { prefix: "/api/v1/exchange-requests" });
  await app.register(exchangeRequestManageRoutes, { prefix: "/api/v1/manage/exchange-requests" });

  // Sponsored ads — pay-per-click product promotion (shopper click billing + admin/vendor management)
  const { adsPublicRoutes, adsManageRoutes } = await import(
    "./modules/ads/ads.routes.js"
  );
  await app.register(adsPublicRoutes, { prefix: "/api/v1/ads" });
  await app.register(adsManageRoutes, { prefix: "/api/v1/manage/ads" });

  // Shipping — normalized provider interface (Shiprocket / Blue Dart / Porter),
  // rules-based carrier selection, shipment tracking + webhooks
  const { shippingRoutes } = await import(
    "./modules/shipping/shipping.routes.js"
  );
  await app.register(shippingRoutes, {
    prefix: "/api/v1/admin/shipping",
  });
  await app.register(
    async function shippingWebhooks(fastify) {
      const { registerShippingWebhookRoutes } = await import(
        "./modules/shipping/shipping.routes.js"
      );
      await registerShippingWebhookRoutes(fastify);
    },
    { prefix: "/api/webhook/shipping" },
  );

  // Vendor Settlements — append-only settlement ledger + payouts
  const { adminSettlementsRoutes, vendorSettlementsRoutes } = await import(
    "./modules/vendor-settlements/vendor-settlements.routes.js"
  );
  await app.register(adminSettlementsRoutes, {
    prefix: "/api/v1/admin/settlements",
  });
  await app.register(vendorSettlementsRoutes, {
    prefix: "/api/v1/settlements",
  });

  // Commission rules + vendor wallet (reason-coded ledger view)
  const { adminCommissionRoutes } = await import("./modules/commission/commission.routes.js");
  await app.register(adminCommissionRoutes, { prefix: "/api/v1/admin/commission" });
  const { adminVendorWalletRoutes } = await import("./modules/vendor-wallet/vendor-wallet.routes.js");
  await app.register(adminVendorWalletRoutes, { prefix: "/api/v1/admin/vendor-wallet" });

  // Product QC + seller invoices
  const { adminQcRoutes } = await import("./modules/qc/qc.routes.js");
  await app.register(adminQcRoutes, { prefix: "/api/v1/admin/qc" });
  const { adminInvoicesRoutes, vendorInvoicesRoutes } = await import("./modules/invoices/invoices.routes.js");
  await app.register(adminInvoicesRoutes, { prefix: "/api/v1/admin/invoices" });
  await app.register(vendorInvoicesRoutes, { prefix: "/api/v1/vendor/invoices" });

  // Global price control + merchandising (sections, channels, bulk actions)
  const { adminPricingRoutes } = await import("./modules/pricing/pricing.routes.js");
  await app.register(adminPricingRoutes, { prefix: "/api/v1/admin/pricing" });
  const { adminMerchandisingRoutes, publicSectionRoutes } = await import("./modules/merchandising/merchandising.routes.js");
  await app.register(adminMerchandisingRoutes, { prefix: "/api/v1/admin/merchandising" });
  await app.register(publicSectionRoutes, { prefix: "/api/v1/discovery/sections" });

  // Marketplace Catalog — location-first discovery/ranking + seller-listing moderation
  const { publicDiscoveryRoutes, adminSellerListingsRoutes } = await import(
    "./modules/marketplace-catalog/marketplace-catalog.routes.js"
  );
  await app.register(publicDiscoveryRoutes, {
    prefix: "/api/v1/discovery",
  });
  await app.register(adminSellerListingsRoutes, {
    prefix: "/api/v1/admin/seller-listings",
  });

  // Note: admin banners (/api/v1/admin/banners) is registered via
  // the admin.routes.js aggregator (modules/admin/admin.routes.js).

  // ─── PAYMENT WEBHOOK (outside /api/v1 — no auth, no rate-limit) ──
  await app.register(
    async function razorpayWebhook(fastify) {
      // Lazy-load payments dependencies only for this route
      const { PaymentsRepository } =
        await import("./modules/payments/payments.repository.js");
      const { PaymentsService } =
        await import("./modules/payments/payments.service.js");
      const { PaymentsController } =
        await import("./modules/payments/payments.controller.js");

      const repo = new PaymentsRepository();
      const service = new PaymentsService(repo);
      const controller = new PaymentsController(service);

      fastify.post(
        "/razorpay",
        {
          schema: {
            tags: ["Payments"],
            summary: "Razorpay webhook handler",
          },
          config: {
            rawBody: true,
            rateLimit: false, // Razorpay retries failed webhooks — don't rate-limit
          },
        },
        controller.webhook.bind(controller),
      );
    },
    { prefix: "/api/webhook" },
  );

  // ─── HEALTH CHECKS ─────────────────────────────────────
  app.get(
    "/",
    {
      schema: {
        tags: ["Health"],
        summary: "Root status endpoint",
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              service: { type: "string" },
              timestamp: { type: "string" },
              uptime: { type: "number" },
              health: { type: "string" },
            },
          },
        },
      },
      config: {
        rateLimit: false,
      },
    },
    async () => ({
      status: "OK",
      service: "dealker-backend",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      health: "/health/ready",
    }),
  );

  app.get(
    "/health",
    {
      schema: {
        tags: ["Health"],
        summary: "Liveness health check",
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              timestamp: { type: "string" },
              uptime: { type: "number" },
            },
          },
        },
      },
    },
    async () => ({
      status: "OK",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    }),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        tags: ["Health"],
        summary: "Readiness health check",
      },
    },
    async (request, reply) => {
      const [postgresResult, redisResult] = await Promise.allSettled([
        query("SELECT 1"),
        redis.ping(),
      ]);

      const dependencies = {
        postgres:
          postgresResult.status === "fulfilled"
            ? { status: "up" }
            : {
                status: "down",
                error:
                  postgresResult.reason?.message || "Unknown PostgreSQL error",
              },
        redis:
          redisResult.status === "fulfilled"
            ? { status: "up" }
            : {
                status: "down",
                error: redisResult.reason?.message || "Unknown Redis error",
              },
      };

      const ready = Object.values(dependencies).every(
        (dependency) => dependency.status === "up",
      );

      if (!ready) {
        request.log.error({ dependencies }, "Readiness check failed");
        return reply.code(503).send({
          status: "NOT_READY",
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          dependencies,
        });
      }

      return {
        status: "READY",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        dependencies,
      };
    },
  );

  return app;
};
