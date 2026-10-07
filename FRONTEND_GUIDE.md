# Bakaloo Grocery Backend — Frontend Developer Guide

> **Base URL:** `http://localhost:3000` (dev) | `https://api.yourdomain.com` (prod)
> **API Version:** All routes prefixed with `/api/v1/`
> **Realtime:** Socket.IO on same host/port

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Authentication Flow](#2-authentication-flow)
3. [API Response Format](#3-api-response-format)
4. [Error Handling](#4-error-handling)
5. [Complete API Reference](#5-complete-api-reference)
   - [Auth](#51-auth)
   - [Users](#52-users)
   - [Categories](#53-categories)
   - [Products](#54-products)
   - [Uploads](#55-uploads)
   - [Cart](#56-cart)
   - [Orders](#57-orders)
   - [Payments (Razorpay)](#58-payments)
   - [Wallet](#59-wallet)
   - [Coupons](#510-coupons)
   - [Addresses](#511-addresses)
   - [Wishlist](#512-wishlist)
   - [Reviews](#513-reviews)
   - [Notifications](#514-notifications)
   - [Delivery (Rider App)](#515-delivery)
   - [Admin Panel (Legacy)](#516-admin-legacy)
   - [Admin Auth](#517-admin-auth)
   - [Admin Dashboard](#518-admin-dashboard)
   - [Admin Orders](#519-admin-orders)
   - [Admin Products](#520-admin-products)
   - [Admin Customers](#521-admin-customers)
   - [Admin Riders](#522-admin-riders)
   - [Admin Notifications & Campaigns](#523-admin-notifications--campaigns)
   - [Admin Analytics](#524-admin-analytics)
   - [Admin Banners](#525-admin-banners)
   - [Admin Activity Log](#526-admin-activity-log)
   - [Public Banners](#527-public-banners)
6. [Socket.IO Realtime Events](#6-socketio-realtime-events)
7. [Order Lifecycle](#7-order-lifecycle)
8. [Payment Integration (Razorpay)](#8-payment-integration-razorpay)
9. [File Uploads](#9-file-uploads)
10. [Pagination Pattern](#10-pagination-pattern)
11. [Role System](#11-role-system)
12. [Rate Limits](#12-rate-limits)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND APPS                             │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐      │
│  │ Customer  │  │ Rider/Driver │  │   Admin Panel     │      │
│  │ Mobile App│  │  Mobile App  │  │   (Web Dashboard) │      │
│  └─────┬─────┘  └──────┬───────┘  └────────┬──────────┘      │
└────────┼───────────────┼────────────────────┼────────────────┘
         │               │                    │
    HTTP REST + Socket.IO (WebSocket)
         │               │                    │
┌────────▼───────────────▼────────────────────▼────────────────┐
│                    BACKEND (Fastify)                          │
│                                                              │
│  ┌─────────┐ ┌──────────┐ ┌───────────┐ ┌───────────────┐   │
│  │  Auth   │ │ Products │ │  Orders   │ │  Payments     │   │
│  │  (JWT)  │ │ + Cart   │ │ + Delivery│ │  (Razorpay)   │   │
│  └────┬────┘ └────┬─────┘ └─────┬─────┘ └───────┬───────┘   │
│       │           │             │                │           │
│  ┌────▼───────────▼─────────────▼────────────────▼───────┐   │
│  │              PostgreSQL 16 (Primary DB)                │   │
│  └───────────────────────────────────────────────────────┘   │
│  ┌──────────────┐  ┌─────────────┐  ┌────────────────────┐   │
│  │  Redis 7     │  │  Cloudinary │  │  BullMQ (Jobs)     │   │
│  │  (Cache+OTP) │  │  (Images)   │  │  (Notifications,   │   │
│  └──────────────┘  └─────────────┘  │   SMS, Orders)     │   │
│                                     └────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**Tech Stack:**
- **Server:** Fastify 4 (Node.js), ESM modules
- **Database:** PostgreSQL 16  
- **Cache:** Redis 7 (caching, OTP storage)
- **Payments:** Razorpay (online), COD, Wallet
- **Images:** Cloudinary CDN
- **Realtime:** Socket.IO (order tracking, notifications)
- **Background Jobs:** BullMQ (notifications, SMS, order processing)
- **SMS OTP:** 2Factor.in
- **Push Notifications:** Firebase FCM (optional, disabled by default)

---

## 2. Authentication Flow

The app uses **phone number + OTP** login. No passwords.

### Login Flow (Step by Step)

```
Customer App                          Backend
     │                                   │
     │  1. POST /auth/send-otp           │
     │   { phone: "+919876543210" }      │
     │──────────────────────────────────>│
     │                                   │── Sends SMS OTP via 2Factor.in
     │   { success: true }               │
     │<──────────────────────────────────│
     │                                   │
     │  User enters OTP from SMS         │
     │                                   │
     │  2. POST /auth/verify-otp         │
     │   { phone: "+919876543210",       │
     │     otp: "847291" }               │
     │──────────────────────────────────>│
     │                                   │── Verifies OTP
     │   {                               │── Creates user if new
     │     accessToken: "eyJ...",        │── Returns JWT tokens
     │     refreshToken: "eyJ...",       │
     │     user: { id, phone, role },    │
     │     isNewUser: true/false         │
     │   }                               │
     │<──────────────────────────────────│
     │                                   │
     │  Store tokens locally             │
     │  (SecureStorage / AsyncStorage)   │
     │                                   │
```

### Using Tokens

```
Authorization: Bearer <accessToken>
```

Add this header to **every authenticated request**. 

### Token Refresh

Access tokens expire in **15 minutes**. When you get a `401` response:

```
POST /api/v1/auth/refresh-token
Body: { "refreshToken": "<stored-refresh-token>" }

Response: { accessToken: "new...", refreshToken: "new..." }
```

**Recommended:** Implement an HTTP interceptor (Axios/Dio) that auto-refreshes on 401.

### Logout

```
POST /api/v1/auth/logout
Headers: Authorization: Bearer <accessToken>
```

---

## 3. API Response Format

**Every** response follows this structure:

### Success Response
```json
{
  "success": true,
  "message": "Products fetched",
  "data": { ... },
  "pagination": {          // Only for paginated endpoints
    "page": 1,
    "limit": 20,
    "total": 142,
    "totalPages": 8
  }
}
```

### Error Response
```json
{
  "success": false,
  "message": "Product not found",
  "code": "NOT_FOUND"
}
```

### Validation Error
```json
{
  "success": false,
  "message": "Validation error",
  "code": "VALIDATION_ERROR",
  "errors": [
    { "field": "phone", "message": "must match pattern \"^[+][0-9]{10,15}$\"" }
  ]
}
```

---

## 4. Error Handling

| HTTP Code | Code | Meaning |
|-----------|------|---------|
| 400 | `BAD_REQUEST` / `VALIDATION_ERROR` | Invalid input |
| 401 | `UNAUTHORIZED` | Missing/expired token |
| 403 | `FORBIDDEN` | Not enough permissions |
| 403 | `ACCOUNT_BLOCKED` | User is blocked by admin |
| 404 | `NOT_FOUND` | Resource doesn't exist |
| 409 | `CONFLICT` | Duplicate (e.g., already in wishlist) |
| 429 | `RATE_LIMIT` | Too many requests |
| 500 | `INTERNAL_ERROR` | Server error |

---

## 5. Complete API Reference

### 5.1 Auth
**Prefix:** `/api/v1/auth`

| Method | Endpoint | Auth | Body / Query | Response |
|--------|----------|------|-------------|----------|
| POST | `/send-otp` | No | `{ phone }` (10-15 chars with country code) | `{ success: true }` |
| POST | `/verify-otp` | No | `{ phone, otp }` (otp: 4-8 chars) | `{ accessToken, refreshToken, user, isNewUser }` |
| POST | `/refresh-token` | No | `{ refreshToken }` | `{ accessToken, refreshToken }` |
| POST | `/logout` | Yes | — | `{ success: true }` |
| DELETE | `/account` | Yes | — | `{ success: true }` |

**Rate Limits:** send-otp: 5 per 5 min | verify-otp: 10 per 5 min

---

### 5.2 Users
**Prefix:** `/api/v1/users` — All routes require auth

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/me` | — | `{ id, phone, email, name, role, avatar_url, birthday, loyalty_points, referral_code }` |
| PUT | `/me` | `{ name?, email?, birthday? }` | Updated user |
| PUT | `/me/avatar` | `multipart/form-data` (image file) | `{ avatar_url }` |
| GET | `/me/stats` | — | `{ total_orders, total_spent, loyalty_points }` |

---

### 5.3 Categories
**Prefix:** `/api/v1/categories`

| Method | Endpoint | Auth | Body / Query | Response |
|--------|----------|------|-------------|----------|
| GET | `/` | No | — | Array of categories (cached 30min) |
| GET | `/:id` | No | — | Single category |
| GET | `/:id/products` | No | `?page=1&limit=20&sort=newest&inStock=true` | Products in category (paginated) |
| POST | `/` | Admin | `{ name, description?, image_url?, parent_id?, sort_order? }` | Created category |
| PUT | `/:id` | Admin | `{ name?, description?, image_url?, is_active? }` | Updated category |
| DELETE | `/:id` | Admin | — | Deleted |

**Sort options:** `price_asc`, `price_desc`, `newest`, `popular`

---

### 5.4 Products
**Prefix:** `/api/v1/products`

| Method | Endpoint | Auth | Body / Query | Response |
|--------|----------|------|-------------|----------|
| GET | `/` | No | `?page=1&limit=20&category=uuid&search=milk&sort=popular&minPrice=10&maxPrice=500&inStock=true` | Products list (paginated) |
| GET | `/search` | No | `?q=organic+milk&page=1&limit=20` | Full-text search results |
| GET | `/featured` | No | — | Featured/bestseller products |
| GET | `/:id` | No | — | Full product detail |
| GET | `/:id/related` | No | — | Related products (same category) |
| POST | `/` | Admin | `{ name, price, categoryId, description?, stock?, unit?, images?, tags?, isFeatured? }` | Created product |
| PUT | `/:id` | Admin | Any product field | Updated product |
| PUT | `/:id/stock` | Admin | `{ stock }` (integer ≥ 0) | Updated stock |
| DELETE | `/:id` | Admin | — | Soft-deleted |
| POST | `/bulk-import` | Admin | `multipart/form-data` (CSV file) | `{ imported, skipped, errors[] }` |

**Product Object:**
```json
{
  "id": "uuid",
  "name": "Organic Milk 500ml",
  "slug": "organic-milk-500ml",
  "description": "Fresh organic milk...",
  "price": 45.00,
  "salePrice": null,
  "costPrice": 35.00,
  "stock_quantity": 120,
  "unit": "ml",
  "category_id": "uuid",
  "images": ["https://cloudinary.com/..."],
  "tags": ["organic", "dairy"],
  "is_featured": true,
  "is_active": true,
  "total_sold": 342,
  "created_at": "2026-01-15T10:30:00Z"
}
```

**Units:** `kg`, `g`, `l`, `ml`, `piece`, `pack`

---

### 5.5 Uploads
**Prefix:** `/api/v1/uploads`

| Method | Endpoint | Auth | Body | Response |
|--------|----------|------|------|----------|
| POST | `/image` | Yes | `multipart/form-data` (single image) | `{ url, public_id }` |
| POST | `/images` | Admin | `multipart/form-data` (multiple images) | `[{ url, public_id }, ...]` |
| DELETE | `/image` | Admin | `{ publicId }` | Deleted |

**Limits:** Max 5MB per image. Formats: JPEG, PNG, WebP.

---

### 5.6 Cart
**Prefix:** `/api/v1/cart` — All routes require auth

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/` | — | `{ items[], subtotal, count }` |
| POST | `/items` | `{ productId, quantity }` (1-50) | Updated cart |
| PUT | `/items/:productId` | `{ quantity }` (1-50) | Updated cart |
| DELETE | `/items/:productId` | — | Updated cart |
| DELETE | `/` | — | Empty cart |
| POST | `/validate` | — | `{ valid, items[], subtotal, warnings[] }` |

**Cart is stored in PostgreSQL**, so it persists across devices.

**Important:** Always call `POST /cart/validate` before checkout to verify stock availability and current prices.

**Cart Item Object:**
```json
{
  "productId": "uuid",
  "name": "Organic Milk",
  "price": 45.00,
  "quantity": 2,
  "unit": "ml",
  "image": "https://...",
  "subtotal": 90.00,
  "inStock": true
}
```

---

### 5.7 Orders
**Prefix:** `/api/v1/orders`

| Method | Endpoint | Auth | Body / Query | Response |
|--------|----------|------|-------------|----------|
| POST | `/` | Yes | `{ addressId, paymentMethod, couponCode?, deliveryNotes? }` | Created order |
| GET | `/` | Yes | `?page=1&limit=10&status=DELIVERED` | User's orders (paginated) |
| GET | `/active` | Yes | — | Current active order (or 404) |
| GET | `/:id` | Yes | — | Full order detail |
| POST | `/:id/cancel` | Yes | `{ reason? }` | Cancelled order |
| POST | `/:id/reorder` | Yes | — | Items added to cart |
| GET | `/:id/invoice` | Yes | — | **PDF file download** (Content-Type: application/pdf) |
| GET | `/admin/all` | Admin | `?page=1&limit=20&status=PENDING&userId=uuid` | All orders |
| PUT | `/admin/:id/status` | Admin | `{ status }` | Updated order |
| PUT | `/admin/:id/rider` | Admin | `{ riderId }` | Rider assigned |

**Payment Methods:** `COD`, `ONLINE`, `WALLET`

**Order Object:**
```json
{
  "id": "uuid",
  "order_number": "GRO-20260221-A1B2C3",
  "status": "CONFIRMED",
  "items": [
    { "productId": "uuid", "name": "Milk", "price": 45, "quantity": 2, "unit": "ml", "total": 90 }
  ],
  "subtotal": 90.00,
  "discount_amount": 10.00,
  "delivery_fee": 25.00,
  "platform_fee": 5.00,
  "tax_amount": 0,
  "total_amount": 110.00,
  "payment_method": "ONLINE",
  "payment_status": "PAID",
  "coupon_code": "SAVE10",
  "delivery_address": { "label": "Home", "address_line": "123 Main St", "city": "Kolkata", "pincode": "700001" },
  "delivery_notes": "Ring the doorbell",
  "estimated_delivery": "2026-02-21T15:00:00Z",
  "created_at": "2026-02-21T12:30:00Z"
}
```

---

### 5.8 Payments
**Prefix:** `/api/v1/payments`

| Method | Endpoint | Auth | Body | Response |
|--------|----------|------|------|----------|
| POST | `/create-order` | Yes | `{ orderId }` | `{ paymentId, razorpayOrderId, amount, currency, keyId }` |
| POST | `/verify` | Yes | `{ razorpayOrderId, razorpayPaymentId, razorpaySignature }` | `{ success: true, order }` |
| GET | `/history` | Yes | `?page=1&limit=10` | Payment history (paginated) |
| POST | `/:id/refund` | Admin | `{ amount?, reason? }` | Refund initiated |

**Webhook:** `POST /api/webhook/razorpay` (no auth — Razorpay calls this directly)

See [Section 8](#8-payment-integration-razorpay) for full Razorpay integration guide.

---

### 5.9 Wallet
**Prefix:** `/api/v1/wallet`

| Method | Endpoint | Auth | Body | Response |
|--------|----------|------|------|----------|
| GET | `/` | Yes | — | `{ balance }` |
| GET | `/transactions` | Yes | `?page=1&limit=20&type=CREDIT` | Transaction history |
| POST | `/add-money` | Yes | `{ amount }` (1-50000) | Updated balance |
| POST | `/pay` | Yes | `{ orderId }` | Payment processed |
| POST | `/transfer` | Yes | `{ phone, amount, description? }` | Transfer complete |
| POST | `/admin/:userId/credit` | Admin | `{ amount, description? }` | Credited |

**Transaction Types:** `CREDIT`, `DEBIT`

---

### 5.10 Coupons
**Prefix:** `/api/v1/coupons`

| Method | Endpoint | Auth | Body / Query | Response |
|--------|----------|------|-------------|----------|
| POST | `/validate` | Yes | `{ code, cartTotal }` | `{ valid, discount, discountType, discountValue, code }` |
| GET | `/available` | Yes | — | List of available coupons for user |
| GET | `/` | Admin | `?page=1&limit=20` | All coupons |
| POST | `/` | Admin | `{ code, discountType, discountValue, minOrderAmount?, maxDiscount?, usageLimit?, perUserLimit?, validFrom?, validUntil? }` | Created coupon |
| PUT | `/:id` | Admin | Any coupon field | Updated coupon |
| DELETE | `/:id` | Admin | — | Deleted |

**Discount Types:** `PERCENTAGE`, `FLAT`

**Frontend Coupon Flow:**
1. Show available coupons: `GET /coupons/available`
2. User selects/enters a code
3. Validate before checkout: `POST /coupons/validate` with `{ code, cartTotal }`
4. If valid, pass `couponCode` when placing order

---

### 5.11 Addresses
**Prefix:** `/api/v1/addresses` — All routes require auth

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/` | — | All saved addresses |
| POST | `/` | `{ addressLine1, city, pincode, label?, addressLine2?, landmark?, state?, lat?, lng?, isDefault? }` | Created address |
| PUT | `/:id` | Any address field | Updated address |
| DELETE | `/:id` | — | Deleted |
| PUT | `/:id/default` | — | Set as default |
| POST | `/validate-pincode` | `{ pincode }` (6-digit Indian pincode) | `{ available, deliveryFee, estimatedMin }` |

**Pincode format:** `^[1-9][0-9]{5}$` (6-digit, first digit not zero)

---

### 5.12 Wishlist
**Prefix:** `/api/v1/wishlist` — All routes require auth

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/` | — | `{ items[], total }` |
| POST | `/items` | `{ productId }` | Added item |
| DELETE | `/items/:productId` | — | Removed |
| DELETE | `/` | — | Cleared |
| POST | `/move-to-cart` | — | `{ movedCount }` — moves all available items to cart |

---

### 5.13 Reviews
**Prefix:** `/api/v1/reviews`

| Method | Endpoint | Auth | Body / Query | Response |
|--------|----------|------|-------------|----------|
| GET | `/products/:productId` | No | `?page=1&limit=10` | `{ reviews[], averageRating, pagination }` |
| POST | `/` | Yes | `{ productId, orderId, rating, comment? }` | Created review |
| PATCH | `/:id` | Yes | `{ rating?, comment? }` | Updated review |
| DELETE | `/:id` | Yes | — | Deleted |
| GET | `/my-reviews` | Yes | `?page=1&limit=10` | User's reviews (paginated) |

**Rules:**
- Rating: 1-5 (integer)
- User must have ordered the product (verified via `orderId`)
- One review per user per product per order

---

### 5.14 Notifications
**Prefix:** `/api/v1/notifications`

| Method | Endpoint | Auth | Body / Query | Response |
|--------|----------|------|-------------|----------|
| GET | `/` | Yes | `?page=1&limit=20&unreadOnly=true` | Notifications list |
| PATCH | `/:id/read` | Yes | — | Marked as read |
| PATCH | `/read-all` | Yes | — | All marked as read |
| DELETE | `/:id` | Yes | — | Deleted |
| GET | `/preferences` | Yes | — | `{ orderUpdates, promotions, newProducts, deliveryUpdates, priceDrops }` |
| PUT | `/preferences` | Yes | `{ orderUpdates?, promotions?, ... }` (all bool) | Updated preferences |
| POST | `/tokens` | Yes | `{ token, platform }` | FCM token registered |

**Platforms (for push token):** `ios`, `android`, `web`

**Notification Object:**
```json
{
  "id": "uuid",
  "title": "Order Confirmed",
  "body": "Your order #GRO-20260221-A1B2C3 has been confirmed",
  "type": "ORDER_STATUS",
  "data": { "orderId": "uuid", "status": "CONFIRMED" },
  "is_read": false,
  "created_at": "2026-02-21T12:35:00Z"
}
```

**Notification Types:** `ORDER_STATUS`, `PAYMENT`, `PROMOTION`, `DELIVERY`, `ADMIN_BROADCAST`, `SYSTEM`

---

### 5.15 Delivery (Rider App)
**Prefix:** `/api/v1/delivery` — All routes require auth (DELIVERY role)

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| GET | `/profile` | — | Rider profile |
| PATCH | `/toggle-online` | `{ isOnline }` (bool) | Updated status |
| GET | `/orders` | `?status=ASSIGNED` | Assigned deliveries |
| PATCH | `/orders/:id/accept` | — | Accepted |
| PATCH | `/orders/:id/pickup` | — | Picked up |
| PATCH | `/orders/:id/deliver` | `{ otp, proofPhotoUrl? }` | Delivered (OTP required) |
| GET | `/stats` | — | `{ totalDeliveries, todayDeliveries, rating, earnings }` |
| PATCH | `/location` | `{ latitude, longitude }` | Location updated |
| GET | `/history` | `?page=1&limit=20` | Delivery history |

**Delivery OTP Flow:**
1. Rider calls `PATCH /orders/:id/accept` → backend generates a **4-digit OTP**, stores it in Redis (10-min TTL), and returns it in the response as `deliveryOtp`
2. Customer receives the OTP (via push notification / visible in order detail)
3. At doorstep, rider enters the OTP in `PATCH /orders/:id/deliver` → backend verifies & deletes the OTP (one-time use)
4. If OTP is wrong → `400 Invalid delivery OTP`. If expired (>10 min) → rider must request a new one

---

### 5.16 Admin Panel (Legacy)
**Prefix:** `/api/v1/admin` — All routes require auth + ADMIN role

These are the original admin endpoints. They remain active for backwards compatibility. New admin features use the sub-module endpoints documented in sections 5.17–5.27 below.

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| GET | `/users` | `?page=1&limit=20&search=john&role=CUSTOMER` | User list |
| PATCH | `/users/:id/role` | `{ role }` (CUSTOMER/ADMIN/DELIVERY) | Role updated |
| PUT | `/users/:id/block` | `{ blocked, reason? }` | User blocked/unblocked |
| GET | `/settings` | — | All app settings (key-value) |
| PUT | `/settings` | `{ "delivery_fee": 30, "min_order_amount": 149 }` | Settings updated |

**Available Settings:**
| Key | Default | Description |
|-----|---------|-------------|
| `delivery_fee` | 25 | Flat delivery fee (₹) |
| `free_delivery_above` | 499 | Free delivery threshold (₹) |
| `platform_fee` | 5 | Platform fee per order (₹) |
| `delivery_radius_km` | 10 | Max delivery radius |
| `express_delivery_min` | 30 | Express delivery time (min) |
| `cod_max_amount` | 2000 | Max COD order amount (₹) |
| `min_order_amount` | 99 | Min order amount (₹) |
| `app_maintenance` | false | Maintenance mode flag |
| `app_version` | "1.0.0" | Current app version |
| `support_phone` | "+919775845587" | Support phone |
| `support_email` | "support@groceryapp.com" | Support email |
| `store_name` | "Bakaloo Grocery" | Store display name |
| `store_gstin` | — | GST identification number |
| `loyalty_rate` | 1 | Loyalty points per ₹100 spent |
| `rider_base_pay` | 30 | Base delivery pay (₹) |
| `rider_per_km_pay` | 8 | Per-km rider pay (₹) |
| `rider_incentive_threshold` | 10 | Deliveries for incentive bonus |
| `rider_incentive_amount` | 100 | Incentive bonus (₹) |

---

### 5.17 Admin Auth
**Prefix:** `/api/v1/admin/auth`

Admin login uses **email + password** (separate from customer OTP flow).

| Method | Endpoint | Auth | Body | Response |
|--------|----------|------|------|----------|
| POST | `/login` | No | `{ email, password }` | `{ accessToken, user: { id, name, email, role } }` |
| PUT | `/password` | Admin | `{ currentPassword, newPassword }` | `{ success: true }` |

**Rate Limit:** `/login` has a dedicated rate limiter — **5 attempts per 15 minutes** per IP.

**Token:** The access token expires in **8 hours** (longer than customer tokens). Use the same `Authorization: Bearer <token>` header pattern.

**Admin Login Flow:**
```
Admin Panel                            Backend
  │                                       │
  │  1. POST /admin/auth/login            │
  │   { email, password }                 │
  │──────────────────────────────────────>│
  │                                       │── bcrypt verify
  │   { accessToken, user }               │── issues JWT (8h)
  │<──────────────────────────────────────│
  │                                       │
  │  Store token, redirect to dashboard   │
```

---

### 5.18 Admin Dashboard
**Prefix:** `/api/v1/admin/dashboard` — All routes require Admin auth

| Method | Endpoint | Query | Response |
|--------|----------|-------|----------|
| GET | `/stats` | `?period=today` (today/week/month/year) | Summary cards with sparklines + period comparison |
| GET | `/revenue-chart` | `?days=30` | Daily revenue time series |
| GET | `/orders-by-hour` | — | Orders grouped by hour (IST), for today |
| GET | `/top-products` | `?limit=10` | Top-selling products by revenue |
| GET | `/low-stock-alerts` | `?threshold=10` | Products below stock threshold |
| GET | `/pending-actions` | — | Counts of items needing attention |
| GET | `/live-stats` | — | Real-time counters (active orders, online riders, etc.) |

**Stats Response Object:**
```json
{
  "revenue": { "value": 125000, "change": 12.5, "sparkline": [800,1200,950,...] },
  "orders": { "value": 342, "change": -3.2, "sparkline": [...] },
  "products": { "value": 150, "change": 2.0 },
  "customers": { "value": 890, "change": 8.1 },
  "riders": { "value": 25, "active": 18 },
  "today": { "orders": 47, "revenue": 15600, "newCustomers": 12 }
}
```

**Pending Actions Object:**
```json
{
  "pendingOrders": 5,
  "lowStockProducts": 12,
  "pendingRiderApprovals": 3,
  "scheduledCampaigns": 1
}
```

---

### 5.19 Admin Orders
**Prefix:** `/api/v1/admin/orders` — All routes require Admin auth

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| GET | `/` | `?page=1&limit=20&status=PENDING&paymentMethod=COD&search=GRO-&startDate=&endDate=` | Orders list (paginated, filterable) |
| GET | `/stats-by-status` | — | `{ PENDING: 5, CONFIRMED: 12, ... }` |
| GET | `/export` | `?status=DELIVERED&startDate=&endDate=` | **CSV file download** |
| GET | `/:id` | — | Full order detail with items, timeline, payment, delivery info |
| PUT | `/:id/status` | `{ status }` | Status updated (validates allowed transitions) |
| PUT | `/:id/assign-rider` | `{ riderId }` | Rider assigned/reassigned |
| POST | `/bulk-assign` | `{ assignments: [{ orderId, riderId }, ...] }` | Bulk rider assignment |
| POST | `/manual` | `{ userId, addressId, items: [{ productId, quantity }], paymentMethod }` | Admin-created order |
| GET | `/:id/invoice` | — | **PDF invoice download** |
| GET | `/:id/packing-slip` | — | **PDF packing slip download** |

**Allowed Status Transitions:**
```
PENDING    → CONFIRMED, CANCELLED
CONFIRMED  → PREPARING, CANCELLED
PREPARING  → PACKED, CANCELLED
PACKED     → OUT_FOR_DELIVERY, CANCELLED
OUT_FOR_DELIVERY → DELIVERED
DELIVERED  → REFUNDED
```

**Order Detail Response (enriched):**
```json
{
  "order": { "id": "uuid", "order_number": "GRO-...", "status": "CONFIRMED", "total": 450, ... },
  "items": [{ "product_id": "uuid", "name": "Milk", "quantity": 2, "price": 45, "total": 90 }],
  "timeline": [
    { "status": "PENDING", "changed_at": "...", "changed_by": "uuid", "note": null },
    { "status": "CONFIRMED", "changed_at": "...", "changed_by": "admin-uuid", "note": "Confirmed by admin" }
  ],
  "payment": { "method": "ONLINE", "status": "PAID", "razorpay_payment_id": "pay_..." },
  "delivery": { "rider_name": "Raju", "status": "ASSIGNED", "distance_km": 3.2 }
}
```

---

### 5.20 Admin Products
**Prefix:** `/api/v1/admin/products` — All routes require Admin auth

| Method | Endpoint | Query / Body | Response |
|--------|----------|-------------|----------|
| GET | `/analytics` | `?page=1&limit=20&sortBy=revenue` (revenue/sold/views) | Product analytics with sales, views, conversion |
| GET | `/dead-stock` | `?days=30` | Products with zero sales in N days |
| GET | `/low-margin` | `?threshold=15` | Products below margin % threshold |
| GET | `/export` | `?format=csv` (csv/xlsx) | **File download** — full product catalog |
| PUT | `/bulk-update` | `{ products: [{ id, price?, sale_price?, category_id?, is_active? }] }` | Bulk price/status update (max 100) |
| POST | `/:id/duplicate` | — | Clones product (with "(Copy)" suffix, stock=0, inactive) |
| GET | `/search-barcode/:code` | — | Find product by SKU/barcode |

**Product Analytics Object:**
```json
{
  "id": 42,
  "name": "Organic Milk 500ml",
  "units_sold": 342,
  "revenue": 15390.00,
  "views": 1200,
  "conversion_rate": 28.50,
  "stock_quantity": 50,
  "category": "Dairy"
}
```

---

### 5.21 Admin Customers
**Prefix:** `/api/v1/admin/customers` — All routes require Admin auth

| Method | Endpoint | Query / Body | Response |
|--------|----------|-------------|----------|
| GET | `/` | `?page=1&limit=20&search=&status=active&sortBy=created_at&sortOrder=DESC` | Customer list (paginated) |
| GET | `/ltv` | — | Top 100 customers by lifetime value |
| GET | `/churned` | `?days=30` | Customers with 2+ orders but inactive for N days |
| GET | `/vip` | `?minOrders=10` | VIP customers (high order count) |
| GET | `/export` | — | **CSV file download** — customer list |
| GET | `/:id` | — | Customer detail with order stats |
| GET | `/:id/orders` | `?page=1&limit=20` | Customer's order history |
| GET | `/:id/addresses` | — | Customer's saved addresses |
| POST | `/:id/credit-wallet` | `{ amount, description? }` | Credit wallet (1–50,000) |
| POST | `/:id/notify` | `{ title, body }` | Send personal push notification |
| PUT | `/:id/block` | `{ blocked }` | Block/unblock customer |

**Sortable columns:** `created_at`, `name`, `orders`, `spent`

**Customer LTV Object:**
```json
{
  "id": "uuid",
  "name": "Priya Sharma",
  "ltv": 45200.00,
  "order_count": 38,
  "avg_order_value": 1189.47,
  "days_since_signup": 180
}
```

---

### 5.22 Admin Riders
**Prefix:** `/api/v1/admin/riders` — All routes require Admin auth

| Method | Endpoint | Query / Body | Response |
|--------|----------|-------------|----------|
| GET | `/` | `?page=1&limit=20&search=&status=online&sortBy=created_at&sortOrder=DESC` | Rider list (paginated) |
| GET | `/live-locations` | — | All online riders with lat/lng and active delivery |
| GET | `/:id` | — | Rider detail (profile, bank info, stats) |
| GET | `/:id/earnings` | `?startDate=&endDate=` | Earnings summary + daily breakdown |
| GET | `/:id/payouts` | — | Payout history |
| POST | `/:id/payouts` | `{ amount, method, reference? }` | Create payout |
| PUT | `/:id/suspend` | `{ suspended }` | Suspend/unsuspend rider |
| PUT | `/:id/commission` | `{ rate }` (0–100) | Set commission rate % |
| GET | `/:id/documents` | — | Uploaded documents (license, aadhar, etc.) |
| PUT | `/:id/documents/:documentId/verify` | `{ status, note? }` | Approve/reject document |

**Status filter values:** `online`, `offline`, `suspended`

**Payout methods:** `BANK_TRANSFER`, `UPI`, `CASH`

**Rider Earnings Object:**
```json
{
  "summary": { "total": 18500.00, "delivery_count": 145, "avg_per_delivery": 127.59 },
  "daily": [
    { "date": "2026-02-21", "total": 850, "deliveries": 7 },
    { "date": "2026-02-20", "total": 720, "deliveries": 6 }
  ]
}
```

---

### 5.23 Admin Notifications & Campaigns
**Prefix:** `/api/v1/admin/notifications` — All routes require Admin auth

#### Templates

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/templates` | — | All notification templates |
| GET | `/templates/:id` | — | Single template |
| POST | `/templates` | `{ name, title, body, type, variables? }` | Created template |
| PUT | `/templates/:id` | `{ name?, title?, body?, type?, variables? }` | Updated template |
| DELETE | `/templates/:id` | — | Deleted |

**Template types:** `PUSH`, `SMS`, `EMAIL`, `IN_APP`

#### Campaigns & Bulk Send

| Method | Endpoint | Body / Query | Response |
|--------|----------|-------------|----------|
| POST | `/send-bulk` | `{ title, body, segment, segmentFilters? }` | Send immediately to segment |
| POST | `/schedule` | `{ title, body, segment, scheduledAt, segmentFilters? }` | Schedule for later |
| GET | `/campaigns` | `?page=1&limit=20` | Campaign history (paginated) |
| GET | `/campaigns/:id` | — | Campaign detail with stats |
| GET | `/segment-count` | `?segment=all` | How many users match the segment |

**Segments:** `all`, `new` (last 30 days), `inactive` (no orders in 30 days), `high_value` (spent ≥₹5000)

**Campaign Object:**
```json
{
  "id": "uuid",
  "title": "Weekend Sale!",
  "body": "Get 20% off on all dairy products",
  "segment": "all",
  "status": "SENT",
  "sent_count": 892,
  "sent_at": "2026-02-21T10:00:00Z",
  "created_by_name": "Admin User"
}
```

---

### 5.24 Admin Analytics
**Prefix:** `/api/v1/admin/analytics` — All routes require Admin auth

| Method | Endpoint | Query | Response |
|--------|----------|-------|----------|
| GET | `/sales` | `?startDate=&endDate=&groupBy=day` (day/week/month) | Revenue time series + summary |
| GET | `/product-performance` | `?startDate=&endDate=&limit=20` | Top products by revenue with conversion |
| GET | `/customer-cohorts` | — | Monthly signup cohorts with retention % |
| GET | `/delivery` | `?startDate=&endDate=` | Delivery time, distance, rating, by-hour breakdown |
| GET | `/financial` | `?startDate=&endDate=` | Gross/net revenue, payment methods, GST breakdown |
| GET | `/comparison` | `?period1Start=&period1End=&period2Start=&period2End=` | Compare two date ranges (% changes) |
| GET | `/export-pdf` | `?startDate=&endDate=` | **PDF report download** |

**Sales Analytics Response:**
```json
{
  "summary": {
    "total_revenue": 450000,
    "total_orders": 1250,
    "avg_order_value": 360,
    "unique_customers": 480,
    "total_discounts": 22000
  },
  "timeSeries": [
    { "period": "2026-02-01", "revenue": 15000, "orders": 42, "avg_order_value": 357, "total_discount": 800 }
  ]
}
```

**Financial Report Response:**
```json
{
  "revenue": { "gross": 450000, "discounts": 22000, "delivery_fees": 8500, "net": 428000, "order_count": 1250 },
  "byPaymentMethod": [
    { "payment_method": "ONLINE", "revenue": 320000, "count": 890 },
    { "payment_method": "COD", "revenue": 100000, "count": 280 },
    { "payment_method": "WALLET", "revenue": 30000, "count": 80 }
  ],
  "gstBreakdown": [
    { "gst_rate": 5, "taxable_amount": 200000, "gst_amount": 10000 },
    { "gst_rate": 12, "taxable_amount": 150000, "gst_amount": 18000 }
  ]
}
```

**Comparison Response:**
```json
{
  "current": { "revenue": 125000, "orders": 340, "customers": 180, "aov": 367 },
  "previous": { "revenue": 110000, "orders": 310, "customers": 162, "aov": 354 },
  "changes": { "revenue": 14, "orders": 10, "customers": 11, "aov": 4 }
}
```

---

### 5.25 Admin Banners
**Prefix:** `/api/v1/admin/banners` — All routes require Admin auth

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/` | — | All banners (ordered by sort_order) |
| GET | `/:id` | — | Single banner |
| POST | `/` | `{ title, imageUrl, linkType?, linkValue?, isActive?, startDate?, endDate? }` | Created banner |
| PUT | `/:id` | Any banner field | Updated banner |
| DELETE | `/:id` | — | Deleted |
| PUT | `/reorder` | `{ orderedIds: ["uuid1", "uuid2", ...] }` | Reorder banners |

**Link types:** `category`, `product`, `url`, `none`

**Banner Object:**
```json
{
  "id": "uuid",
  "title": "Summer Sale",
  "image_url": "https://cloudinary.com/...",
  "link_type": "category",
  "link_value": "category-uuid",
  "is_active": true,
  "sort_order": 1,
  "start_date": "2026-03-01T00:00:00Z",
  "end_date": "2026-03-31T23:59:59Z"
}
```

---

### 5.26 Admin Activity Log
**Prefix:** `/api/v1/admin/activity-log` — Requires Admin auth

| Method | Endpoint | Query | Response |
|--------|----------|-------|----------|
| GET | `/` | `?page=1&limit=50&adminId=uuid&action=UPDATE_STATUS&entityType=order` | Admin activity log (paginated) |

**Every admin write operation** (status changes, rider assignments, wallet credits, blocks, settings updates, etc.) is automatically logged.

**Activity Log Entry:**
```json
{
  "id": "uuid",
  "admin_id": "uuid",
  "admin_name": "Admin User",
  "action": "UPDATE_ORDER_STATUS",
  "entity_type": "order",
  "entity_id": "order-uuid",
  "old_value": { "status": "PENDING" },
  "new_value": { "status": "CONFIRMED" },
  "ip_address": "192.168.1.1",
  "created_at": "2026-02-21T14:30:00Z"
}
```

---

### 5.27 Public Banners
**Prefix:** `/api/v1/banners` — No auth required

| Method | Endpoint | Auth | Response |
|--------|----------|------|----------|
| GET | `/` | No | Active banners (filtered by date, ordered) |

Returns only banners where `is_active = true` and current date is within `start_date`–`end_date` range. Use this on the customer app home screen carousel.

---

## 6. Socket.IO Realtime Events

### Connection

```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:3000", {
  auth: {
    token: "your-jwt-access-token"     // Required
  },
  transports: ["websocket"]             // Recommended
});

socket.on("connect", () => {
  console.log("Connected:", socket.id);
});
```

### Auto-Joined Rooms (on connect)

| Room | Who | Purpose |
|------|-----|---------|
| `user:{userId}` | Everyone | Personal notifications + order updates |
| `riders:online` | DELIVERY role | Admin can see all online riders |
| `admin:dashboard` | ADMIN role | Real-time admin updates |

### Events You SEND (Client → Server)

```javascript
// Track a specific order (join order room)
socket.emit("order:track", "order-uuid-here");

// Stop tracking an order (leave room)
socket.emit("order:untrack", "order-uuid-here");

// [RIDER ONLY] Send location update
socket.emit("rider:location", {
  latitude: 22.5726,
  longitude: 88.3639,
  orderId: "order-uuid"       // optional — for active delivery
});

// [RIDER ONLY] Go offline
socket.emit("rider:offline");
```

### Events You LISTEN TO (Server → Client)

```javascript
// Order status changed (customer tracking screen)
socket.on("order:status", (data) => {
  // data = { orderId, status, updatedAt, ... }
  console.log("Order status:", data.status);
});

// New notification received
socket.on("notification", (data) => {
  // data = { id, title, body, type, data, created_at }
  showNotificationBanner(data);
});

// [CUSTOMER] Live rider location on tracking screen
socket.on("rider:location:update", (data) => {
  // data = { riderId, latitude, longitude, timestamp }
  updateMapMarker(data.latitude, data.longitude);
});

// [ADMIN] Bulk rider locations for dashboard map
socket.on("rider:location:bulk", (data) => {
  // data = { riderId, latitude, longitude, timestamp }
  updateDashboardMap(data);
});

// ─── ADMIN DASHBOARD EVENTS (new) ────────────────────

// [ADMIN] New order placed — update dashboard counters
socket.on("dashboard:new_order", (order) => {
  // order = { id, order_number, total, payment_method, created_at }
  incrementOrderCounter();
  showToast(`New order: ${order.order_number}`);
});

// [ADMIN] Product fell below stock threshold
socket.on("dashboard:low_stock", (product) => {
  // product = { id, name, stock_quantity, low_stock_threshold }
  showLowStockAlert(product);
});

// [ADMIN] Payment received
socket.on("dashboard:payment_received", (payment) => {
  // payment = { orderId, amount, method, status }
  updateRevenueCounter(payment.amount);
});

// [ADMIN] Periodic bulk rider locations (every 10 seconds)
socket.on("dashboard:rider_locations", (locations) => {
  // locations = [{ riderId, lat, lng, updatedAt }, ...]
  updateDashboardMap(locations);
});
```

---

## 7. Order Lifecycle

```
  Customer places order
         │
         ▼
     ┌─────────┐
     │ PENDING  │ ◄─── Order created, waiting for confirmation
     └────┬─────┘
          │  Admin confirms / auto-confirmed
          ▼
     ┌───────────┐
     │ CONFIRMED │ ◄─── Payment verified (or COD accepted)
     └────┬──────┘
          │  Store starts preparing
          ▼
     ┌───────────┐
     │ PREPARING │ ◄─── Items being packed
     └────┬──────┘
          │  All items packed
          ▼
     ┌────────┐
     │ PACKED │ ◄─── Ready for pickup by rider
     └────┬───┘
          │  Rider picks up
          ▼
  ┌──────────────────┐
  │ OUT_FOR_DELIVERY  │ ◄─── Rider on the way (live tracking starts)
  └────────┬─────────┘
           │  Rider delivers + OTP verified
           ▼
     ┌───────────┐
     │ DELIVERED │ ◄─── Order complete ✓
     └───────────┘

  At any point before OUT_FOR_DELIVERY:
     ┌───────────┐
     │ CANCELLED │ ◄─── Customer or admin cancels
     └───────────┘

  After delivery if issue:
     ┌──────────┐
     │ REFUNDED │ ◄─── Admin initiates refund
     └──────────┘
```

### Frontend Screens by Status

| Status | Customer Screen | Actions Available |
|--------|----------------|-------------------|
| PENDING | "Order placed, waiting..." | Cancel |
| CONFIRMED | "Order confirmed!" | Cancel |
| PREPARING | "Preparing your order..." | Cancel |
| PACKED | "Order packed, finding rider..." | — |
| OUT_FOR_DELIVERY | **Live tracking map** + rider location | — |
| DELIVERED | "Delivered! Rate your experience" | Reorder, Review |
| CANCELLED | "Order cancelled" | Reorder |

---

## 8. Payment Integration (Razorpay)

### Flow (Customer App)

```
1. Place order with paymentMethod: "ONLINE"
   POST /api/v1/orders
   → Get orderId

2. Create Razorpay order
   POST /api/v1/payments/create-order
   Body: { orderId }
   → Get { razorpayOrderId, amount, currency, keyId }

3. Open Razorpay checkout (SDK)
   Pass razorpayOrderId, amount, keyId to Razorpay SDK
   User completes payment in Razorpay UI

4. On success callback, verify payment
   POST /api/v1/payments/verify
   Body: {
     razorpayOrderId: "order_xxx",
     razorpayPaymentId: "pay_xxx",
     razorpaySignature: "sig_xxx"
   }
   → Order status updated to CONFIRMED
```

### React Native Example (Razorpay)

```javascript
import RazorpayCheckout from 'react-native-razorpay';

const payOnline = async (orderId) => {
  // Step 1: Create Razorpay order
  const { data } = await api.post('/payments/create-order', { orderId });

  // Step 2: Open Razorpay checkout
  const options = {
    key: data.keyId,
    amount: data.amount,              // in paise (₹100 = 10000)
    currency: data.currency,
    order_id: data.razorpayOrderId,
    name: 'Bakaloo Grocery',
    description: 'Order Payment',
    prefill: { contact: userPhone },
    theme: { color: '#4CAF50' },
  };

  try {
    const result = await RazorpayCheckout.open(options);

    // Step 3: Verify payment
    await api.post('/payments/verify', {
      razorpayOrderId: result.razorpay_order_id,
      razorpayPaymentId: result.razorpay_payment_id,
      razorpaySignature: result.razorpay_signature,
    });

    // Payment successful! Navigate to order tracking
  } catch (error) {
    // Payment failed or cancelled
    Alert.alert('Payment Failed', error.description);
  }
};
```

---

## 9. File Uploads

All file uploads use `multipart/form-data`.

### Uploading a Product Image (Admin)

```javascript
const formData = new FormData();
formData.append('image', {
  uri: imageUri,
  type: 'image/jpeg',
  name: 'product.jpg',
});

const response = await fetch(`${BASE_URL}/api/v1/uploads/image`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    // Do NOT set Content-Type — let browser set boundary
  },
  body: formData,
});
```

### CSV Bulk Import (Admin)

```javascript
const formData = new FormData();
formData.append('file', csvFile);

const response = await api.post('/products/bulk-import', formData, {
  headers: { 'Content-Type': 'multipart/form-data' },
});
// Response: { imported: 45, skipped: 3, errors: ["Row 12: Invalid price"] }
```

**CSV Format:**
```csv
name,description,price,stock_quantity,unit,category_id,images,is_featured
Organic Milk,Fresh farm milk,45,100,ml,uuid-here,https://img1.jpg|https://img2.jpg,true
```

---

## 10. Pagination Pattern

All paginated endpoints accept:

| Param | Default | Max | Description |
|-------|---------|-----|-------------|
| `page` | 1 | — | Page number |
| `limit` | 10-20 | 50 | Items per page |

Response always includes:
```json
{
  "data": [...],
  "pagination": {
    "page": 2,
    "limit": 20,
    "total": 142,
    "totalPages": 8
  }
}
```

### Example: Infinite scroll
```javascript
let page = 1;
const loadMore = async () => {
  const { data, pagination } = await api.get(`/products?page=${page}&limit=20`);
  setProducts(prev => [...prev, ...data]);
  setHasMore(page < pagination.totalPages);
  page++;
};
```

---

## 11. Role System

| Role | Access | Description |
|------|--------|-------------|
| `CUSTOMER` | Default | Browse, order, pay, review, wishlist |
| `DELIVERY` | Rider app | Accept orders, update location, deliver |
| `ADMIN` | Full access | Manage everything, analytics, settings |

New users are created as `CUSTOMER`. Admins can change roles via `PATCH /admin/users/:id/role`.

**Blocked users** get `403 ACCOUNT_BLOCKED` on every authenticated request.

---

## 12. Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /auth/send-otp` | 5 requests | 5 minutes |
| `POST /auth/verify-otp` | 10 requests | 5 minutes |
| `POST /admin/auth/login` | 5 requests | 15 minutes |
| All other endpoints | 100 requests | 1 minute |

Rate limit headers in response:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 97
X-RateLimit-Reset: 1708532400
```

---

## Quick Start Checklist for Frontend Dev

1. **Set up HTTP client** (Axios/Dio) with base URL `http://localhost:3000/api/v1`
2. **Add auth interceptor** — attach `Authorization: Bearer <token>` header, auto-refresh on 401
3. **Implement login** — send-otp → verify-otp → store tokens
4. **Load categories + products** — public endpoints, no auth needed
5. **Build cart** — add/update/remove items, validate before checkout
6. **Implement checkout** — select address → apply coupon → choose payment → place order
7. **Set up Socket.IO** — connect with auth token, listen for `order:status` + `notification`
8. **Build order tracking** — emit `order:track`, listen for `rider:location:update`
9. **Add Razorpay SDK** — for online payments
10. **Push notifications** — register FCM token via `POST /notifications/tokens`

---

## Running the Backend Locally

```bash
# 1. Start PostgreSQL + Redis
docker compose up -d postgres redis

# 2. Create .env from example
cp .env.example .env

# 3. Install dependencies
npm install

# 4. Run database migrations
npm run db:migrate

# 5. Seed sample data (optional)
npm run db:seed

# 6. Start development server
npm run dev

# Server runs at http://localhost:3000
# Health check: http://localhost:3000/health
```

---

**Total API Surface:**
- **160+ HTTP endpoints** across 27 modules (16 original + 11 new admin sub-modules)
- **1 webhook** endpoint (Razorpay)
- **4 Socket.IO client events** + **8 server events** (4 original + 4 new dashboard events)
- **3 user roles** (Customer, Delivery, Admin)
- **7 order statuses** with full lifecycle + admin status transition validation
- **3 payment methods** (COD, Online/Razorpay, Wallet)
- **Admin dashboard** with real-time stats, analytics, campaigns, activity logging
- **PDF exports** (invoices, packing slips, analytics reports)
- **CSV/XLSX exports** (orders, products, customers)
