/**
 * firebase.js — re-exports Firebase Admin messaging from the shared
 * lazy initializer in pushNotification.js.
 *
 * Previously this file eagerly called admin.initializeApp() which caused
 * "default Firebase app already exists" errors when pushNotification.js
 * also initialised lazily. Now we delegate entirely to pushNotification.js
 * which guards with a singleton `firebaseApp` reference.
 */
export { firebaseMessaging } from '../utils/pushNotification.js'
export { default } from '../utils/pushNotification.js'
