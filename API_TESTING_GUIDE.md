# 🧪 GROCERY APP — COMPLETE API TESTING GUIDE

> **Total Endpoints:** 60+ | **Modules:** 11 | **Covers:** Weeks 1–4  
> **Base URL:** `http://localhost:3000`  
> **Ngrok URL:** `https://arjun-postexilian-meredith.ngrok-free.dev`  
> **Swagger Docs:** `http://localhost:3000/documentation`

---

## 📖 TABLE OF CONTENTS

| # | Section | Endpoints |
|---|---------|-----------|
| 0 | [Setup & Prerequisites](#0-setup--prerequisites) | — |
| 1 | [Health Check & Stubs](#1-health-check--stubs) | 2 |
| 2 | [Auth Module](#2-auth-module----apiv1auth) | 5 |
| 3 | [Users Module](#3-users-module----apiv1users) | 4 |
| 4 | [Categories Module](#4-categories-module----apiv1categories) | 6 |
| 5 | [Products Module](#5-products-module----apiv1products) | 9 |
| 6 | [Uploads Module](#6-uploads-module----apiv1uploads) | 3 |
| 7 | [Cart Module](#7-cart-module----apiv1cart) | 6 |
| 8 | [Addresses Module](#8-addresses-module----apiv1addresses) | 6 |
| 9 | [Coupons Module](#9-coupons-module----apiv1coupons) | 6 |
| 10 | [Orders Module](#10-orders-module----apiv1orders) | 9 |
| 11 | [Payments Module](#11-payments-module----apiv1payments) | 4 |
| 12 | [Wallet Module](#12-wallet-module----apiv1wallet) | 6 |
| 13 | [Razorpay Webhook](#13-razorpay-webhook) | 1 |
| 14 | [Business Rules Quick Reference](#14-business-rules-quick-reference) | — |
| 15 | [Order Status Flow Diagram](#15-order-status-flow-diagram) | — |

---

## 0. SETUP & PREREQUISITES

### Start the server

```bash
cd bakaloo-backend
npm run dev          # Starts on http://localhost:3000
```

### Auth Tokens

Almost every endpoint needs a **Bearer token**. Get one by:

1. Send OTP → `POST /api/v1/auth/send-otp`
2. Verify OTP → `POST /api/v1/auth/verify-otp`
3. Copy the `accessToken` from the response
4. Use header: `Authorization: Bearer <accessToken>`

> **Token Lifetime:** Access = 15 min | Refresh = 7 days

### Standard Response Format

Every response follows this structure:

```
✅ Success: { "success": true,  "message": "...", "data": { ... } }
❌ Error:   { "success": false, "message": "...", "code": "ERROR_CODE" }
```

Paginated responses add:
```json
{ "pagination": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 } }
```

### Global Error Responses (apply to ALL protected routes)

| Status | When | Response |
|--------|------|----------|
| `401` | Missing/expired/invalid token | `{ "success": false, "message": "Unauthorized — invalid or expired token", "code": "UNAUTHORIZED" }` |
| `403` | User role not allowed | `{ "success": false, "message": "Forbidden — insufficient permissions", "code": "FORBIDDEN" }` |
| `429` | Too many requests | `{ "success": false, "message": "Rate limit exceeded. Try again in X seconds.", "code": "RATE_LIMIT_EXCEEDED" }` |
| `400` | Schema validation failed | `{ "statusCode": 400, "error": "Bad Request", "message": "body must have required property 'phone'" }` |

### Role Legend

| Symbol | Meaning |
|--------|---------|
| 🔓 | No authentication required |
| 🔐 | Requires valid `Authorization: Bearer <token>` |
| 🛡️ | Requires ADMIN role |

---

## 1. HEALTH CHECK & STUBS

### 🔓 `GET /health` — Server Health Check

**When to use:** Verify the server is running.

```bash
curl http://localhost:3000/health
```

**✅ 200 — Server is healthy**
```json
{
  "status": "OK",
  "timestamp": "2026-02-20T16:00:00.000Z",
  "uptime": 123.45
}
```

---

### 🔓 Stub Routes — Not Yet Implemented (Week 5–6)

These return `501 Not Implemented`:

| Endpoint | Module |
|----------|--------|
| `GET /api/v1/delivery/` | Delivery |
| `GET /api/v1/notifications/` | Notifications |
| `GET /api/v1/wishlist/` | Wishlist |
| `GET /api/v1/reviews/` | Reviews |
| `GET /api/v1/admin/` | Admin |

```bash
curl http://localhost:3000/api/v1/delivery/
```

**❌ 501 — Not implemented**
```json
{
  "success": false,
  "message": "Delivery module not yet implemented"
}
```

---

## 2. AUTH MODULE — `/api/v1/auth`

### 🔓 `POST /api/v1/auth/send-otp` — Send OTP to Phone

**Rate Limit:** 5 requests per 5 minutes per IP.

**Request:**
```bash
curl -X POST http://localhost:3000/api/v1/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{ "phone": "9876543210" }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `phone` | string | ✅ | 10–15 characters |

**✅ 200 — OTP sent (dev mode returns OTP in response)**
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "data": {
    "otp": "482916"
  }
}
```

> ⚠️ `data.otp` is only returned when `NODE_ENV=development`. In production, OTP is sent via SMS only.

**❌ 400 — Invalid phone format**
```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "body/phone must NOT have fewer than 10 characters"
}
```

**❌ 429 — Rate limited**
```json
{
  "success": false,
  "message": "Rate limit exceeded. Try again in 240 seconds.",
  "code": "RATE_LIMIT_EXCEEDED"
}
```

---

### 🔓 `POST /api/v1/auth/verify-otp` — Verify OTP & Get Tokens

**Rate Limit:** 10 requests per 5 minutes.

**Request:**
```bash
curl -X POST http://localhost:3000/api/v1/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{ "phone": "9876543210", "otp": "482916" }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `phone` | string | ✅ | 10–15 characters |
| `otp` | string | ✅ | 4–8 characters |

**✅ 200 — New user (first login creates account)**
```json
{
  "success": true,
  "message": "Account created successfully",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "phone": "9876543210",
      "name": null,
      "role": "CUSTOMER",
      "isNewUser": true
    }
  }
}
```

**✅ 200 — Existing user**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "phone": "9876543210",
      "name": "Sayan",
      "role": "CUSTOMER",
      "isNewUser": false
    }
  }
}
```

**❌ 400 — Wrong OTP**
```json
{
  "success": false,
  "message": "Invalid OTP",
  "code": "INVALID_OTP"
}
```

**❌ 400 — OTP expired (after 5 minutes)**
```json
{
  "success": false,
  "message": "OTP expired",
  "code": "INVALID_OTP"
}
```

**❌ 400 — Too many wrong attempts (5+ failures)**
```json
{
  "success": false,
  "message": "Too many attempts. Try again after 30 minutes",
  "code": "INVALID_OTP"
}
```

**❌ 400 — Account blocked by admin**
```json
{
  "success": false,
  "message": "Account blocked",
  "code": "INVALID_OTP"
}
```

> 💡 **Save the `accessToken`** — you'll need it for every 🔐 and 🛡️ endpoint below.

---

### 🔓 `POST /api/v1/auth/refresh-token` — Refresh Expired Access Token

**Request:**
```bash
curl -X POST http://localhost:3000/api/v1/auth/refresh-token \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "eyJhbGciOiJIUzI1NiIs..." }'
```

| Field | Type | Required |
|-------|------|----------|
| `refreshToken` | string | ✅ |

**✅ 200 — Tokens refreshed (old refresh token invalidated)**
```json
{
  "success": true,
  "message": "Token refreshed successfully",
  "data": {
    "accessToken": "eyJ_NEW_ACCESS_TOKEN...",
    "refreshToken": "eyJ_NEW_REFRESH_TOKEN..."
  }
}
```

**❌ 400 — Missing refresh token**
```json
{
  "success": false,
  "message": "Refresh token is required",
  "code": "REFRESH_TOKEN_REQUIRED"
}
```

**❌ 401 — Invalid or expired refresh token**
```json
{
  "success": false,
  "message": "Invalid or expired refresh token",
  "code": "INVALID_REFRESH_TOKEN"
}
```

---

### 🔐 `POST /api/v1/auth/logout` — Logout

**Request:**
```bash
curl -X POST http://localhost:3000/api/v1/auth/logout \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — Logged out**
```json
{
  "success": true,
  "message": "Logged out successfully",
  "data": null
}
```

---

### 🔐 `DELETE /api/v1/auth/account` — Delete Account (GDPR)

**Request:**
```bash
curl -X DELETE http://localhost:3000/api/v1/auth/account \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — Account permanently deleted**
```json
{
  "success": true,
  "message": "Account deleted successfully",
  "data": null
}
```

> ⚠️ **Irreversible!** Removes user from database, deletes all tokens from Redis.

---

## 3. USERS MODULE — `/api/v1/users`

### 🔐 `GET /api/v1/users/me` — Get My Profile

**Request:**
```bash
curl http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — Profile fetched**
```json
{
  "success": true,
  "message": "Profile fetched",
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "phone": "9876543210",
    "email": "sayan@example.com",
    "name": "Sayan Mondal",
    "role": "CUSTOMER",
    "avatar_url": "https://res.cloudinary.com/xxx/image/upload/v1/avatars/abc.jpg",
    "birthday": "1998-05-15",
    "loyalty_points": 150,
    "referral_code": "SAY7X2K",
    "created_at": "2026-02-01T10:00:00.000Z"
  }
}
```

**❌ 404 — User not found (deleted account)**
```json
{
  "success": false,
  "message": "User not found",
  "code": "USER_NOT_FOUND"
}
```

---

### 🔐 `PUT /api/v1/users/me` — Update My Profile

**Request:**
```bash
curl -X PUT http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sayan Mondal",
    "email": "sayan@example.com",
    "birthday": "1998-05-15"
  }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | string | ❌ | 2–100 characters |
| `email` | string | ❌ | Valid email, max 255 |
| `birthday` | string | ❌ | Format: `YYYY-MM-DD` |

**✅ 200 — Profile updated**
```json
{
  "success": true,
  "message": "Profile updated",
  "data": {
    "id": "a1b2c3d4-...",
    "phone": "9876543210",
    "name": "Sayan Mondal",
    "email": "sayan@example.com",
    "birthday": "1998-05-15",
    "role": "CUSTOMER",
    "avatar_url": null,
    "loyalty_points": 0,
    "referral_code": "SAY7X2K",
    "created_at": "2026-02-01T10:00:00.000Z"
  }
}
```

**❌ 400 — Email already taken by another user**
```json
{
  "success": false,
  "message": "Email is already in use",
  "code": "EMAIL_TAKEN"
}
```

---

### 🔐 `PUT /api/v1/users/me/avatar` — Upload Avatar

**Request:**
```bash
curl -X PUT http://localhost:3000/api/v1/users/me/avatar \
  -H "Authorization: Bearer <accessToken>" \
  -F "file=@/path/to/photo.jpg"
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `file` | file | ✅ | JPEG, PNG, or WebP only. Max 5MB |

**✅ 200 — Avatar uploaded (cropped to 300×300)**
```json
{
  "success": true,
  "message": "Avatar updated",
  "data": {
    "avatar_url": "https://res.cloudinary.com/dxxxxxx/image/upload/v1708/avatars/abc123.jpg"
  }
}
```

**❌ 400 — No file uploaded**
```json
{
  "success": false,
  "message": "No file uploaded",
  "code": "NO_FILE"
}
```

**❌ 400 — Invalid file type**
```json
{
  "success": false,
  "message": "Only JPEG, PNG, and WebP images are allowed",
  "code": "INVALID_FILE_TYPE"
}
```

---

### 🔐 `GET /api/v1/users/me/stats` — Get My Stats

**Request:**
```bash
curl http://localhost:3000/api/v1/users/me/stats \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — Stats fetched**
```json
{
  "success": true,
  "message": "Stats fetched",
  "data": {
    "total_orders": 12,
    "total_spent": 4599.50,
    "loyalty_points": 200
  }
}
```

---

## 4. CATEGORIES MODULE — `/api/v1/categories`

### 🔓 `GET /api/v1/categories/` — List All Categories

**Request:**
```bash
curl http://localhost:3000/api/v1/categories/
```

**✅ 200 — Categories fetched (cached 30 min)**
```json
{
  "success": true,
  "message": "Categories fetched",
  "data": [
    {
      "id": "c1d2e3f4-...",
      "name": "Fruits & Vegetables",
      "slug": "fruits-vegetables",
      "description": "Fresh produce daily",
      "image_url": "https://res.cloudinary.com/...",
      "parent_id": null,
      "sort_order": 1,
      "is_active": true,
      "created_at": "2026-01-15T..."
    },
    {
      "id": "d2e3f4a5-...",
      "name": "Dairy & Eggs",
      "slug": "dairy-eggs",
      "description": null,
      "image_url": null,
      "parent_id": null,
      "sort_order": 2,
      "is_active": true,
      "created_at": "2026-01-15T..."
    }
  ]
}
```

---

### 🔓 `GET /api/v1/categories/:id` — Get Single Category

**Request:**
```bash
curl http://localhost:3000/api/v1/categories/c1d2e3f4-...
```

**✅ 200 — Category found**
```json
{
  "success": true,
  "message": "Category fetched",
  "data": {
    "id": "c1d2e3f4-...",
    "name": "Fruits & Vegetables",
    "slug": "fruits-vegetables",
    "description": "Fresh produce daily",
    "image_url": "https://...",
    "parent_id": null,
    "sort_order": 1,
    "is_active": true,
    "created_at": "..."
  }
}
```

**❌ 404 — Not found**
```json
{
  "success": false,
  "message": "Category not found",
  "code": "NOT_FOUND"
}
```

---

### 🔓 `GET /api/v1/categories/:id/products` — Products in Category

**Request:**
```bash
curl "http://localhost:3000/api/v1/categories/c1d2e3f4-.../products?page=1&limit=10&sort=price_asc&inStock=true"
```

| Query Param | Type | Default | Options |
|-------------|------|---------|---------|
| `page` | integer | `1` | ≥ 1 |
| `limit` | integer | `20` | 1–50 |
| `sort` | string | `newest` | `price_asc`, `price_desc`, `newest`, `popular` |
| `inStock` | boolean | — | `true` to show only in-stock |

**✅ 200 — Products fetched with pagination**
```json
{
  "success": true,
  "message": "Products fetched",
  "data": [
    {
      "id": "p1a2b3c4-...",
      "name": "Fresh Apples (1 kg)",
      "slug": "fresh-apples-1-kg",
      "price": 180,
      "sale_price": 149,
      "stock_quantity": 50,
      "unit": "kg",
      "thumbnail_url": "https://...",
      "is_featured": true,
      "total_sold": 234
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25,
    "totalPages": 3
  }
}
```

---

### 🛡️ `POST /api/v1/categories/` — Create Category (Admin)

**Request:**
```bash
curl -X POST http://localhost:3000/api/v1/categories/ \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Bakery & Snacks",
    "description": "Freshly baked goods and snacks",
    "sort_order": 5
  }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | string | ✅ | 2–100 characters |
| `description` | string | ❌ | max 500 characters |
| `image_url` | string | ❌ | URL |
| `parent_id` | string | ❌ | UUID of parent category |
| `sort_order` | integer | ❌ | default `0` |

**✅ 201 — Category created (slug auto-generated)**
```json
{
  "success": true,
  "message": "Category created",
  "data": {
    "id": "e3f4a5b6-...",
    "name": "Bakery & Snacks",
    "slug": "bakery-snacks",
    "description": "Freshly baked goods and snacks",
    "image_url": null,
    "parent_id": null,
    "sort_order": 5,
    "is_active": true,
    "created_at": "2026-02-20T..."
  }
}
```

**❌ 400 — Duplicate name**
```json
{
  "success": false,
  "message": "A category with this name already exists",
  "code": "DUPLICATE"
}
```

**❌ 403 — Not admin**
```json
{
  "success": false,
  "message": "Forbidden — insufficient permissions",
  "code": "FORBIDDEN"
}
```

---

### 🛡️ `PUT /api/v1/categories/:id` — Update Category (Admin)

**Request:**
```bash
curl -X PUT http://localhost:3000/api/v1/categories/e3f4a5b6-... \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Bakery", "sort_order": 3 }'
```

All fields from create are optional here.

**✅ 200 — Updated**
```json
{
  "success": true,
  "message": "Category updated",
  "data": { "id": "...", "name": "Bakery", "slug": "bakery", ... }
}
```

**❌ 404** — Category not found  
**❌ 400** — Duplicate name

---

### 🛡️ `DELETE /api/v1/categories/:id` — Delete Category (Admin)

Soft-delete — sets `is_active = false`.

```bash
curl -X DELETE http://localhost:3000/api/v1/categories/e3f4a5b6-... \
  -H "Authorization: Bearer <adminToken>"
```

**✅ 200 — Deleted (soft)**
```json
{
  "success": true,
  "message": "Category deleted",
  "data": null
}
```

**❌ 404 — Not found**
```json
{
  "success": false,
  "message": "Category not found",
  "code": "NOT_FOUND"
}
```

---

## 5. PRODUCTS MODULE — `/api/v1/products`

### 🔓 `GET /api/v1/products/` — List Products (Filtered & Paginated)

**Request:**
```bash
curl "http://localhost:3000/api/v1/products/?page=1&limit=10&category=UUID&sort=price_asc&inStock=true&minPrice=50&maxPrice=500"
```

| Query Param | Type | Default | Options |
|-------------|------|---------|---------|
| `page` | integer | `1` | ≥ 1 |
| `limit` | integer | `20` | 1–50 |
| `category` | UUID | — | Filter by category |
| `search` | string | — | Keyword search (max 100) |
| `sort` | string | `newest` | `price_asc`, `price_desc`, `newest`, `popular` |
| `minPrice` | number | — | ≥ 0 |
| `maxPrice` | number | — | ≥ 0 |
| `inStock` | boolean | — | `true` = only in-stock |

**✅ 200 — Products fetched (cached 10 min by filter combination)**
```json
{
  "success": true,
  "message": "Products fetched",
  "data": [
    {
      "id": "p1a2b3c4-...",
      "name": "Organic Bananas (1 dozen)",
      "slug": "organic-bananas-1-dozen",
      "price": 60,
      "sale_price": null,
      "stock_quantity": 100,
      "unit": "piece",
      "thumbnail_url": "https://...",
      "category_name": "Fruits & Vegetables",
      "is_featured": false,
      "total_sold": 89
    }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 42, "totalPages": 5 }
}
```

---

### 🔓 `GET /api/v1/products/search` — Full-Text Search

**Request:**
```bash
curl "http://localhost:3000/api/v1/products/search?q=organic+milk&page=1&limit=10"
```

| Query Param | Type | Required | Validation |
|-------------|------|----------|------------|
| `q` | string | ✅ | 2–100 characters |
| `page` | integer | ❌ | default 1 |
| `limit` | integer | ❌ | 1–50, default 20 |

**✅ 200 — Uses PostgreSQL ts_rank for relevance scoring**
```json
{
  "success": true,
  "message": "Search results",
  "data": [ { "id": "...", "name": "Organic Milk (500ml)", ... } ],
  "pagination": { "page": 1, "limit": 10, "total": 3, "totalPages": 1 }
}
```

**✅ 200 — No results**
```json
{
  "success": true,
  "message": "Search results",
  "data": [],
  "pagination": { "page": 1, "limit": 10, "total": 0, "totalPages": 0 }
}
```

---

### 🔓 `GET /api/v1/products/featured` — Featured Products

```bash
curl http://localhost:3000/api/v1/products/featured
```

**✅ 200 — Cached 30 min**
```json
{
  "success": true,
  "message": "Featured products",
  "data": [ { "id": "...", "name": "...", "is_featured": true, ... } ]
}
```

---

### 🔓 `GET /api/v1/products/:id` — Single Product Detail

```bash
curl http://localhost:3000/api/v1/products/p1a2b3c4-...
```

**✅ 200 — Cached 15 min**
```json
{
  "success": true,
  "message": "Product fetched",
  "data": {
    "id": "p1a2b3c4-...",
    "name": "Fresh Apples (1 kg)",
    "slug": "fresh-apples-1-kg",
    "description": "Crisp and sweet Fuji apples from Himachal",
    "price": 180,
    "sale_price": 149,
    "cost_price": 100,
    "category_id": "c1d2e3f4-...",
    "stock_quantity": 50,
    "unit": "kg",
    "thumbnail_url": "https://...",
    "images": ["https://...", "https://..."],
    "tags": ["fruits", "organic", "seasonal"],
    "is_active": true,
    "is_featured": true,
    "total_sold": 234,
    "created_at": "...",
    "updated_at": "..."
  }
}
```

**❌ 404**
```json
{ "success": false, "message": "Product not found", "code": "NOT_FOUND" }
```

---

### 🔓 `GET /api/v1/products/:id/related` — Related Products

```bash
curl http://localhost:3000/api/v1/products/p1a2b3c4-.../related
```

**✅ 200 — Products from same category**
```json
{
  "success": true,
  "message": "Related products",
  "data": [ { "id": "...", "name": "Green Apples (1 kg)", ... } ]
}
```

---

### 🛡️ `POST /api/v1/products/` — Create Product (Admin)

**Request:**
```bash
curl -X POST http://localhost:3000/api/v1/products/ \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Toned Milk (500ml)",
    "price": 28,
    "categoryId": "c1d2e3f4-...",
    "description": "Pasteurized toned milk",
    "stock": 200,
    "unit": "ml",
    "isFeatured": true,
    "tags": ["dairy", "milk"]
  }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | string | ✅ | 2–200 characters |
| `price` | number | ✅ | ≥ 0 |
| `categoryId` | UUID | ✅ | Valid category |
| `description` | string | ❌ | max 2000 |
| `salePrice` | number | ❌ | ≥ 0 |
| `costPrice` | number | ❌ | ≥ 0 |
| `stock` | integer | ❌ | ≥ 0, default 0 |
| `unit` | string | ❌ | `kg`, `g`, `l`, `ml`, `piece`, `pack` |
| `thumbnailUrl` | string | ❌ | URL |
| `images` | string[] | ❌ | Array of URLs |
| `tags` | string[] | ❌ | Array of tags |
| `isFeatured` | boolean | ❌ | default `false` |

**✅ 201 — Product created**
```json
{
  "success": true,
  "message": "Product created",
  "data": { "id": "...", "name": "Toned Milk (500ml)", "slug": "toned-milk-500ml", ... }
}
```

---

### 🛡️ `PUT /api/v1/products/:id` — Update Product (Admin)

```bash
curl -X PUT http://localhost:3000/api/v1/products/p1a2b3c4-... \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{ "price": 159, "salePrice": 129 }'
```

All create fields + `isActive` (boolean) are optional.

**✅ 200** — Product updated  
**❌ 404** — Product not found

---

### 🛡️ `PUT /api/v1/products/:id/stock` — Update Stock Only (Admin)

```bash
curl -X PUT http://localhost:3000/api/v1/products/p1a2b3c4-.../stock \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{ "stock": 500 }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `stock` | integer | ✅ | ≥ 0 |

**✅ 200** — Stock updated  
**❌ 404** — Product not found

---

### 🛡️ `DELETE /api/v1/products/:id` — Delete Product (Admin)

Soft-delete — sets `is_active = false`.

```bash
curl -X DELETE http://localhost:3000/api/v1/products/p1a2b3c4-... \
  -H "Authorization: Bearer <adminToken>"
```

**✅ 200** — `{ "success": true, "message": "Product deleted", "data": null }`  
**❌ 404** — Product not found

---

## 6. UPLOADS MODULE — `/api/v1/uploads`

### 🔐 `POST /api/v1/uploads/image` — Upload Single Image

```bash
curl -X POST http://localhost:3000/api/v1/uploads/image \
  -H "Authorization: Bearer <accessToken>" \
  -F "file=@/path/to/product.jpg"
```

**✅ 200 — Image uploaded to Cloudinary**
```json
{
  "success": true,
  "message": "Image uploaded",
  "data": {
    "url": "https://res.cloudinary.com/dxxxxxx/image/upload/v1708/grocery-app-dev/products/abc123.webp",
    "publicId": "grocery-app-dev/products/abc123",
    "width": 800,
    "height": 600,
    "format": "webp",
    "bytes": 45000
  }
}
```

**❌ 400 — No file**
```json
{ "success": false, "message": "No file uploaded", "code": "NO_FILE" }
```

**❌ 400 — Wrong format (e.g., PDF)**
```json
{ "success": false, "message": "Invalid file type. Allowed: JPEG, PNG, WebP", "code": "INVALID_FILE_TYPE" }
```

---

### 🛡️ `POST /api/v1/uploads/images` — Upload Multiple Images (Admin)

```bash
curl -X POST http://localhost:3000/api/v1/uploads/images \
  -H "Authorization: Bearer <adminToken>" \
  -F "files=@/path/to/img1.jpg" \
  -F "files=@/path/to/img2.png"
```

**✅ 200 — Multiple images uploaded**
```json
{
  "success": true,
  "message": "2 image(s) uploaded",
  "data": [
    { "url": "https://...", "publicId": "...", "width": 800, "height": 600, "format": "webp", "bytes": 45000 },
    { "url": "https://...", "publicId": "...", "width": 1024, "height": 768, "format": "webp", "bytes": 52000 }
  ]
}
```

---

### 🛡️ `DELETE /api/v1/uploads/image` — Delete Image (Admin)

```bash
curl -X DELETE http://localhost:3000/api/v1/uploads/image \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{ "publicId": "grocery-app-dev/products/abc123" }'
```

**✅ 200** — `{ "success": true, "message": "Image deleted", "data": null }`

**❌ 400** — `"publicId is required"` (code: `MISSING_FIELD`)  
**❌ 400** — `"Image not found or already deleted"` (code: `DELETE_FAILED`)

---

## 7. CART MODULE — `/api/v1/cart`

> All cart routes require 🔐 AUTH (applied at hook level).  
> Cart is stored in **Redis** (not DB) with key `cart:{userId}` and 7-day TTL.

### 🔐 `GET /api/v1/cart/` — Get My Cart

```bash
curl http://localhost:3000/api/v1/cart/ \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — Cart with enriched product data**
```json
{
  "success": true,
  "message": "Cart fetched",
  "data": {
    "items": [
      {
        "productId": "p1a2b3c4-...",
        "name": "Fresh Apples (1 kg)",
        "price": 180,
        "salePrice": 149,
        "quantity": 2,
        "unit": "kg",
        "thumbnailUrl": "https://...",
        "lineTotal": 298,
        "inStock": true
      }
    ],
    "subtotal": 298,
    "count": 2
  }
}
```

**✅ 200 — Empty cart**
```json
{
  "success": true,
  "message": "Cart fetched",
  "data": { "items": [], "subtotal": 0, "count": 0 }
}
```

---

### 🔐 `POST /api/v1/cart/items` — Add Item to Cart

```bash
curl -X POST http://localhost:3000/api/v1/cart/items \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{ "productId": "p1a2b3c4-...", "quantity": 2 }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `productId` | UUID | ✅ | Must exist & be active |
| `quantity` | integer | ✅ | 1–50 |

**✅ 200 — Item added (increments if already in cart)**
```json
{
  "success": true,
  "message": "Item added to cart",
  "data": { "items": [...], "subtotal": 298, "count": 2 }
}
```

**❌ 400 — Product unavailable**
```json
{ "success": false, "message": "Product not found or unavailable", "code": "CART_ERROR" }
```

**❌ 400 — Insufficient stock**
```json
{ "success": false, "message": "Only 5 units available for \"Fresh Apples (1 kg)\"", "code": "CART_ERROR" }
```

---

### 🔐 `PUT /api/v1/cart/items/:productId` — Update Item Quantity

Sets the **absolute** quantity (not a delta).

```bash
curl -X PUT http://localhost:3000/api/v1/cart/items/p1a2b3c4-... \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{ "quantity": 5 }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `quantity` | integer | ✅ | 1–50 |

**✅ 200** — Full cart response  
**❌ 400** — `"Item not in cart"` / `"Product is no longer available"` / `"Only N units available..."` (code: `CART_ERROR`)

---

### 🔐 `DELETE /api/v1/cart/items/:productId` — Remove Item

```bash
curl -X DELETE http://localhost:3000/api/v1/cart/items/p1a2b3c4-... \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200** — `{ "success": true, "message": "Item removed from cart", "data": { ...cart } }`  
**❌ 400** — `"Item not in cart"` (code: `CART_ERROR`)

---

### 🔐 `DELETE /api/v1/cart/` — Clear Entire Cart

```bash
curl -X DELETE http://localhost:3000/api/v1/cart/ \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200** — `{ "success": true, "message": "Cart cleared", "data": null }`

---

### 🔐 `POST /api/v1/cart/validate` — Validate Cart Before Checkout

Checks every item for stock availability and price accuracy.

```bash
curl -X POST http://localhost:3000/api/v1/cart/validate \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — Cart is valid (no issues)**
```json
{
  "success": true,
  "message": "Cart validated",
  "data": {
    "valid": true,
    "items": [
      {
        "productId": "p1a2b3c4-...",
        "name": "Fresh Apples (1 kg)",
        "price": 180,
        "salePrice": 149,
        "quantity": 2,
        "unit": "kg",
        "thumbnailUrl": "https://...",
        "lineTotal": 298,
        "inStock": true
      }
    ],
    "subtotal": 298,
    "warnings": []
  }
}
```

**✅ 200 — Cart has issues (valid=false, with warnings)**
```json
{
  "success": true,
  "message": "Cart validated",
  "data": {
    "valid": false,
    "items": [ ... ],
    "subtotal": 149,
    "warnings": [
      "\"Organic Bananas\" quantity adjusted from 10 to 3",
      "\"Expired Product\" is no longer available — removed"
    ]
  }
}
```

> ⚠️ Cart is **auto-updated in Redis** after validation — unavailable items are removed and quantities adjusted.

---

## 8. ADDRESSES MODULE — `/api/v1/addresses`

> All routes require 🔐 AUTH (applied at hook level).  
> **Max 10 addresses per user.**

### 🔐 `GET /api/v1/addresses/` — List My Addresses

```bash
curl http://localhost:3000/api/v1/addresses/ \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — Ordered: default first, then by newest**
```json
{
  "success": true,
  "message": "Addresses fetched",
  "data": [
    {
      "id": "addr-uuid-1",
      "label": "Home",
      "addressLine1": "42 MG Road, Sector 14",
      "addressLine2": "Near City Mall",
      "landmark": "Opposite HDFC Bank",
      "city": "Delhi",
      "state": "Delhi",
      "pincode": "110001",
      "lat": 28.6139,
      "lng": 77.2090,
      "isDefault": true,
      "createdAt": "2026-02-01T..."
    },
    {
      "id": "addr-uuid-2",
      "label": "Office",
      "addressLine1": "Tech Park, Block B",
      "addressLine2": null,
      "landmark": null,
      "city": "Bangalore",
      "state": "Karnataka",
      "pincode": "560001",
      "lat": null,
      "lng": null,
      "isDefault": false,
      "createdAt": "2026-02-10T..."
    }
  ]
}
```

---

### 🔐 `POST /api/v1/addresses/` — Add New Address

```bash
curl -X POST http://localhost:3000/api/v1/addresses/ \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "Home",
    "addressLine1": "42 MG Road, Sector 14",
    "addressLine2": "Near City Mall",
    "landmark": "Opposite HDFC Bank",
    "city": "Delhi",
    "state": "Delhi",
    "pincode": "110001",
    "lat": 28.6139,
    "lng": 77.2090,
    "isDefault": true
  }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `addressLine1` | string | ✅ | 3–255 characters |
| `city` | string | ✅ | 2–100 characters |
| `pincode` | string | ✅ | Indian 6-digit: `^[1-9][0-9]{5}$` |
| `label` | string | ❌ | max 50, default `"Home"` |
| `addressLine2` | string | ❌ | max 255 |
| `landmark` | string | ❌ | max 255 |
| `state` | string | ❌ | max 100 |
| `lat` | number | ❌ | -90 to 90 |
| `lng` | number | ❌ | -180 to 180 |
| `isDefault` | boolean | ❌ | default `false` |

**✅ 201 — Address created (first address auto-set as default)**
```json
{
  "success": true,
  "message": "Address created",
  "data": {
    "id": "addr-uuid-1",
    "label": "Home",
    "addressLine1": "42 MG Road, Sector 14",
    "city": "Delhi",
    "pincode": "110001",
    "isDefault": true,
    ...
  }
}
```

**❌ 400 — Max limit reached**
```json
{ "success": false, "message": "Maximum 10 addresses allowed", "code": "ADDRESS_ERROR" }
```

**❌ 400 — Invalid pincode format**
```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "body/pincode must match pattern \"^[1-9][0-9]{5}$\""
}
```

---

### 🔐 `PUT /api/v1/addresses/:id` — Update Address

```bash
curl -X PUT http://localhost:3000/api/v1/addresses/addr-uuid-1 \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{ "label": "Work", "city": "Mumbai" }'
```

**✅ 200** — Updated address  
**❌ 404** — `"Address not found"` (user can only see own addresses)

---

### 🔐 `DELETE /api/v1/addresses/:id` — Delete Address

```bash
curl -X DELETE http://localhost:3000/api/v1/addresses/addr-uuid-1 \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200** — `{ "success": true, "message": "Address deleted", "data": null }`

> 💡 If you delete the **default** address, the newest remaining address is automatically promoted to default.

**❌ 404** — `"Address not found"`

---

### 🔐 `PUT /api/v1/addresses/:id/default` — Set as Default

```bash
curl -X PUT http://localhost:3000/api/v1/addresses/addr-uuid-2/default \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — Default updated (old default unset)**
```json
{
  "success": true,
  "message": "Default address updated",
  "data": { "id": "addr-uuid-2", "isDefault": true, ... }
}
```

---

### 🔐 `POST /api/v1/addresses/validate-pincode` — Check Delivery Availability

```bash
curl -X POST http://localhost:3000/api/v1/addresses/validate-pincode \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{ "pincode": "110001" }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `pincode` | string | ✅ | `^[1-9][0-9]{5}$` |

**✅ 200 — Serviceable area**
```json
{
  "success": true,
  "message": "Delivery available",
  "data": { "available": true, "deliveryFee": 29, "estimatedMin": 30 }
}
```

**✅ 200 — Non-serviceable area**
```json
{
  "success": true,
  "message": "Delivery not available in this area",
  "data": { "available": false, "deliveryFee": 0, "estimatedMin": 0 }
}
```

**Serviceable pincodes:**

| City | Pincodes |
|------|----------|
| Delhi | 110001 – 110005 |
| Mumbai | 400001 – 400005 |
| Bangalore | 560001 – 560005 |
| Chennai | 600001 – 600005 |
| Kolkata | 700001 – 700005 |
| Hyderabad | 500001 – 500005 |
| Pune | 411001 – 411005 |

---

## 9. COUPONS MODULE — `/api/v1/coupons`

### 🔐 `POST /api/v1/coupons/validate` — Validate Coupon Code

```bash
curl -X POST http://localhost:3000/api/v1/coupons/validate \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{ "code": "SAVE20", "cartTotal": 500 }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `code` | string | ✅ | 1–50 characters |
| `cartTotal` | number | ✅ | > 0 |

**✅ 200 — Coupon valid (percentage type)**
```json
{
  "success": true,
  "message": "Coupon is valid",
  "data": {
    "valid": true,
    "discount": 100,
    "discountType": "PERCENTAGE",
    "discountValue": 20,
    "code": "SAVE20",
    "couponId": "coup-uuid-1"
  }
}
```

**✅ 200 — Coupon valid (flat type)**
```json
{
  "success": true,
  "message": "Coupon is valid",
  "data": {
    "valid": true,
    "discount": 50,
    "discountType": "FLAT",
    "discountValue": 50,
    "code": "FLAT50",
    "couponId": "coup-uuid-2"
  }
}
```

**❌ 400 — All possible validation failures:**

| Scenario | Message |
|----------|---------|
| Code doesn't exist | `"Coupon not found"` |
| Deactivated by admin | `"Coupon is no longer active"` |
| Start date in future | `"Coupon is not yet active"` |
| End date passed | `"Coupon has expired"` |
| Global limit hit | `"Coupon usage limit reached"` |
| User already used it | `"You have already used this coupon"` |
| Cart too small | `"Minimum order amount is ₹300"` |

All return code: `INVALID_COUPON`

**Discount Calculation:**
- **PERCENTAGE:** `cartTotal × discountValue / 100`, capped at `maxDiscount`
- **FLAT:** Fixed `discountValue`
- Discount never exceeds `cartTotal`

---

### 🔐 `GET /api/v1/coupons/available` — List Available Coupons

```bash
curl http://localhost:3000/api/v1/coupons/available \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — Filters out coupons user has maxed**
```json
{
  "success": true,
  "message": "Available coupons",
  "data": [
    {
      "id": "coup-uuid-1",
      "code": "SAVE20",
      "description": "Get 20% off on orders above ₹300",
      "discountType": "PERCENTAGE",
      "discountValue": 20,
      "minOrderAmount": 300,
      "maxDiscount": 150,
      "usageLimit": 1000,
      "usedCount": 42,
      "perUserLimit": 2,
      "validFrom": "2026-01-01T...",
      "validUntil": "2026-12-31T...",
      "isActive": true,
      "createdAt": "..."
    }
  ]
}
```

---

### 🛡️ `GET /api/v1/coupons/` — List All Coupons (Admin)

```bash
curl "http://localhost:3000/api/v1/coupons/?page=1&limit=20" \
  -H "Authorization: Bearer <adminToken>"
```

**✅ 200** — All coupons with pagination (includes inactive)

---

### 🛡️ `POST /api/v1/coupons/` — Create Coupon (Admin)

```bash
curl -X POST http://localhost:3000/api/v1/coupons/ \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "WELCOME50",
    "description": "₹50 off for new users",
    "discountType": "FLAT",
    "discountValue": 50,
    "minOrderAmount": 200,
    "usageLimit": 500,
    "perUserLimit": 1,
    "validFrom": "2026-02-01T00:00:00Z",
    "validUntil": "2026-03-31T23:59:59Z"
  }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `code` | string | ✅ | 2–50 characters (stored UPPERCASE) |
| `discountType` | string | ✅ | `PERCENTAGE` or `FLAT` |
| `discountValue` | number | ✅ | ≥ 0.01 |
| `description` | string | ❌ | max 500 |
| `minOrderAmount` | number | ❌ | default 0 |
| `maxDiscount` | number | ❌ | ≥ 0 (for PERCENTAGE caps) |
| `usageLimit` | integer | ❌ | ≥ 1 |
| `perUserLimit` | integer | ❌ | ≥ 1, default 1 |
| `validFrom` | datetime | ❌ | ISO 8601 |
| `validUntil` | datetime | ❌ | ISO 8601 |

**✅ 201** — Coupon created  
**❌ 400** — `"Coupon code already exists"` (code: `DUPLICATE`)

---

### 🛡️ `PUT /api/v1/coupons/:id` — Update Coupon (Admin)

```bash
curl -X PUT http://localhost:3000/api/v1/coupons/coup-uuid-1 \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{ "discountValue": 25, "maxDiscount": 200, "isActive": false }'
```

**✅ 200** — Updated  
**❌ 404** — `"Coupon not found"`  
**❌ 400** — `"Coupon code already exists"` (if changing to duplicate code)

---

### 🛡️ `DELETE /api/v1/coupons/:id` — Delete Coupon (Admin)

```bash
curl -X DELETE http://localhost:3000/api/v1/coupons/coup-uuid-1 \
  -H "Authorization: Bearer <adminToken>"
```

**✅ 200** — `{ "success": true, "message": "Coupon deleted", "data": null }`  
**❌ 404** — `"Coupon not found"`

---

## 10. ORDERS MODULE — `/api/v1/orders`

### 🔐 `POST /api/v1/orders/` — Place New Order

**This is the most critical endpoint.** It validates cart, checks address, applies coupon, calculates fees, creates order, decrements stock, and clears cart — all atomically.

```bash
curl -X POST http://localhost:3000/api/v1/orders/ \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "addressId": "addr-uuid-1",
    "paymentMethod": "COD",
    "couponCode": "SAVE20",
    "deliveryNotes": "Please ring the doorbell twice"
  }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `addressId` | UUID | ✅ | Must be user's own address |
| `paymentMethod` | string | ✅ | `COD`, `ONLINE`, or `WALLET` |
| `couponCode` | string | ❌ | 1–50 characters |
| `deliveryNotes` | string | ❌ | max 500 characters |

**Prerequisites:** Add items to cart first (`POST /api/v1/cart/items`).

**✅ 201 — Order placed successfully**
```json
{
  "success": true,
  "message": "Order placed successfully",
  "data": {
    "id": "ord-uuid-1",
    "orderNumber": "GRO-20260220-001",
    "userId": "user-uuid",
    "riderId": null,
    "status": "PENDING",
    "items": [
      {
        "productId": "p1a2b3c4-...",
        "name": "Fresh Apples (1 kg)",
        "price": 149,
        "quantity": 2,
        "unit": "kg",
        "total": 298
      }
    ],
    "subtotal": 298,
    "discountAmount": 59.6,
    "deliveryFee": 25,
    "platformFee": 5,
    "taxAmount": 0,
    "totalAmount": 268.4,
    "paymentMethod": "COD",
    "paymentStatus": "PENDING",
    "couponCode": "SAVE20",
    "deliveryAddress": {
      "id": "addr-uuid-1",
      "label": "Home",
      "addressLine1": "42 MG Road",
      "city": "Delhi",
      "pincode": "110001"
    },
    "deliveryNotes": "Please ring the doorbell twice",
    "estimatedDelivery": "2026-02-20T16:30:00.000Z",
    "deliveredAt": null,
    "createdAt": "2026-02-20T16:00:00.000Z"
  }
}
```

**Fee Calculation:**
| Component | Rule |
|-----------|------|
| Subtotal | Sum of all `salePrice × quantity` (or `price` if no sale) |
| Delivery Fee | ₹25 flat; **FREE if subtotal ≥ ₹499** |
| Platform Fee | ₹5 always |
| Tax | ₹0 (included in price for MVP) |
| Discount | Coupon calculation (see Coupons section) |
| **Total** | `subtotal - discount + deliveryFee + platformFee + tax` |

**❌ 400 — All possible errors (code: `ORDER_FAILED`):**

| Scenario | Message |
|----------|---------|
| Empty cart | `"Cart is empty or has issues"` |
| Cart has stock issues | Validation warnings joined by `;` |
| Invalid address | `"Delivery address not found"` |
| Invalid coupon | Any coupon validation message (see Coupons) |
| Stock runs out during transaction | `"Insufficient stock for product \"Apples\""` |
| DB transaction fails | `"Failed to place order"` |

**What happens behind the scenes:**
1. Cart validated (stock + prices checked)
2. Address ownership verified
3. Coupon validated (if provided)
4. Fees calculated
5. **Transaction:** Order created + stock decremented atomically
6. Cart cleared from Redis
7. Coupon usage recorded

---

### 🔐 `GET /api/v1/orders/` — My Order History

```bash
curl "http://localhost:3000/api/v1/orders/?page=1&limit=10&status=DELIVERED" \
  -H "Authorization: Bearer <accessToken>"
```

| Query | Type | Default | Options |
|-------|------|---------|---------|
| `page` | integer | `1` | ≥ 1 |
| `limit` | integer | `10` | 1–50 |
| `status` | string | — | Any order status |

**✅ 200 — Paginated order list**
```json
{
  "success": true,
  "message": "Orders fetched",
  "data": [ { ...order }, { ...order } ],
  "pagination": { "page": 1, "limit": 10, "total": 5, "totalPages": 1 }
}
```

---

### 🔐 `GET /api/v1/orders/active` — Get Active (In-Progress) Order

```bash
curl http://localhost:3000/api/v1/orders/active \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200** — Returns the latest order in PENDING/CONFIRMED/PREPARING/PACKED/OUT_FOR_DELIVERY  
**❌ 404** — `{ "success": false, "message": "No active order", "code": "NOT_FOUND" }`

---

### 🔐 `GET /api/v1/orders/:id` — Get Single Order

```bash
curl http://localhost:3000/api/v1/orders/ord-uuid-1 \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200** — Full order details  
**❌ 404** — `"Order not found"` (also if order belongs to different user)

---

### 🔐 `POST /api/v1/orders/:id/cancel` — Cancel Order

```bash
curl -X POST http://localhost:3000/api/v1/orders/ord-uuid-1/cancel \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "Changed my mind" }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `reason` | string | ❌ | max 500 characters |

**✅ 200 — Order cancelled + stock restored**
```json
{
  "success": true,
  "message": "Order cancelled",
  "data": { "id": "...", "status": "CANCELLED", "cancelledReason": "Changed my mind", ... }
}
```

**❌ 400 — Only PENDING or CONFIRMED can be cancelled**
```json
{ "success": false, "message": "Cannot cancel order in \"PREPARING\" status", "code": "CANCEL_FAILED" }
```

**❌ 400 — Not found**
```json
{ "success": false, "message": "Order not found", "code": "CANCEL_FAILED" }
```

---

### 🔐 `POST /api/v1/orders/:id/reorder` — Re-order Past Items

Adds all items from a past order back to your cart.

```bash
curl -X POST http://localhost:3000/api/v1/orders/ord-uuid-1/reorder \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — All items added**
```json
{
  "success": true,
  "message": "Items added to cart",
  "data": { "items": [...], "subtotal": 298, "count": 2 }
}
```

**✅ 200 — Some items unavailable (partial success)**
```json
{
  "success": true,
  "message": "Items added to cart",
  "data": { "items": [...], "subtotal": 149, "count": 1 },
  "warnings": ["Product not found or unavailable", "Only 2 units available for \"Bananas\""]
}
```

---

### 🛡️ `GET /api/v1/orders/admin/all` — List All Orders (Admin)

```bash
curl "http://localhost:3000/api/v1/orders/admin/all?page=1&limit=20&status=PENDING&userId=user-uuid" \
  -H "Authorization: Bearer <adminToken>"
```

| Query | Type | Default |
|-------|------|---------|
| `page` | integer | `1` |
| `limit` | integer | `20` |
| `status` | string | — |
| `userId` | UUID | — |

**✅ 200** — All orders with pagination

---

### 🛡️ `PUT /api/v1/orders/admin/:id/status` — Update Order Status (Admin)

```bash
curl -X PUT http://localhost:3000/api/v1/orders/admin/ord-uuid-1/status \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{ "status": "CONFIRMED" }'
```

| Field | Type | Required | Valid Values |
|-------|------|----------|--------------|
| `status` | string | ✅ | `CONFIRMED`, `PREPARING`, `PACKED`, `OUT_FOR_DELIVERY`, `DELIVERED`, `CANCELLED` |

**✅ 200** — Status updated

**Special behaviors:**
| Status | Side Effect |
|--------|-------------|
| `DELIVERED` | Auto-sets `paymentStatus: PAID` + `deliveredAt: now` |
| `CANCELLED` | Restores all stock in a transaction |

**❌ 400** — `"Order not found"` (code: `UPDATE_FAILED`)

---

### 🛡️ `PUT /api/v1/orders/admin/:id/rider` — Assign Rider (Admin)

```bash
curl -X PUT http://localhost:3000/api/v1/orders/admin/ord-uuid-1/rider \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{ "riderId": "rider-uuid" }'
```

**✅ 200** — Rider assigned  
**❌ 400** — `"Order not found"` / `"Cannot assign rider to a completed/cancelled order"` (code: `ASSIGN_FAILED`)

---

## 11. PAYMENTS MODULE — `/api/v1/payments`

### 🔐 `POST /api/v1/payments/create-order` — Create Razorpay Payment

Use this after placing an order with `paymentMethod: "ONLINE"`.

```bash
curl -X POST http://localhost:3000/api/v1/payments/create-order \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{ "orderId": "ord-uuid-1" }'
```

**✅ 201 — Razorpay order created (use these in your frontend checkout)**
```json
{
  "success": true,
  "message": "Payment order created",
  "data": {
    "paymentId": "pay-db-uuid",
    "razorpayOrderId": "order_Pxxxxxxxxxxxxxx",
    "amount": 268.4,
    "currency": "INR",
    "keyId": "rzp_test_eVN0FscTOIsBqP"
  }
}
```

**❌ 400 — Possible errors (code: `PAYMENT_FAILED`):**

| Scenario | Message |
|----------|---------|
| Razorpay not configured | `"Online payments are not configured"` |
| Invalid/not-found order | `"Order not found"` |
| Not an online order | `"Order is not set for online payment"` |
| Already paid | `"Order is already paid"` |
| Payment already done | `"Payment already completed"` |

---

### 🔐 `POST /api/v1/payments/verify` — Verify Payment Signature

After Razorpay checkout on frontend, send the callback data here.

```bash
curl -X POST http://localhost:3000/api/v1/payments/verify \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "razorpayOrderId": "order_Pxxxxxxxxxxxxxx",
    "razorpayPaymentId": "pay_Pxxxxxxxxxxxxxx",
    "razorpaySignature": "a1b2c3d4e5f6..."
  }'
```

| Field | Type | Required |
|-------|------|----------|
| `razorpayOrderId` | string | ✅ |
| `razorpayPaymentId` | string | ✅ |
| `razorpaySignature` | string | ✅ |

**✅ 200 — Payment verified + order confirmed**
```json
{
  "success": true,
  "message": "Payment verified",
  "data": {
    "id": "pay-db-uuid",
    "orderId": "ord-uuid-1",
    "razorpayOrderId": "order_Pxxxxxxxxxxxxxx",
    "razorpayPaymentId": "pay_Pxxxxxxxxxxxxxx",
    "amount": 268.4,
    "currency": "INR",
    "status": "PAID",
    "method": null,
    "createdAt": "..."
  }
}
```

**❌ 400 — Verification failed (code: `VERIFY_FAILED`):**

| Scenario | Message |
|----------|---------|
| No matching payment | `"Payment record not found"` |
| Wrong user | `"Unauthorized"` |
| Bad HMAC signature | `"Payment verification failed"` |

> Signature is verified using `HMAC-SHA256(razorpayOrderId|razorpayPaymentId, keySecret)`

---

### 🔐 `GET /api/v1/payments/history` — My Payment History

```bash
curl "http://localhost:3000/api/v1/payments/history?page=1&limit=10" \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — Paginated payments**
```json
{
  "success": true,
  "message": "Payment history fetched",
  "data": [
    {
      "id": "pay-uuid",
      "orderId": "ord-uuid",
      "razorpayOrderId": "order_Pxxx",
      "razorpayPaymentId": "pay_Pxxx",
      "amount": 268.4,
      "currency": "INR",
      "status": "PAID",
      "method": "upi",
      "createdAt": "..."
    }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 3, "totalPages": 1 }
}
```

---

### 🛡️ `POST /api/v1/payments/:id/refund` — Initiate Refund (Admin)

```bash
curl -X POST http://localhost:3000/api/v1/payments/pay-uuid/refund \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{ "amount": 100, "reason": "Customer complaint" }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `amount` | number | ❌ | min 1; defaults to full amount |
| `reason` | string | ❌ | max 500 |

**✅ 200 — Refund initiated via Razorpay**
```json
{
  "success": true,
  "message": "Refund initiated",
  "data": {
    "id": "pay-uuid",
    "orderId": "ord-uuid",
    "amount": 268.4,
    "status": "REFUNDED",
    "refundId": "rfnd_Pxxx",
    "refundAmount": 100,
    "refundStatus": "PROCESSED",
    ...
  }
}
```

**❌ 400 — Possible errors (code: `REFUND_FAILED`):**

| Scenario | Message |
|----------|---------|
| Razorpay not set up | `"Online payments are not configured"` |
| Payment not found | `"Payment not found"` |
| Not paid yet | `"Only paid payments can be refunded"` |
| No Razorpay ID | `"No Razorpay payment ID — cannot refund"` |
| Amount too high | `"Refund amount exceeds payment amount"` |
| Razorpay API error | `"Refund failed: <error>"` |

---

## 12. WALLET MODULE — `/api/v1/wallet`

### 🔐 `GET /api/v1/wallet/` — Get Wallet Balance

Auto-creates wallet if user doesn't have one yet.

```bash
curl http://localhost:3000/api/v1/wallet/ \
  -H "Authorization: Bearer <accessToken>"
```

**✅ 200 — Wallet fetched (or created with ₹0)**
```json
{
  "success": true,
  "message": "Wallet fetched",
  "data": {
    "id": "wal-uuid",
    "userId": "user-uuid",
    "balance": 500.00,
    "createdAt": "2026-02-01T..."
  }
}
```

---

### 🔐 `GET /api/v1/wallet/transactions` — Transaction History

```bash
curl "http://localhost:3000/api/v1/wallet/transactions?page=1&limit=20&type=CREDIT" \
  -H "Authorization: Bearer <accessToken>"
```

| Query | Type | Default | Options |
|-------|------|---------|---------|
| `page` | integer | `1` | ≥ 1 |
| `limit` | integer | `20` | 1–50 |
| `type` | string | — | `CREDIT` or `DEBIT` |

**✅ 200 — Transaction history**
```json
{
  "success": true,
  "message": "Transactions fetched",
  "data": [
    {
      "id": "tx-uuid-1",
      "walletId": "wal-uuid",
      "type": "CREDIT",
      "amount": 500,
      "description": "Money added",
      "referenceId": null,
      "balanceAfter": 500,
      "createdAt": "2026-02-15T..."
    },
    {
      "id": "tx-uuid-2",
      "walletId": "wal-uuid",
      "type": "DEBIT",
      "amount": 268.4,
      "description": "Payment for order GRO-20260220-001",
      "referenceId": "ord-uuid-1",
      "balanceAfter": 231.6,
      "createdAt": "2026-02-20T..."
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 2, "totalPages": 1 }
}
```

---

### 🔐 `POST /api/v1/wallet/add-money` — Add Money to Wallet

```bash
curl -X POST http://localhost:3000/api/v1/wallet/add-money \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{ "amount": 500, "description": "Top up" }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `amount` | number | ✅ | ₹1 – ₹50,000 |
| `description` | string | ❌ | max 255 |
| `referenceId` | string | ❌ | max 100 |

**✅ 200 — Money added (row-locked for concurrency)**
```json
{
  "success": true,
  "message": "Money added",
  "data": {
    "wallet": { "id": "wal-uuid", "userId": "...", "balance": 500 },
    "transaction": { "id": "tx-uuid", "type": "CREDIT", "amount": 500, "balanceAfter": 500, ... }
  }
}
```

**❌ 400** — `"Failed to add money: ..."` (code: `WALLET_FAILED`)

---

### 🔐 `POST /api/v1/wallet/pay` — Pay for Order from Wallet

Use this after placing an order with `paymentMethod: "WALLET"`.

```bash
curl -X POST http://localhost:3000/api/v1/wallet/pay \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{ "orderId": "ord-uuid-1" }'
```

**✅ 200 — Payment deducted + order confirmed**
```json
{
  "success": true,
  "message": "Payment successful",
  "data": {
    "wallet": { "id": "wal-uuid", "balance": 231.6 },
    "transaction": {
      "id": "tx-uuid",
      "type": "DEBIT",
      "amount": 268.4,
      "description": "Payment for order GRO-20260220-001",
      "referenceId": "ord-uuid-1",
      "balanceAfter": 231.6
    }
  }
}
```

**❌ 400 — Possible errors (code: `WALLET_PAY_FAILED`):**

| Scenario | Message |
|----------|---------|
| Invalid order | `"Order not found"` |
| Not a wallet order | `"Order is not set for wallet payment"` |
| Already paid | `"Order is already paid"` |
| No wallet | `"Wallet not found"` |
| Low balance | `"Insufficient balance. Need ₹268.4, have ₹100"` |

---

### 🔐 `POST /api/v1/wallet/transfer` — Transfer to Another User

```bash
curl -X POST http://localhost:3000/api/v1/wallet/transfer \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "8765432109",
    "amount": 100,
    "description": "Lunch money"
  }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `phone` | string | ✅ | Indian mobile: `^[6-9]\d{9}$` |
| `amount` | number | ✅ | ₹1 – ₹10,000 |
| `description` | string | ❌ | max 255 |

**✅ 200 — Transfer successful (double-entry: debit sender + credit recipient)**
```json
{
  "success": true,
  "message": "Transfer successful",
  "data": {
    "wallet": { "id": "wal-uuid", "balance": 400 },
    "transaction": {
      "type": "DEBIT",
      "amount": 100,
      "description": "Transfer to Rahul",
      "referenceId": "transfer:recipient-uuid",
      "balanceAfter": 400
    }
  }
}
```

**❌ 400 — Possible errors (code: `TRANSFER_FAILED`):**

| Scenario | Message |
|----------|---------|
| Phone not found | `"Recipient not found"` |
| Self-transfer | `"Cannot transfer to yourself"` |
| No wallet | `"Wallet not found"` |
| Low balance | `"Insufficient balance"` |

---

### 🛡️ `POST /api/v1/wallet/admin/:userId/credit` — Admin Credit User Wallet

```bash
curl -X POST http://localhost:3000/api/v1/wallet/admin/user-uuid/credit \
  -H "Authorization: Bearer <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{ "amount": 200, "description": "Refund for cancelled order", "referenceId": "ord-uuid-old" }'
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `amount` | number | ✅ | ≥ 1 |
| `description` | string | ❌ | max 255, default `"Admin credit"` |
| `referenceId` | string | ❌ | max 100 |

**✅ 200** — Wallet credited  
**❌ 400** — `"..."` (code: `CREDIT_FAILED`)

---

## 13. RAZORPAY WEBHOOK

### 🔓 `POST /api/webhook/razorpay` — Webhook Handler

> **URL for Razorpay Dashboard:** `https://arjun-postexilian-meredith.ngrok-free.dev/api/webhook/razorpay`  
> **Auth:** None (verified via HMAC signature in `x-razorpay-signature` header)  
> **Rate Limit:** Disabled (Razorpay retries failed deliveries)

```bash
# Razorpay sends this automatically — you don't call it manually
curl -X POST http://localhost:3000/api/webhook/razorpay \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: <hmac-sha256-hex>" \
  -d '{
    "event": "payment.captured",
    "payload": {
      "payment": {
        "entity": {
          "id": "pay_Pxxxxxxxxxxxxxx",
          "order_id": "order_Pxxxxxxxxxxxxxx",
          "method": "upi",
          "amount": 26840
        }
      }
    }
  }'
```

**Handled events:**

| Event | Action |
|-------|--------|
| `payment.captured` | Marks payment PAID, order → CONFIRMED |
| `payment.failed` | Marks payment FAILED |
| `refund.processed` | Logs refund completion |

**✅ Always returns 200** (even on errors — Razorpay expects this):
```json
{ "status": "ok" }
```

or on signature mismatch:
```json
{ "status": "error" }
```

---

## 14. BUSINESS RULES QUICK REFERENCE

| Rule | Value |
|------|-------|
| OTP length | 6 digits |
| OTP expiry | 5 minutes |
| OTP max attempts | 5 (then 30-min lockout) |
| JWT access token | 15 minutes |
| JWT refresh token | 7 days (rotated on each refresh) |
| Max addresses per user | 10 |
| Max cart item quantity | 50 per product |
| Cart storage | Redis (`cart:{userId}`, 7-day TTL) |
| Free delivery threshold | Subtotal ≥ ₹499 |
| Delivery fee | ₹25 flat |
| Platform fee | ₹5 |
| Order cancellation | Only in `PENDING` or `CONFIRMED` status |
| Coupon types | `PERCENTAGE` (capped by maxDiscount) / `FLAT` |
| Coupon per-user limit | Default 1 |
| Wallet add max | ₹50,000 |
| Wallet transfer max | ₹10,000 |
| Image upload | JPEG/PNG/WebP, max 5MB |
| Rate limit (global) | 100 requests/minute/IP |
| Rate limit (OTP) | 5 requests/5 minutes/IP |
| Cache: Categories | 30 minutes |
| Cache: Product list | 10 minutes |
| Cache: Product detail | 15 minutes |
| Cache: Featured | 30 minutes |

---

## 15. ORDER STATUS FLOW DIAGRAM

```
                    ┌──────────────┐
                    │   PENDING    │ ← Order placed
                    └──────┬───────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
            ▼              ▼              │
     ┌──────────┐  ┌──────────────┐      │
     │CANCELLED │  │  CONFIRMED   │      │
     └──────────┘  └──────┬───────┘      │
                          │              │
                          ▼              │
                   ┌──────────────┐      │
                   │  PREPARING   │      │
                   └──────┬───────┘      │
                          │         ┌────┘
                          ▼         │
                   ┌──────────────┐ │
                   │    PACKED    │ │
                   └──────┬───────┘ │
                          │         │
                          ▼         │
                ┌─────────────────┐ │
                │OUT_FOR_DELIVERY │ │
                └────────┬────────┘ │
                         │          │
              ┌──────────┼──────────┘
              │          │
              ▼          ▼
       ┌───────────┐ ┌──────────┐
       │ CANCELLED  │ │DELIVERED │
       └───────────┘ └────┬─────┘
                          │
                          ▼
                   ┌──────────────┐
                   │   REFUNDED   │ (admin-initiated)
                   └──────────────┘
```

**Customer can cancel:** `PENDING` → `CANCELLED` or `CONFIRMED` → `CANCELLED`  
**Admin can cancel:** Any active status → `CANCELLED`  
**Delivery marks paid:** `DELIVERED` auto-sets `paymentStatus: PAID`

---

## 🧪 TESTING WORKFLOW (Recommended Order)

Follow this sequence to test the full customer journey:

```
1.  POST /api/v1/auth/send-otp          → Get OTP
2.  POST /api/v1/auth/verify-otp        → Get tokens
3.  PUT  /api/v1/users/me               → Set name/email
4.  GET  /api/v1/categories/            → Browse categories
5.  GET  /api/v1/products/              → Browse products
6.  POST /api/v1/addresses/             → Add delivery address
7.  POST /api/v1/cart/items             → Add items to cart
8.  POST /api/v1/cart/items             → Add more items
9.  GET  /api/v1/cart/                  → View cart
10. POST /api/v1/cart/validate          → Validate before checkout
11. POST /api/v1/coupons/validate       → Try a coupon
12. POST /api/v1/orders/               → Place order (COD)
13. GET  /api/v1/orders/active          → Check active order
14. POST /api/v1/orders/:id/cancel      → Cancel it
15. POST /api/v1/orders/:id/reorder     → Re-add to cart
16. POST /api/v1/orders/               → Place order (WALLET)
17. POST /api/v1/wallet/add-money       → Top up wallet
18. POST /api/v1/wallet/pay             → Pay from wallet
19. GET  /api/v1/wallet/transactions    → Check history
20. POST /api/v1/auth/logout            → Logout
```

---

*Generated: 20 February 2026 | Grocery Backend v1.0 — Weeks 1–4 Complete*
