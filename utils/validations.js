import { z } from 'zod';
import { isValidTimezone } from './schedule.js';
import { containsCredentials } from './address.js';
import { parseStatusSpec } from './statusSpec.js';
import { KEYWORD_MODES, MAX_KEYWORD_LENGTH } from './keyword.js';
import { LIMITS } from './hostAlerts.js';

const TIME = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

// A usage limit for the host agent's alerts: how high, and for how many minutes (0: at once)
const hostLimit = () => z.object({
    percent: z.number().int().min(LIMITS.percent[0]).max(LIMITS.percent[1]).optional(),
    minutes: z.number().int().min(LIMITS.minutes[0]).max(LIMITS.minutes[1]).optional()
});

// Field rules, written once and with NO defaults.
// Defaults belong to "create" only: on an update, a field that was not sent must stay untouched.
// (In Zod 4 a default survives .partial(), which silently reset type, priority and contacts on every PATCH.)
const monitoringShape = z.object({
    frequency: z.number().int().min(1).max(60).optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    timeWindows: z.array(z.object({
        start: z.string().regex(TIME, "Invalid time format (HH:MM)"),
        end: z.string().regex(TIME, "Invalid time format (HH:MM)")
    })).optional(),
    // The HTTP status codes that count as up, e.g. "200-399,401,403". '' puts the server back on the default (200-399).
    acceptedStatus: z.string().superRefine((value, ctx) => {
        const parsed = parseStatusSpec(value);
        if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.error });
    }).optional(),
    // The page must contain this text (mode 'present', the default) or must not ('absent'). null takes the check away.
    keyword: z.object({
        text: z.string().trim().min(1, 'The text to look for is required').max(MAX_KEYWORD_LENGTH, `Use at most ${MAX_KEYWORD_LENGTH} characters`),
        mode: z.enum(KEYWORD_MODES).optional()
    }).nullable().optional(),
    // When the host agent's numbers are worth an alert (utils/hostAlerts.js). Every part is optional: what is left out keeps
    // its default, and what was saved stays as it was.
    hostAlerts: z.object({
        enabled: z.boolean().optional(),
        cpu: hostLimit().optional(),
        memory: hostLimit().optional(),
        disk: hostLimit().optional(),
        missing: z.object({ minutes: z.number().int().min(LIMITS.missingMinutes[0]).max(LIMITS.missingMinutes[1]).optional() }).optional()
    }).optional(),
    alerts: z.object({
        enabled: z.boolean().optional(),
        email: z.boolean().optional(),
        phone: z.boolean().optional(),
        webhookUrl: z.union([
            z.literal(''),
            z.string().url("Invalid URL format").refine((u) => /^https?:\/\//i.test(u), "Webhook must be an http(s) URL")
        ]).optional(),
        responseThreshold: z.number().int().min(10).optional(),
        // Warn when the certificate is about to expire (by email and webhook). On unless set to false.
        certExpiry: z.boolean().optional(),
        timeWindow: z.object({
            start: z.string().optional(),
            end: z.string().optional()
        }).optional()
    }).optional()
});

const serverShape = {
    name: z.string().min(1, "Name is required").max(100),
    url: z.string().min(3, "URL is required") // Basic length check, robust check via normalization later
        .refine((value) => !containsCredentials(value), 'Remove the username and password from the address. They would be stored and shown in alert emails and feeds.'),
    type: z.enum(['website', 'api', 'tcp', 'database']),
    description: z.string().max(500),
    priority: z.enum(['high', 'medium', 'low']),
    timezone: z.string().refine(isValidTimezone, 'Unknown timezone'),
    monitoring: monitoringShape,
    contactEmails: z.array(z.string().email()),
    contactPhones: z.array(z.string().regex(/^\+?[\d\s-]{10,20}$/, "Invalid phone number"))
};

// A keyword check reads a web page, so it makes no sense for a plain TCP or database address
const noKeywordOnSockets = (data, ctx) => {
    if (data.monitoring?.keyword && (data.type === 'tcp' || data.type === 'database')) {
        ctx.addIssue({ code: 'custom', path: ['monitoring', 'keyword'], message: 'A keyword check is for websites and APIs.' });
    }
};

// Create: defaults apply here
export const createServerSchema = z.object({
    ...serverShape,
    type: serverShape.type.optional().default('website'),
    description: serverShape.description.optional().default(''),
    priority: serverShape.priority.optional().default('medium'),
    timezone: serverShape.timezone.optional(),
    monitoring: serverShape.monitoring.optional().default({}),
    contactEmails: serverShape.contactEmails.optional().default([]),
    contactPhones: serverShape.contactPhones.optional().default([])
}).superRefine(noKeywordOnSockets);

// Update: every field optional, no defaults, so only what was sent is validated and changed
export const updateServerSchema = z.object(serverShape).partial().superRefine(noKeywordOnSockets);

/** Zod 4 exposes problems as `issues` (there is no `errors`). */
export const formatZodIssues = (error) =>
    error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message
    }));
