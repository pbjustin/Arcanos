/**
 * Logger Module
 * Winston-based logging system
 */

import fs from 'fs';
import path from 'path';
import winston from 'winston';

const logLevel = process.env.LOG_LEVEL || 'info';
const isProd = process.env.NODE_ENV === 'production';

const logsDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat()
);
const jsonFormat = winston.format.combine(baseFormat, winston.format.json());
const consoleFormat = isProd
  ? jsonFormat
  : winston.format.combine(baseFormat, winston.format.colorize(), winston.format.simple());

// Create logger
export const logger = winston.createLogger({
  level: logLevel,
  format: jsonFormat,
  defaultMeta: { service: 'arcanos-backend' },
  transports: [
    new winston.transports.Console({
      format: consoleFormat
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880,
      maxFiles: 5
    })
  ]
});

export default logger;
