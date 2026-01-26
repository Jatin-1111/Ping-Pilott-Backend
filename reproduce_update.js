
import { z } from 'zod';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Server from './models/Server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env vars
dotenv.config({ path: join(__dirname, '.env') });

// Copying validations because importing might require other dependencies or path setup
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
        responseThreshold: z.number().int().min(10).optional().default(1000),
        timeWindow: z.object({
            start: z.string().optional(),
            end: z.string().optional()
        }).optional().default({ start: '00:00', end: '23:59' })
    }).optional().default({})
});

// Create Server Schema
const createServerSchema = z.object({
    name: z.string().min(1, "Name is required").max(100),
    url: z.string().min(3, "URL is required"),
    type: z.enum(['website', 'api', 'tcp', 'database']).optional().default('website'),
    description: z.string().max(500).optional(),
    priority: z.enum(['high', 'medium', 'low']).optional().default('medium'),
    monitoring: monitoringSchema.optional().default({}),
    contactEmails: z.array(z.string().email()).optional().default([]),
    contactPhones: z.array(z.string().regex(/^\+?[\d\s-]{10,20}$/, "Invalid phone number")).optional().default([])
});

const updateServerSchema = createServerSchema.partial().extend({});

// Controller logic simulation
const buildMonitoringUpdates = (monitoring) => {
    const updates = {};

    if (monitoring.frequency !== undefined) {
        updates['monitoring.frequency'] = monitoring.frequency;
    }
    if (monitoring.daysOfWeek !== undefined) {
        updates['monitoring.daysOfWeek'] = monitoring.daysOfWeek;
    }
    if (monitoring.timeWindows !== undefined) {
        updates['monitoring.timeWindows'] = monitoring.timeWindows;
    }

    // Handle alerts
    if (monitoring.alerts) {
        Object.entries(monitoring.alerts).forEach(([key, value]) => {
            if (value !== undefined) {
                updates[`monitoring.alerts.${key}`] = value;
            }
        });
    }

    return updates;
};

// Test Data (from Frontend)
const reqBody = {
    monitoring: {
        frequency: 10,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        timeWindows: [
            {
                start: '00:00',
                end: '23:59'
            }
        ],
        alerts: {
            enabled: true,
            email: true,
            phone: false,
            responseThreshold: 2000,
            timeWindow: {
                start: '08:00', // Changed start time
                end: '20:00'
            }
        }
    },
    contactEmails: ['test@example.com'],
    contactPhones: []
};

// Simulation
console.log("Simulating Validation...");
const validationResult = updateServerSchema.safeParse(reqBody);

if (!validationResult.success) {
    console.error("Validation Errors:", JSON.stringify(validationResult.error.errors, null, 2));
} else {
    console.log("Validation Success");
    const validatedData = validationResult.data;

    const updates = {};
    // Simulation of controller mapping
    const { monitoring } = reqBody; // Raw body usage as in controller

    if (monitoring) {
        const monitoringUpdates = buildMonitoringUpdates(monitoring);
        Object.assign(updates, monitoringUpdates);
    }

    console.log("Generated Updates Object:", JSON.stringify(updates, null, 2));
}

const run = async () => {
    try {
        console.log("Connecting to MongoDB...");
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected.");

        // Clean up previous test server if exists
        await Server.deleteOne({ name: "Test_Update_Server" });

        // Create a test server
        const server = await Server.create({
            name: "Test_Update_Server",
            url: "http://test-update.com",
            uploadedBy: "test_user",
            monitoring: {
                frequency: 5,
                alerts: {
                    enabled: true,
                    timeWindow: { start: "00:00", end: "23:59" }
                }
            }
        });

        console.log("Created server:", server._id);

        // Simulation of controller update logic
        const updates = {};
        const monitoring = {
            frequency: 10,
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            alerts: {
                enabled: true,
                timeWindow: { start: "08:00", end: "20:00" }
            }
        };

        const monitoringUpdates = buildMonitoringUpdates(monitoring);
        Object.assign(updates, monitoringUpdates);

        console.log("Applying updates:", JSON.stringify(updates, null, 2));

        const updatedServer = await Server.findByIdAndUpdate(
            server._id,
            { $set: updates },
            { new: true, runValidators: true }
        );

        console.log("Updated Server Monitoring:", JSON.stringify(updatedServer.monitoring, null, 2));

        // Clean up
        await Server.deleteOne({ _id: server._id });
        console.log("Test finished successfully");
        process.exit(0);

    } catch (error) {
        console.error("Error:", error);
        process.exit(1);
    }
};

run();
