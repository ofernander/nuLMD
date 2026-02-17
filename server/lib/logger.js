const winston = require('winston');
const path = require('path');

const logLevel = process.env.LOG_LEVEL || 'info';

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
    // Write all logs to file
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error'
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/combined.log')
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
  logger.level = level;
  logger.info(`Log level changed to: ${level}`);
}

module.exports = { logger, getRecentLogs, setLogLevel };
