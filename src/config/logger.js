import pino from 'pino'
import { env } from './env.js'

const options = {
  level: env.LOG_LEVEL,
}

if (env.LOG_PRETTY) {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
    },
  }
}

export const logger = pino(options)
