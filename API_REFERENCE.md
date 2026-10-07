# 🛒 Bakaloo Grocery Backend — API Reference

> **Base URL:** `http://localhost:3000`  
> **Framework:** Fastify (Node.js)  
> **Auth:** JWT Bearer tokens (access + refresh)  
> **Real-time:** Socket.IO for order tracking & admin dashboard

---

## Table of Contents

- [Authentication](#1-authentication)
- [Users](#2-users)
- [Products](#3-products)
- [Categories](#4-categories)
- [Cart](#5-cart)
- [Orders](#6-orders)
- [Payments](#7-payments)
- [Wallet](#8-wallet)
- [Addresses](#9-addresses)
- [Coupons](#10-coupons)
- [Notifications](#11-notifications)
- [Wishlist](#12-wishlist)
- [Reviews](#13-reviews)
- [Banners](#14-banners)
- [Uploads](#15-uploads)
- [Delivery (Rider App)](#16-delivery-rider-app)
- [Admin — Auth](#17-admin--auth)
- [Admin — Dashboard](#18-admin--dashboard)
- [Admin — Orders](#19-admin--orders)
- [Admin — Products](#20-admin--products)
- [Admin — Customers](#21-admin--customers)
- [Admin — Riders](#22-admin--riders)
- [Admin — Notifications](#23-admin--notifications)
- [Admin — Analytics](#24-admin--analytics)
- [Admin — Banners](#25-admin--banners)
- [Admin — Team & Roles](#26-admin--team--roles)
- [Admin — Activity Log](#27-admin--activity-log)
- [Admin — Settings](#28-admin--settings)
- [Webhooks](#29-webhooks)
- [Health Check](#30-health-check)

---

## Auth Legend

| Symbol | Meaning |
|--------|---------|
| 🔓 | Public (no auth required) |
| 🔐 | Requires JWT Bearer token |
| 🛡️ | Requires ADMIN role |
| 🚴 | Requires RIDER/DELIVERY role |

---

## 1. Authentication

**Prefix:** `/api/v1/auth`

| Method | Endpoint | Auth | Description | Rate Limit |
|--------|----------|------|-------------|------------|
| `POST` | `/send-otp` | 🔓 | Send OTP to mobile number | 5 / 5min |
| `POST` | `/verify-otp` | 🔓 | Verify OTP → returns JWT access + refresh tokens | 10 / 5min |
| `POST` | `/refresh-token` | 🔓 | Get new access token using refresh token | — |
| `POST` | `/logout` | 🔐 | Invalidate refresh token | — |
| `DELETE` | `/account` | 🔐 | Delete user account permanently | — |

### Request/Response Examples

**POST `/send-otp`**
```json
// Request
{ "phone": "+919876543210" }
// Response
{ "success": true, "message": "OTP sent successfully" }
```

**POST `/verify-otp`**
```json
// Request
{ "phone": "+919876543210", "otp": "123456" }
// Response
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGci...",
    "refreshToken": "eyJhbGci...",
    "user": { "id": "uuid", "phone": "+919876543210", "role": "CUSTOMER" }
  }
}
```

---

## 2. Users

**Prefix:** `/api/v1/users`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/me` | 🔐 | Get current user profile |
| `PUT` | `/me` | 🔐 | Update profile (name, email, avatar) |
| `PUT` | `/me/avatar` | 🔐 | Upload profile photo |
| `GET` | `/me/stats` | 🔐 | Get order count, total spent, loyalty points |

---

## 3. Products

**Prefix:** `/api/v1/products`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/` | 🔓 | List products (filter, sort, paginate) |
| `GET` | `/search` | 🔓 | Full-text search products |
| `GET` | `/featured` | 🔓 | Featured/bestseller products |
| `GET` | `/new-arrivals` | 🔓 | Products from last 30 days |
| `GET` | `/deals` | 🔓 | Products with active sale prices |
| `GET` | `/:id` | 🔓 | Single product detail |
| `GET` | `/:id/related` | 🔓 | Related products |
| `POST` | `/` | 🛡️ | Create product |
| `PUT` | `/:id` | 🛡️ | Update product |
| `PUT` | `/:id/stock` | 🛡️ | Update stock quantity |
| `DELETE` | `/:id` | 🛡️ | Delete product |
| `POST` | `/bulk-import` | 🛡️ | CSV bulk import (multipart/form-data) |

### Query Parameters (GET `/`)

| Param | Type | Description |
|-------|------|-------------|
| `page` | int | Page number (default: 1) |
| `limit` | int | Items per page (default: 20) |
| `category` | string | Filter by category ID |
| `sort` | string | `price_asc`, `price_desc`, `newest`, `bestseller` |
| `inStock` | boolean | Filter in-stock only |
| `search` | string | Search term |

---

## 4. Categories

**Prefix:** `/api/v1/categories`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/` | 🔓 | All categories (cached 30 min) |
| `GET` | `/:id` | 🔓 | Single category |
| `GET` | `/:id/products` | 🔓 | Products by category (paginated) |
| `POST` | `/` | 🛡️ | Create category |
| `PUT` | `/:id` | 🛡️ | Update category |
| `DELETE` | `/:id` | 🛡️ | Delete category |

---

## 5. Cart

**Prefix:** `/api/v1/cart`  
**All routes require:** 🔐

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Get current cart with items & totals |
| `POST` | `/items` | Add item to cart |
| `PUT` | `/items/:productId` | Update item quantity |
| `DELETE` | `/items/:productId` | Remove item from cart |
| `DELETE` | `/` | Clear entire cart |
| `POST` | `/validate` | Validate cart before checkout (stock, prices) |

### Request Examples

**POST `/items`**
```json
{ "productId": "uuid", "quantity": 2 }
```

**PUT `/items/:productId`**
```json
{ "quantity": 5 }
```

---

## 6. Orders

**Prefix:** `/api/v1/orders`

### Customer Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/` | 🔐 | Place a new order |
| `GET` | `/` | 🔐 | List user's orders (paginated) |
| `GET` | `/active` | 🔐 | Get current active order |
| `GET` | `/:id` | 🔐 | Get order details |
| `POST` | `/:id/cancel` | 🔐 | Cancel an order |
| `POST` | `/:id/reorder` | 🔐 | Re-order items from a past order |
| `GET` | `/:id/invoice` | 🔐 | Download PDF invoice |

### Admin Endpoints (Legacy)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/admin/all` | 🛡️ | List all orders |
| `PUT` | `/admin/:id/status` | 🛡️ | Update order status |
| `PUT` | `/admin/:id/rider` | 🛡️ | Assign rider to order |

### Order Status Flow

```
PENDING → CONFIRMED → PREPARING → PACKED → OUT_FOR_DELIVERY → DELIVERED
                                                              ↘ CANCELLED
                                                              ↘ REFUNDED
```

### Place Order Request

```json
{
  "addressId": "uuid",
  "paymentMethod": "ONLINE|COD|WALLET",
  "couponCode": "SUMMER25",
  "deliveryNotes": "Ring the bell"
}
```

---

## 7. Payments

**Prefix:** `/api/v1/payments`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/create-order` | 🔐 | Create Razorpay payment order |
| `POST` | `/verify` | 🔐 | Verify Razorpay payment signature |
| `GET` | `/history` | 🔐 | Payment transaction history |
| `POST` | `/:id/refund` | 🛡️ | Initiate refund for a payment |

---

## 8. Wallet

**Prefix:** `/api/v1/wallet`

### Customer Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/` | 🔐 | Get wallet balance |
| `GET` | `/transactions` | 🔐 | Transaction history |
| `POST` | `/topup` | 🔐 | Create wallet top-up payment order |
| `POST` | `/topup/verify` | 🔐 | Verify wallet top-up payment |
| `POST` | `/pay` | 🔐 | Pay for an order from wallet |
| `POST` | `/transfer` | 🔐 | Transfer money to another user |

### Admin Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/admin/transactions` | 🛡️ | All wallet transactions (paginated, filterable) |
| `GET` | `/admin/stats` | 🛡️ | Wallet overview stats |
| `POST` | `/admin/:userId/credit` | 🛡️ | Credit a user's wallet |
| `POST` | `/add-money` | 🛡️ | Direct credit (internal) |

---

## 9. Addresses

**Prefix:** `/api/v1/addresses`  
**All routes require:** 🔐

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List all addresses |
| `POST` | `/` | Create address |
| `PUT` | `/:id` | Update address |
| `DELETE` | `/:id` | Delete address |
| `PUT` | `/:id/default` | Set as default address |
| `POST` | `/validate-pincode` | Check delivery availability by pincode |

### Create Address Request

```json
{
  "label": "Home",
  "addressLine1": "B-12 Sunrise Apartments",
  "addressLine2": "Near City Mall",
  "landmark": "Opposite park",
  "city": "Kolkata",
  "state": "West Bengal",
  "pincode": "700001",
  "lat": 22.5726,
  "lng": 88.3639
}
```

---

## 10. Coupons

**Prefix:** `/api/v1/coupons`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/validate` | 🔐 | Validate coupon for current cart |
| `GET` | `/available` | 🔐 | List available coupons for user |
| `GET` | `/` | 🛡️ | List all coupons (admin) |
| `POST` | `/` | 🛡️ | Create coupon |
| `PUT` | `/:id` | 🛡️ | Update coupon |
| `DELETE` | `/:id` | 🛡️ | Delete coupon |

### Coupon Types

| `discountType` | Description |
|----------------|-------------|
| `PERCENTAGE` | Percentage off (e.g., 30% off, max ₹200) |
| `FIXED` | Fixed amount off (e.g., ₹100 off) |

---

## 11. Notifications

**Prefix:** `/api/v1/notifications`  
**All routes require:** 🔐

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Get list of notifications |
| `PATCH` | `/:id/read` | Mark a notification as read |
| `PATCH` | `/read-all` | Mark all notifications as read |
| `DELETE` | `/:id` | Delete a notification |
| `GET` | `/preferences` | Get notification preferences |
| `PUT` | `/preferences` | Update notification preferences |
| `POST` | `/tokens` | Register FCM device token |

### Register Token Request

```json
{ "token": "fcm_device_token_string", "platform": "android" }
```

### Preferences

```json
{
  "orderUpdates": true,
  "promotions": true,
  "newProducts": true,
  "deliveryUpdates": true,
  "priceDrops": true
}
```

---

## 12. Wishlist

**Prefix:** `/api/v1/wishlist`  
**All routes require:** 🔐

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Get wishlist items |
| `POST` | `/items` | Add item to wishlist |
| `DELETE` | `/items/:productId` | Remove item from wishlist |
| `DELETE` | `/` | Clear entire wishlist |
| `POST` | `/move-to-cart` | Move wishlist item(s) to cart |

---

## 13. Reviews

**Prefix:** `/api/v1/reviews`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/products/:productId` | 🔓 | Get reviews for a product |
| `GET` | `/eligibility/:productId` | 🔐 | Check if user can review product |
| `POST` | `/` | 🔐 | Create review |
| `PATCH` | `/:id` | 🔐 | Update review |
| `DELETE` | `/:id` | 🔐 | Delete review |
| `GET` | `/my-reviews` | 🔐 | Get user's own reviews |

---

## 14. Banners

**Prefix:** `/api/v1/banners`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/` | 🔓 | Get active promotional banners |

---

## 15. Uploads

**Prefix:** `/api/v1/uploads`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/image` | 🔐 | Upload single image to Cloudinary |
| `POST` | `/images` | 🛡️ | Upload multiple images |
| `DELETE` | `/image` | 🛡️ | Delete image from Cloudinary |

---

## 16. Delivery (Rider App)

**Prefix:** `/api/v1/delivery`  
**All routes require:** 🔐 (Rider role)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/profile` | Get rider profile |
| `PATCH` | `/toggle-online` | Toggle online/offline status |
| `GET` | `/orders` | Get assigned orders |
| `PATCH` | `/orders/:id/accept` | Accept an order assignment |
| `PATCH` | `/orders/:id/pickup` | Mark order as picked up |
| `PATCH` | `/orders/:id/deliver` | Mark order as delivered |
| `GET` | `/stats` | Get rider delivery stats |
| `PATCH` | `/location` | Update current GPS location |
| `GET` | `/history` | Get delivery history |

### Rider Status Flow

```
ASSIGNED → ACCEPTED → PICKED_UP → DELIVERED
```

---

## 17. Admin — Auth

**Prefix:** `/api/v1/admin/auth`

| Method | Endpoint | Auth | Description | Rate Limit |
|--------|----------|------|-------------|------------|
| `POST` | `/login` | 🔓 | Admin email + password login | 5 / 15min |
| `PUT` | `/password` | 🛡️ | Set / change admin password | — |

### Admin Login Request

```json
{ "email": "admin@bakaloo.in", "password": "securePassword123" }
```

---

## 18. Admin — Dashboard

**Prefix:** `/api/v1/admin/dashboard`  
**All routes require:** 🛡️

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/stats` | Overview KPIs (revenue, orders, customers, AOV) |
| `GET` | `/revenue-chart` | Revenue chart data (daily/weekly/monthly) |
| `GET` | `/orders-by-hour` | Order volume by hour of day |
| `GET` | `/top-products` | Top-selling products |
| `GET` | `/low-stock-alerts` | Products running low on stock |
| `GET` | `/pending-actions` | Pending orders, reviews, rider assignments |
| `GET` | `/live-stats` | Real-time counters (via Socket.IO) |
| `GET` | `/category-revenue` | Revenue breakdown by category |

---

## 19. Admin — Orders

**Prefix:** `/api/v1/admin/orders`  
**All routes require:** 🛡️

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List all orders (filterable, paginated) |
| `GET` | `/stats-by-status` | Order counts grouped by status |
| `GET` | `/export` | Export orders as CSV |
| `POST` | `/manual` | Create manual order (admin) |
| `POST` | `/bulk-assign` | Bulk assign riders to orders |
| `POST` | `/bulk-status` | Bulk update order statuses |
| `GET` | `/:id` | Single order detail |
| `PUT` | `/:id/status` | Update order status |
| `PUT` | `/:id/assign-rider` | Assign rider to order |
| `GET` | `/:id/invoice` | Download invoice PDF |
| `GET` | `/:id/packing-slip` | Download packing slip |
| `POST` | `/:id/refund` | Initiate order refund |
| `POST` | `/:id/cancel` | Cancel order |

---

## 20. Admin — Products

**Prefix:** `/api/v1/admin/products`  
**All routes require:** 🛡️

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List all products (admin view with analytics) |
| `GET` | `/analytics` | Product performance analytics |
| `GET` | `/dead-stock` | Products with zero sales |
| `GET` | `/low-margin` | Low-margin products |
| `GET` | `/export` | Export products as CSV |
| `PUT` | `/bulk-update` | Bulk update products |
| `POST` | `/:id/duplicate` | Duplicate a product |
| `GET` | `/search-barcode/:code` | Search product by barcode |

---

## 21. Admin — Customers

**Prefix:** `/api/v1/admin/customers`  
**All routes require:** 🛡️

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List all customers (paginated, searchable) |
| `GET` | `/ltv` | Customer lifetime value analysis |
| `GET` | `/churned` | Churned customers (inactive > 30 days) |
| `GET` | `/vip` | VIP/high-value customers |
| `GET` | `/export` | Export customers CSV |
| `GET` | `/:id` | Single customer detail |
| `GET` | `/:id/orders` | Customer's order history |
| `GET` | `/:id/addresses` | Customer's addresses |
| `POST` | `/:id/credit-wallet` | Credit customer's wallet |
| `POST` | `/:id/notify` | Send notification to specific customer |
| `PUT` | `/:id/block` | Block/unblock customer |

---

## 22. Admin — Riders

**Prefix:** `/api/v1/admin/riders`  
**All routes require:** 🛡️

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List all riders (paginated) |
| `GET` | `/live-locations` | Real-time rider locations on map |
| `GET` | `/:id` | Rider detail |
| `GET` | `/:id/earnings` | Rider earnings report |
| `GET` | `/:id/payouts` | Rider payout history |
| `POST` | `/:id/payouts` | Create payout for rider |
| `PUT` | `/:id/suspend` | Suspend/unsuspend rider |
| `PUT` | `/:id/commission` | Update rider commission rate |
| `GET` | `/:id/documents` | Rider uploaded documents |
| `PUT` | `/:id/documents/:documentId/verify` | Verify rider document |

---

## 23. Admin — Notifications

**Prefix:** `/api/v1/admin/notifications`  
**All routes require:** 🛡️

### Templates

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/templates` | List all notification templates |
| `GET` | `/templates/:id` | Get single template |
| `POST` | `/templates` | Create template |
| `PUT` | `/templates/:id` | Update template |
| `DELETE` | `/templates/:id` | Delete template |

### Campaigns

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/send-bulk` | Send bulk push notification NOW |
| `POST` | `/schedule` | Schedule campaign for later |
| `GET` | `/campaigns` | List all campaigns |
| `GET` | `/campaigns/:id` | Campaign detail |
| `GET` | `/segment-count` | Get audience count for a segment |

### Send Bulk Request

```json
{
  "title": "🛒 Special Offer!",
  "body": "Get 30% off on all dairy products today!",
  "segment": "all",
  "image_url": "https://...",
  "deep_link": "app://products/dairy"
}
```

### Segments

| Value | Description |
|-------|-------------|
| `all` | All active customers |
| `new` | New customers |
| `inactive` | Customers with no orders in 30 days |
| `high_value` | High-value customers |

---

## 24. Admin — Analytics

**Prefix:** `/api/v1/admin/analytics`  
**All routes require:** 🛡️

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/sales` | Sales analytics (revenue, orders, AOV over time) |
| `GET` | `/product-performance` | Product-level performance metrics |
| `GET` | `/customer-cohorts` | Customer cohort analysis |
| `GET` | `/delivery` | Delivery performance analytics |
| `GET` | `/financial` | Full financial report |
| `GET` | `/comparison` | Period-over-period comparison |
| `GET` | `/export-pdf` | Export analytics report as PDF |

### Common Query Parameters

| Param | Type | Description |
|-------|------|-------------|
| `startDate` | string | Start date (ISO 8601) |
| `endDate` | string | End date (ISO 8601) |
| `granularity` | string | `daily`, `weekly`, `monthly` |

---

## 25. Admin — Banners

**Prefix:** `/api/v1/admin/banners`  
**All routes require:** 🛡️

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List all banners |
| `GET` | `/:id` | Get single banner |
| `POST` | `/` | Create banner |
| `PUT` | `/:id` | Update banner |
| `DELETE` | `/:id` | Delete banner |
| `PUT` | `/reorder` | Reorder banner display sequence |

---

## 26. Admin — Team & Roles

### Roles (`/api/v1/admin/roles`) 🛡️

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List all roles |
| `POST` | `/` | Create role |
| `PATCH` | `/:id` | Update role |
| `DELETE` | `/:id` | Delete role |

### Team (`/api/v1/admin/team`) 🛡️

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List team members |
| `POST` | `/invite` | Invite new team member |
| `PATCH` | `/:id` | Update team member |
| `DELETE` | `/:id` | Remove team member |

---

## 27. Admin — Activity Log

**Prefix:** `/api/v1/admin/activity-log`  
**All routes require:** 🛡️

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Get admin activity log (paginated, filterable) |

### Query Parameters

| Param | Type | Description |
|-------|------|-------------|
| `page` | int | Page number (default: 1) |
| `limit` | int | Max 100 (default: 50) |
| `adminId` | string | Filter by admin user ID |
| `action` | string | Filter by action type |
| `entityType` | string | Filter by entity type |

---

## 28. Admin — Settings

**Prefix:** `/api/v1/admin`  
**All routes require:** 🛡️

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/users` | List all users |
| `PATCH` | `/users/:id/role` | Update user role |
| `PUT` | `/users/:id/block` | Block/unblock user |
| `GET` | `/settings` | Get platform settings |
| `PUT` | `/settings` | Update platform settings |

---

## 29. Webhooks

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/webhook/razorpay` | Razorpay Signature | Razorpay payment webhook handler (no rate limit) |

---

## 30. Health Check

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | 🔓 | Health check (status, timestamp, uptime) |

**Response:**
```json
{ "status": "OK", "timestamp": "2026-03-06T08:00:00.000Z", "uptime": 3600 }
```

---

## Common Response Format

All API responses follow a consistent structure:

### Success Response
```json
{
  "success": true,
  "message": "Description of result",
  "data": { /* response payload */ }
}
```

### Error Response
```json
{
  "success": false,
  "message": "Error description",
  "code": "ERROR_CODE",
  "stack": "..." // Only in development
}
```

### Paginated Response
```json
{
  "success": true,
  "message": "Items fetched",
  "data": [ /* items */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid JWT token |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `BAD_REQUEST` | 400 | Invalid request data |
| `VALIDATION_ERROR` | 422 | Schema validation failed |
| `CONFLICT` | 409 | Duplicate resource |
| `INTERNAL_ERROR` | 500 | Server error |
| `RATE_LIMITED` | 429 | Too many requests |

---

## Socket.IO Events

**Namespace:** `/` (default)

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `join:order` | `{ orderId }` | Subscribe to order status updates |
| `leave:order` | `{ orderId }` | Unsubscribe from order updates |
| `join:admin` | — | Subscribe to admin real-time feed |
| `rider:location` | `{ lat, lng }` | Rider sends GPS coordinates |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `order:status` | `{ orderId, status, ... }` | Order status changed |
| `order:rider-location` | `{ lat, lng, riderId }` | Live rider location for order tracking |
| `admin:new-order` | `{ order }` | New order placed (admin dashboard) |
| `admin:stats-update` | `{ stats }` | Dashboard stats updated |

---

## Database Roles

| Role | Description |
|------|-------------|
| `CUSTOMER` | Regular app users |
| `ADMIN` | Dashboard administrators |
| `RIDER` | Delivery partners |

---

> **Total Endpoints: 135+**  
> **Generated:** March 6, 2026  
> **Version:** v1
