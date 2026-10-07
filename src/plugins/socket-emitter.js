import { Emitter } from '@socket.io/redis-emitter'
import { redis } from '../config/redis.js'

let emitter = null

/**
 * Returns a Socket.IO-compatible emitter (`.to(room).emit(event, data)`)
 * that works from the bakaloo-worker process, which has no real
 * Socket.IO server of its own. Publishes over the same Redis channel
 * the API process's server subscribes to via @socket.io/redis-adapter
 * (see socketio.plugin.js), so events reach actually-connected
 * clients regardless of which process emitted them.
 */
export function getSocketEmitter() {
  if (!emitter) {
    emitter = new Emitter(redis)
  }
  return emitter
}
