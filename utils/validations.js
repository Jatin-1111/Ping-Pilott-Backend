import { z } from 'zod';

// Monitoring configuration schema
const monitoringSchema = z.object({
    frequency: z.number().int().min(1).max(60).optional().default(5),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional().default([0, 1, 2, 3, 4, 5, 6]),
    timeWindows: z.array(z.object({
        start: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, "Invalid time format (HH:MM)"),
        end: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, "Invalid time format (HH:MM)")
    })).optional().default([{ start: '00:00', end: '23:59' }]),
    alerts: z.object({
        enabled: z.boolean().optional().default(false),
        email: z.boolean().optional().default(false),
        phone: z.boolean().optional().default(false),
        webhookUrl: z.string().url("Invalid URL format").optional().or(z.literal('')),
        responseThreshold: z.number().int().min(10).optional().default(1000),
        timeWindow: z.object({
            start: z.string().optional(),
            end: z.string().optional()
        }).optional().default({ start: '00:00', end: '23:59' })
    }).optional().default({})
});

// Create Server Schema
export const createServerSchema = z.object({
    name: z.string().min(1, "Name is required").max(100),
    url: z.string().min(3, "URL is required"), // Basic length check, robust check via normalization later
    type: z.enum(['website', 'api', 'tcp', 'database']).optional().default('website'),
    description: z.string().max(500).optional(),
    priority: z.enum(['high', 'medium', 'low']).optional().default('medium'),
    monitoring: monitoringSchema.optional().default({}),
    contactEmails: z.array(z.string().email()).optional().default([]),
    contactPhones: z.array(z.string().regex(/^\+?[\d\s-]{10,20}$/, "Invalid phone number")).optional().default([])
});

// Update Server Schema (Partial)
export const updateServerSchema = createServerSchema.partial().extend({
    // Add specific update-only fields if necessary
});
