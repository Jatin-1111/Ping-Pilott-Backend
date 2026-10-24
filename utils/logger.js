import winston from 'winston';
import util from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The test runner must not write to the real log files (and its fake failures looked like real ones in them)
const underTest = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);

// Define log levels
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
};

// Define level based on environment
const level = () => {
    const env = process.env.NODE_ENV || 'development';
    return env === 'development' ? 'debug' : 'info';
};

// Define colors for each level
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'blue',
};

// Add colors to Winston
winston.addColors(colors);

const SPLAT = Symbol.for('splat');
const MAX_META_LENGTH = 2000;
const MAX_DEPTH = 5;

// Values under these keys are never written. (Webhook addresses are bearer secrets: anyone holding one can post to the channel.)
const SENSITIVE_KEY = /^(pass|pwd)$|password|secret|token|authorization|cookie|api[-_]?key|webhook/i;
// user:password@ inside an address, for example postgres://app:secret@db.example.com
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi;

const scrubString = (text) => text.replace(URL_CREDENTIALS, '$1***@');

/** A copy of `value` that is safe to write: sensitive keys hidden, credentials in addresses masked, cycles cut. */
export const redact = (value, depth = 0, seen = new WeakSet()) => {
    if (typeof value === 'string') return scrubString(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[Object]';
    seen.add(value);

    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
    // ObjectId, Date and similar know how to print themselves
    if (typeof value.toJSON === 'function') return redact(value.toJSON(), depth + 1, seen);

    const copy = {};
    for (const [key, inner] of Object.entries(value)) {
        copy[key] = SENSITIVE_KEY.test(key) ? '[hidden]' : redact(inner, depth + 1, seen);
    }
    return copy;
};

/**
 * One error as text: its type and code, message, stack, and (for an AggregateError, which is what a refused
 * connection to localhost produces and which has an empty message) the errors inside it.
 */
const describeError = (err) => {
    const lines = [err.stack || `${err.name}: ${err.message}`];
    if (err.code && !lines[0].includes(String(err.code))) lines.push(`  code: ${err.code}`);
    if (Array.isArray(err.errors)) {
        for (const inner of err.errors) lines.push(`  caused by ${inner?.code ? `[${inner.code}] ` : ''}${inner?.message || inner}`);
    }
    return lines.join('\n');
};

/**
 * Builds the text of one log entry from what the caller passed: `logger.error('what happened:', err, { id })`.
 * Winston puts the extra arguments in info[Symbol.for('splat')]. Errors print with their stack, plain values
 * are appended to the message, objects become one JSON object after it, and everything is redacted.
 */
const shapeEntry = winston.format((info) => {
    let message = typeof info.message === 'string' ? info.message : util.inspect(info.message);
    const splat = info[SPLAT] || [];
    const errors = [];
    const meta = {};

    if (splat.length && /%[sdifjoO]/.test(message)) {
        // printf style: logger.error('Failed: %s', reason)
        message = util.format(message, ...splat);
    } else {
        for (const arg of splat) {
            if (arg instanceof Error) {
                errors.push(arg);
                // Winston appended this error's message to ours; the stack below already has it
                if (arg.message && message.endsWith(` ${arg.message}`)) message = message.slice(0, -(arg.message.length + 1));
            } else if (arg !== null && typeof arg === 'object') {
                Object.assign(meta, arg);
            } else if (arg !== undefined) {
                message += ` ${arg}`;
            }
        }
    }

    let text = scrubString(message);
    for (const err of errors) text += `\n${scrubString(describeError(err))}`;

    if (Object.keys(meta).length > 0) {
        let json;
        try {
            json = JSON.stringify(redact(meta));
        } catch {
            json = '[unprintable details]';
        }
        if (json.length > MAX_META_LENGTH) json = `${json.slice(0, MAX_META_LENGTH)}...(cut)`;
        text += ` ${json}`;
    }

    info.message = text;
    return info;
});

// The shared format has no colour: the files must stay plain text. Only the console adds colour.
const format = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    shapeEntry(),
    winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`),
);

// Define where to store logs
const transports = underTest
    ? [new winston.transports.Console({ silent: true })]
    : [
        // Console logger
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize({ level: true }),
                winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`),
            ),
        }),

        // Error log file
        new winston.transports.File({
            filename: path.join(__dirname, '../logs/error.log'),
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),

        // All logs file
        new winston.transports.File({
            filename: path.join(__dirname, '../logs/combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
    ];

// Create the logger
const logger = winston.createLogger({
    level: level(),
    levels,
    format,
    transports,
    silent: underTest,
    exceptionHandlers: underTest ? [] : [
        new winston.transports.File({
            filename: path.join(__dirname, '../logs/exceptions.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
    ],
    rejectionHandlers: underTest ? [] : [
        new winston.transports.File({
            filename: path.join(__dirname, '../logs/rejections.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
    ],
});

// Stream for Morgan (HTTP request logger middleware)
export const stream = {
    write: (message) => {
        logger.http(message.trim());
    },
};

export { format as logFormat };
export default logger;
