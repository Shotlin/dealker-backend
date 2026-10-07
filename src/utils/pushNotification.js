import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

let firebaseApp = null
let _admin = null

/**
 * Initialize Firebase Admin SDK (lazy singleton — safe to call multiple times)
 */
async function getFirebaseApp() {
  if (firebaseApp) return firebaseApp

  if (!env.FCM_ENABLED || !env.FIREBASE_PROJECT_ID) {
    return null
  }

  try {
    const admin = (await import('firebase-admin')).default
    _admin = admin

    // Guard: if default app already exists (e.g. from another import path), reuse it
    if (admin.apps.length > 0) {
      firebaseApp = admin.apps[0]
      logger.info('Firebase Admin SDK reused existing app')
      return firebaseApp
    }

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.FIREBASE_PROJECT_ID,
        privateKey: env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
      }),
    })

    logger.info('Firebase Admin SDK initialized')
    return firebaseApp
  } catch (err) {
    logger.error({ err }, 'Firebase Admin SDK init failed')
    return null
  }
}

/**
 * Send push notification to a single device token.
 * Returns { success, messageId } or { success: false, reason, tokenInvalid }
 */
export async function sendPush(
  fcmToken,
  { title, body, imageUrl, deepLink, data = {}, channelId = 'bakaloo_notifications', sound = 'default' }
) {
  const app = await getFirebaseApp()
  if (!app) {
    logger.debug({ title }, 'FCM not configured — skipping push notification')
    return { success: false, reason: 'FCM not configured' }
  }

  try {
    const admin = _admin || (await import('firebase-admin')).default
    const stringData = Object.fromEntries(
      Object.entries({
        ...data,
        ...(deepLink ? { deepLink } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      })
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, String(v)])
    )

    const message = {
      token: fcmToken,
      notification: {
        title,
        body,
        ...(imageUrl && isValidHttpsUrl(imageUrl) ? { imageUrl } : {}),
      },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          sound,
          channelId,
          imageUrl: imageUrl && isValidHttpsUrl(imageUrl) ? imageUrl : undefined,
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      apns: {
        payload: { aps: { sound, badge: 1 } },
        fcmOptions: imageUrl && isValidHttpsUrl(imageUrl)
          ? { imageUrl }
          : undefined,
      },
    }

    const result = await admin.messaging().send(message)
    logger.info({ messageId: result, title }, 'Push notification sent')
    return { success: true, messageId: result }
  } catch (err) {
    const tokenInvalid = isTokenInvalidError(err)
    logger.error({ err: err.message, title, tokenInvalid }, 'Push notification failed')
    return { success: false, reason: err.message, tokenInvalid }
  }
}

/**
 * Send push to multiple tokens with partial failure handling.
 * Deactivates invalid tokens in bulk.
 */
export async function sendPushBatch(fcmTokens, { title, body, imageUrl, deepLink, data = {} }) {
  if (!fcmTokens?.length) return { success: false, reason: 'No tokens', sent: 0, failed: 0 }

  const app = await getFirebaseApp()
  if (!app) {
    logger.debug({ title }, 'FCM not configured — skipping batch push')
    return { success: false, reason: 'FCM not configured', sent: 0, failed: 0 }
  }

  try {
    const admin = _admin || (await import('firebase-admin')).default
    const stringData = Object.fromEntries(
      Object.entries({
        ...data,
        ...(deepLink ? { deepLink } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      })
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, String(v)])
    )

    const messages = fcmTokens.map((token) => ({
      token,
      notification: {
        title,
        body,
        ...(imageUrl && isValidHttpsUrl(imageUrl) ? { imageUrl } : {}),
      },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'bakaloo_notifications',
          imageUrl: imageUrl && isValidHttpsUrl(imageUrl) ? imageUrl : undefined,
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
        fcmOptions: imageUrl && isValidHttpsUrl(imageUrl)
          ? { imageUrl }
          : undefined,
      },
    }))

    const result = await admin.messaging().sendEach(messages)
    logger.info({ title, sent: result.successCount, failed: result.failureCount }, 'Batch push complete')

    // Collect invalid token indices
    const invalidTokens = []
    result.responses.forEach((r, i) => {
      if (!r.success && isTokenInvalidError(r.error)) {
        invalidTokens.push(fcmTokens[i])
      }
    })

    return {
      success: true,
      sent: result.successCount,
      failed: result.failureCount,
      invalidTokens,
    }
  } catch (err) {
    logger.error({ err: err.message, title }, 'Batch push failed')
    return { success: false, reason: err.message, sent: 0, failed: 0, invalidTokens: [] }
  }
}

// Export a getter for messaging instance (used by firebase.js re-export)
export const firebaseMessaging = null // lazy — use sendPush/sendPushBatch

function isValidHttpsUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:'
  } catch {
    return false
  }
}

function isTokenInvalidError(err) {
  if (!err) return false
  const code = err.code || err.errorInfo?.code || ''
  // Only deactivate on definitive "token no longer valid" errors
  // Do NOT deactivate on quota/rate-limit/server errors
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code.includes('registration-token-not-registered')
  )
}
