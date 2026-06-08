// Structured logger with PII redaction. Phone numbers, emails, names and the
// Freshdesk API key are never written in clear text.
import pino from 'pino';
import { config } from './config.js';

const redactPaths = [
  'phone', 'phone_number', 'mobile', 'caller_number', 'callee_number',
  'email', 'caller_email', 'name', 'caller_name', 'apiKey', 'api_key',
  'authorization', 'password', '*.phone', '*.mobile', '*.email', '*.name',
];

export const logger = pino({
  level: config.logLevel,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: undefined, // drop pid/hostname noise
  transport:
    config.nodeEnv === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
});

/** Mask a phone for the rare case we must include it in a message string. */
export function maskPhone(raw) {
  const s = String(raw || '');
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '****' + s.slice(-3);
}
