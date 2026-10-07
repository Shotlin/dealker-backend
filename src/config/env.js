import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config({ override: true })

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false
  }
  return value
}, z.boolean())

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4500),
  HOST: z.string().default('0.0.0.0'),
  API_VERSION: z.string().default('v1'),
  APP_NAME: z.string().default('Meet Commerce'),
  FRONTEND_URL: z.string().url().optional(),
  ADMIN_URL: z.string().url().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:4501,http://localhost:3001,http://localhost:3002'),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  COOKIE_SECRET: z.string().min(16).optional(),
  // AES-256-GCM key for src/utils/encryption.js — currently only used to
  // encrypt Razorpay key_secret/webhook_secret at rest (src/modules/
  // razorpay-settings, migration 132). Optional at boot so the app still
  // starts before an admin ever saves dashboard-managed credentials;
  // encryption.js throws a clear error if used while unset.
  SETTINGS_ENCRYPTION_KEY: z.string().min(32).optional(),

  // PostgreSQL
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string(),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_POOL_MIN: z.coerce.number().default(2),
  DB_POOL_MAX: z.coerce.number().default(10),
  DB_IDLE_TIMEOUT: z.coerce.number().default(30000),
  DB_CONNECTION_TIMEOUT: z.coerce.number().default(2000),
  DB_CONNECT_RETRIES: z.coerce.number().default(20),
  DB_CONNECT_RETRY_DELAY: z.coerce.number().default(1000),
  DB_SSL: booleanFromEnv.default(false),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().default(0),
  REDIS_TTL_DEFAULT: z.coerce.number().default(600),

  // OTP
  OTP_EXPIRY_SECONDS: z.coerce.number().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_LOCKOUT_SECONDS: z.coerce.number().default(1800),
  OTP_LENGTH: z.coerce.number().default(6),
  ALLOW_DEMO_OTP: booleanFromEnv.default(false),
  // Comma-separated list of 10-digit phones that bypass real SMS delivery
  // (used for App Store / Play Store reviewer demo accounts).
  DEMO_OTP_PHONES: z.string().optional(),
  DEMO_OTP_CODE: z.string().regex(/^\d{4,8}$/).default('123456'),
  ALLOW_ALL_PINCODES: booleanFromEnv.default(false),

  // Razorpay
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_CURRENCY: z.string().default('INR'),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_UPLOAD_PRESET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('meet-commerce'),

  // Rate Limiting
  RATE_LIMIT_ENABLED: booleanFromEnv.default(true),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW: z.coerce.number().default(60000),
  OTP_RATE_LIMIT_MAX: z.coerce.number().default(5),
  OTP_RATE_LIMIT_WINDOW: z.coerce.number().default(300000),

  // File Upload
  MAX_FILE_SIZE: z.coerce.number().default(5242880),
  ALLOWED_IMAGE_TYPES: z.string().default('image/jpeg,image/png,image/webp'),
  // Procurement quality-evidence videos (Cloudinary resource_type 'video')
  MAX_VIDEO_FILE_SIZE: z.coerce.number().default(104857600),
  ALLOWED_VIDEO_TYPES: z.string().default('video/mp4,video/quicktime,video/webm'),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: booleanFromEnv.default(false),
  ENABLE_SWAGGER: booleanFromEnv.optional(),

  // Boot-time guards
  // STRICT_PERMISSION_AUDIT — when true, fail boot (exit 1) if any
  // protected dashboard route lacks a canonical Permission_String per
  // R17 AC#9 (multi-vendor design §4.5, task 2.7). Default false until
  // Phase C tasks (3.x – 11.x) wire `requiredPermission` onto every
  // protected route; flip to true once that work is complete.
  STRICT_PERMISSION_AUDIT: booleanFromEnv.default(false),

  // STRICT_SESSION_VERSION_CHECK — when true, the auth plugin (task 3.7)
  // rejects any JWT that does not carry a `session_version` claim with
  // 401 SESSION_INVALID per R20.8 (multi-vendor design §5.5). Default
  // false so legacy in-flight tokens minted before migration 047 are
  // accepted (the row-vs-claim comparison still runs whenever the claim
  // IS present). Flip to true once all live tokens have rotated through
  // the `session_version`-aware /login, /select-shop, and
  // /change-password flows (tasks 3.2 / 3.3 / 3.5).
  STRICT_SESSION_VERSION_CHECK: booleanFromEnv.default(false),

  // MULTI_VENDOR_PRODUCT_APPROVAL — opt-in HQ approval workflow for
  // newly created Shop_Products (R23.10, R23.11, R23.22, R23.23 /
  // multi-vendor design §3.2.3 + §17.3). Default false preserves
  // backward-compatible "born APPROVED" behaviour. When true:
  //   1. The manual-create path persists Shop_Products with
  //      `approval_status='PENDING'`.
  //   2. The HQ approve/reject endpoints under
  //      `/api/v1/admin/shop-products/:id/{approve,reject}` are
  //      ENABLED. While the flag is OFF those endpoints reply
  //      503 FEATURE_DISABLED so callers can detect the gate without
  //      probing route existence.
  //   3. Customer-facing product queries gain
  //      `approval_status='APPROVED'` to the existing visibility filter
  //      (design §17.3).
  MULTI_VENDOR_PRODUCT_APPROVAL: booleanFromEnv.default(false),

  // 2Factor.in SMS OTP
  TWO_FACTOR_API_KEY: z.string().optional(),
  // Template name registered on 2Factor.in dashboard.
  // Accepts both TWO_FACTOR_TEMPLATE (preferred) and legacy TWO_FACTOR_SENDER alias.
  TWO_FACTOR_TEMPLATE: z.string().default('GroceryAppOTP'),
  TWO_FACTOR_SENDER: z.string().optional(),        // alias — used if TEMPLATE unset
  // TWO_FACTOR_BASE_URL is not needed — the URL is hardcoded in sms.js to
  // https://2factor.in/API/V1 which is the stable, non-configurable endpoint.
  SMS_PROVIDER: z.enum(['2factor', 'none']).default('none'),

  // Firebase FCM
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FCM_ENABLED: booleanFromEnv.default(false),

  // Demo delivery flow
  ALLOW_DEMO_DELIVERY_ACTIONS: booleanFromEnv.default(false),

  // Delivery
  DELIVERY_RADIUS_KM: z.coerce.number().default(10),
  EXPRESS_DELIVERY_MINUTES: z.coerce.number().default(30),
  PLATFORM_FEE: z.coerce.number().default(5),
  FREE_DELIVERY_ABOVE: z.coerce.number().default(499),
  DELIVERY_FEE: z.coerce.number().default(25),

  // BullMQ
  BULL_REDIS_HOST: z.string().default('localhost'),
  BULL_REDIS_PORT: z.coerce.number().default(6379),
  BULL_REDIS_PASSWORD: z.string().optional(),
  BULL_CONCURRENCY: z.coerce.number().default(5),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = {
  ...parsed.data,
  ENABLE_SWAGGER:
    parsed.data.ENABLE_SWAGGER ?? parsed.data.NODE_ENV !== 'production',
}
