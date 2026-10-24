import { z } from 'zod';
import { isValidTimezone } from './schedule.js';
import { containsCredentials } from './address.js';

const TIME = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

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
    alerts: z.object({
        enabled: z.boolean().optional(),
        email: z.boolean().optional(),
        phone: z.boolean().optional(),
        webhookUrl: z.union([
            z.literal(''),
            z.string().url("Invalid URL format").refine((u) => /^https?:\/\//i.test(u), "Webhook must be an http(s) URL")
        ]).optional(),
        responseThreshold: z.number().int().min(10).optional(),
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
});

// Update: every field optional, no defaults, so only what was sent is validated and changed
export const updateServerSchema = z.object(serverShape).partial();

/** Zod 4 exposes problems as `issues` (there is no `errors`). */
export const formatZodIssues = (error) =>
    error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message
    }));
