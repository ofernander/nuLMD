const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

const logLevel = process.env.LOG_LEVEL || 'info'; // may be overridden after config loads — see index.js

// Map UI label names to Winston levels
const LOG_LEVEL_MAP = { info: 'info', warn: 'warn', debug: 'debug' };

function resolveLevel(level) {
  return LOG_LEVEL_MAP[level] || level;
}

// In-memory circular buffer for recent logs (last 5000)
const logBuffer = [];
const MAX_LOG_BUFFER_SIZE = 5000;

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'nuLMD' },
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
          let msg = `${timestamp} [${service}] ${level}: ${message}`;
          if (Object.keys(meta).length > 0) {
            msg += ` ${JSON.stringify(meta)}`;
          }
          return msg;
        })
      )
    }),
    // Write all logs to rotating files
    new DailyRotateFile({
      filename: path.join(__dirname, '../../logs/nuLMD-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: 10,
      zippedArchive: true,
      auditFile: path.join(__dirname, '../../logs/.audit-combined.json')
    }),
    new DailyRotateFile({
      filename: path.join(__dirname, '../../logs/nuLMD-error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '10m',
      maxFiles: 5,
      zippedArchive: true,
      auditFile: path.join(__dirname, '../../logs/.audit-error.json')
    })
  ]
});

// Hook into all logger methods to capture logs in memory buffer
function captureLog(level, message) {
  logBuffer.push({
    timestamp: new Date().toISOString(),
    level: level,
    message: typeof message === 'string' ? message : JSON.stringify(message),
    service: 'nuLMD'
  });
  
  // Keep only last MAX_LOG_BUFFER_SIZE logs
  if (logBuffer.length > MAX_LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }
}

// Wrap each Winston method
const levels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
levels.forEach(level => {
  const originalMethod = logger[level].bind(logger);
  logger[level] = function(message, ...args) {
    captureLog(level, message);
    return originalMethod(message, ...args);
  };
});

// Function to get recent logs
function getRecentLogs(count = 100) {
  const limit = Math.min(count, logBuffer.length);
  return logBuffer.slice(-limit);
}

// Function to dynamically change log level
function setLogLevel(level) {
  const resolved = resolveLevel(level);
  logger.level = resolved;
  // Must update each transport individually — Winston doesn't cascade from logger.level alone
  logger.transports.forEach(t => { t.level = resolved; });
  logger.info(`Log level changed to: ${resolved}`);
}

module.exports = { logger, getRecentLogs, setLogLevel, resolveLevel };
