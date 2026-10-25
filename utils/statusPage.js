// utils/statusPage.js - the rules of a public status page, with no database in them
//
// Validation of what an owner sends, and the building of what a stranger sees. The second is the part that must never
// leak: it is made only from the fields named here, so a new field on a server cannot end up on a public page by accident.
// Public pages show a display name, a state, daily uptime and incident times. No address, error text or diagnosis.

import { z } from 'zod';

export const HISTORY_DAYS = 30;
export const INCIDENT_DAYS = 14;
export const MAX_INCIDENTS = 20;
export const MAX_COMPONENTS = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

// Words that would read as part of the product, or that a later route might want
export const RESERVED_SLUGS = new Set([
    'admin', 'api', 'app', 'auth', 'blog', 'dashboard', 'edit', 'health', 'help', 'login', 'new', 'ping', 'pingpilot', 'pingpilott',
    'pricing', 'privacy', 'signup', 'static', 'status', 'support', 'terms', 'www'
]);

/** 3 to 40 characters: lowercase letters, numbers and single hyphens, not at the start or end */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,38}[a-z0-9]$/;

export const isValidSlug = (slug) => typeof slug === 'string' && SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug);

const slugSchema = z.string().trim().toLowerCase()
    .refine((s) => SLUG_PATTERN.test(s), 'Use 3 to 40 lowercase letters, numbers and hyphens, starting and ending with a letter or number')
    .refine((s) => !RESERVED_SLUGS.has(s), 'That address is reserved, please choose another');

const componentSchema = z.object({
    serverId: z.string().regex(OBJECT_ID, 'Invalid server'),
    label: z.string().trim().max(60, 'Use at most 60 characters').optional()
});

const shape = {
    slug: slugSchema,
    title: z.string().trim().min(1, 'Give the page a title').max(80, 'Use at most 80 characters'),
    description: z.string().trim().max(300, 'Use at most 300 characters'),
    servers: z.array(componentSchema).max(MAX_COMPONENTS, `A page shows at most ${MAX_COMPONENTS} monitors`)
        .refine((list) => new Set(list.map((c) => c.serverId)).size === list.length, 'A monitor can be on a page only once'),
    published: z.boolean(),
    indexable: z.boolean()
};

export const createStatusPageSchema = z.object({
    slug: shape.slug,
    title: shape.title,
    description: shape.description.optional(),
    servers: shape.servers.optional(),
    published: shape.published.optional(),
    indexable: shape.indexable.optional()
}).strict();

export const updateStatusPageSchema = z.object(shape).partial().strict();

/** First problem of a failed parse, as one sentence for the owner */
export const firstIssue = (error) => {
    const issue = error?.issues?.[0];
    if (!issue) return 'Invalid request';
    const field = issue.path?.[0];
    return field ? `${issue.message} (${field})` : issue.message;
};

// ---- what a stranger sees ----

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The last `days` calendar days (UTC), oldest first, as YYYY-MM-DD */
export const lastDays = (now, days = HISTORY_DAYS) => {
    const today = Date.parse(`${dayKey(now)}T00:00:00.000Z`);
    return Array.from({ length: days }, (_, i) => dayKey(today - (days - 1 - i) * DAY_MS));
};

/** How a day looks on the bar: no checks, fine, a bad patch, or mostly down */
export const dayState = (uptime) => {
    if (uptime === null || uptime === undefined) return 'none';
    if (uptime >= 99.9) return 'ok';
    if (uptime >= 95) return 'minor';
    return 'major';
};

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {Array<{ serverId: string, day: string, up: number, total: number }>} rows  checks grouped by server and day
 * @returns {{ days: Array<{ date: string, uptime: number|null, state: string }>, uptime: number|null }}
 */
export function dailyUptime(rows, serverId, now) {
    const byDay = new Map(rows.filter((r) => String(r.serverId) === String(serverId)).map((r) => [r.day, r]));
    let up = 0;
    let total = 0;
    const days = lastDays(now).map((date) => {
        const row = byDay.get(date);
        if (!row || !(row.total > 0)) return { date, uptime: null, state: 'none' };
        up += row.up;
        total += row.total;
        const uptime = round1((row.up / row.total) * 100);
        return { date, uptime, state: dayState(uptime) };
    });
    return { days, uptime: total > 0 ? round1((up / total) * 100) : null };
}

/** 'operational' | 'degraded' | 'down' | 'unknown' for one monitor. Paused or never-checked monitors are unknown. */
export const componentState = (server) => {
    if (server.pausedAt) return 'unknown';
    if (server.status === 'down') return 'down';
    if (server.status === 'up') return server.slowAlerted ? 'degraded' : 'operational';
    return 'unknown';
};

/** One word for the banner, from every monitor's state */
export function overallState(states) {
    if (states.length === 0) return 'unknown';
    const down = states.filter((s) => s === 'down').length;
    if (down === states.length) return 'major';
    if (down > 0) return 'partial';
    if (states.includes('degraded')) return 'degraded';
    if (states.every((s) => s === 'unknown')) return 'unknown';
    return 'operational';
}

/**
 * @param {Object} p
 * @param {Object} p.page       the StatusPage (lean): slug, title, description, servers[{ serverId, label }], indexable
 * @param {Array} p.servers     the page's servers (lean): _id, name, status, slowAlerted, pausedAt
 * @param {Array} p.dailyRows   checks grouped by server and day: { serverId, day, up, total }
 * @param {Array} p.incidents   incidents of those servers (lean): serverId, startedAt, endedAt, open
 * @param {{ branded: boolean }} p.allowance  from the owner's plan: whether to show the "Powered by" footer
 * @param {number} p.now
 */
export function buildPublicStatus({ page, servers, dailyRows, incidents, allowance, now = Date.now() }) {
    const byId = new Map(servers.map((s) => [String(s._id), s]));

    // In the owner's order; a monitor that has since been deleted is simply left out
    const components = (page.servers || [])
        .map((entry) => ({ entry, server: byId.get(String(entry.serverId)) }))
        .filter(({ server }) => server)
        .map(({ entry, server }) => {
            const { days, uptime } = dailyUptime(dailyRows, server._id, now);
            return {
                id: String(server._id),
                name: entry.label || server.name,
                state: componentState(server),
                uptime,
                days
            };
        });

    const nameOf = new Map(components.map((c) => [c.id, c.name]));
    const since = now - INCIDENT_DAYS * DAY_MS;
    const shownIncidents = incidents
        .filter((i) => nameOf.has(String(i.serverId)) && (i.open || new Date(i.startedAt).getTime() >= since))
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
        .slice(0, MAX_INCIDENTS)
        .map((i) => ({
            name: nameOf.get(String(i.serverId)),
            startedAt: new Date(i.startedAt).toISOString(),
            endedAt: i.endedAt ? new Date(i.endedAt).toISOString() : null,
            ongoing: Boolean(i.open),
            durationMs: i.open ? null : Math.max(0, new Date(i.endedAt).getTime() - new Date(i.startedAt).getTime())
        }));

    return {
        title: page.title,
        description: page.description || '',
        slug: page.slug,
        indexable: Boolean(page.indexable),
        overall: overallState(components.map((c) => c.state)),
        components,
        incidents: shownIncidents,
        poweredBy: Boolean(allowance?.branded),
        generatedAt: new Date(now).toISOString()
    };
}

export default { isValidSlug, buildPublicStatus, dailyUptime, overallState, componentState, createStatusPageSchema, updateStatusPageSchema };
