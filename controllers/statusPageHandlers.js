// controllers/statusPageHandlers.js - the status page endpoints, with the cache handed in
//
// The owner's endpoints (list, create, edit, delete) always filter by the signed-in user. The public endpoint has no user
// and returns only what utils/statusPage.js builds. The cache is a parameter so these run in tests without Redis;
// controllers/statusPageController.js supplies the real one.

import mongoose from 'mongoose';
import StatusPage from '../models/StatusPage.js';
import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import Incident from '../models/Incident.js';
import User from '../models/User.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { statusPageAllowance } from '../utils/planFeatures.js';
import { SCHEDULED_CHECKS_ONLY } from '../services/checkRunner.js';
import {
    HISTORY_DAYS,
    INCIDENT_DAYS,
    buildPublicStatus,
    createStatusPageSchema,
    firstIssue,
    isValidSlug,
    lastDays,
    updateStatusPageSchema
} from '../utils/statusPage.js';

const PUBLIC_CACHE_SECONDS = 60;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (res, status, message, code) => res.status(status).json({ status: 'error', message, ...(code ? { code } : {}) });

/** What the owner's screen needs about a page */
const ownerView = (page) => ({
    id: String(page._id),
    slug: page.slug,
    title: page.title,
    description: page.description || '',
    servers: (page.servers || []).map((s) => ({ serverId: String(s.serverId), label: s.label || '' })),
    published: Boolean(page.published),
    indexable: Boolean(page.indexable),
    path: `/status/${page.slug}`,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt
});

/** How many pages the user's plan allows (null: no limit, for admins) and whether pages carry the footer */
export const allowanceFor = (user) => {
    if (user?.role === 'admin') return { pages: null, branded: false };
    return statusPageAllowance(user?.subscription?.plan);
};

const isDuplicateKey = (error) => error?.code === 11000;

/** Every server id must be this user's own. A page can never show somebody else's monitor. */
const ownsAll = async (userId, serverIds) => {
    if (serverIds.length === 0) return true;
    const found = await Server.countDocuments({ _id: { $in: serverIds }, uploadedBy: userId });
    return found === serverIds.length;
};

/**
 * @param {{ cache: { get: Function, set: Function, del: Function } }} deps
 */
export function createStatusPageHandlers({ cache }) {
    const forget = (...slugs) => Promise.all(slugs.filter(Boolean).map((slug) => cache.del(`public:status:${slug}`)));

    /** GET /api/status-pages - the owner's pages and how many more they may add */
    const listStatusPages = asyncHandler(async (req, res) => {
        const pages = await StatusPage.find({ userId: req.user._id }).sort({ createdAt: 1 }).lean();
        const allowance = allowanceFor(req.user);
        res.status(200).json({
            status: 'success',
            data: {
                pages: pages.map(ownerView),
                limit: allowance.pages,
                used: pages.length,
                branded: allowance.branded
            }
        });
    });

    /** GET /api/status-pages/slug?slug= - is this address free? */
    const checkSlug = asyncHandler(async (req, res) => {
        const slug = typeof req.query.slug === 'string' ? req.query.slug.trim().toLowerCase() : '';
        if (!isValidSlug(slug)) {
            return res.status(200).json({ status: 'success', data: { slug, valid: false, available: false } });
        }
        const taken = await StatusPage.exists({ slug });
        res.status(200).json({ status: 'success', data: { slug, valid: true, available: !taken } });
    });

    /** POST /api/status-pages */
    const createStatusPage = asyncHandler(async (req, res) => {
        const parsed = createStatusPageSchema.safeParse(req.body);
        if (!parsed.success) return fail(res, 400, firstIssue(parsed.error), 'INVALID_STATUS_PAGE');
        const input = parsed.data;

        const allowance = allowanceFor(req.user);
        const used = await StatusPage.countDocuments({ userId: req.user._id });
        if (allowance.pages !== null && used >= allowance.pages) {
            return fail(res, 403, `Your plan includes ${allowance.pages} status page${allowance.pages === 1 ? '' : 's'}. Upgrade to add more.`, 'STATUS_PAGE_LIMIT');
        }

        const servers = input.servers || [];
        if (!(await ownsAll(req.user._id, servers.map((s) => s.serverId)))) {
            return fail(res, 400, 'One of those monitors is not yours', 'INVALID_SERVER');
        }

        try {
            const page = await StatusPage.create({
                userId: req.user._id,
                slug: input.slug,
                title: input.title,
                description: input.description || '',
                servers: servers.map((s) => ({ serverId: s.serverId, label: s.label || '' })),
                published: input.published ?? false,
                indexable: input.indexable ?? false
            });
            res.status(201).json({ status: 'success', data: { page: ownerView(page.toObject()) } });
        } catch (error) {
            if (isDuplicateKey(error)) return fail(res, 409, 'That address is already taken', 'SLUG_TAKEN');
            throw error;
        }
    });

    /** PATCH /api/status-pages/:id */
    const updateStatusPage = asyncHandler(async (req, res) => {
        if (!OBJECT_ID.test(String(req.params.id))) return fail(res, 400, 'Invalid status page', 'INVALID_ID');
        const parsed = updateStatusPageSchema.safeParse(req.body);
        if (!parsed.success) return fail(res, 400, firstIssue(parsed.error), 'INVALID_STATUS_PAGE');
        const input = parsed.data;

        const page = await StatusPage.findOne({ _id: req.params.id, userId: req.user._id });
        if (!page) return fail(res, 404, 'Status page not found', 'NOT_FOUND');

        if (input.servers && !(await ownsAll(req.user._id, input.servers.map((s) => s.serverId)))) {
            return fail(res, 400, 'One of those monitors is not yours', 'INVALID_SERVER');
        }

        const oldSlug = page.slug;
        if (input.slug !== undefined) page.slug = input.slug;
        if (input.title !== undefined) page.title = input.title;
        if (input.description !== undefined) page.description = input.description;
        if (input.servers !== undefined) page.servers = input.servers.map((s) => ({ serverId: s.serverId, label: s.label || '' }));
        if (input.published !== undefined) page.published = input.published;
        if (input.indexable !== undefined) page.indexable = input.indexable;

        try {
            await page.save();
        } catch (error) {
            if (isDuplicateKey(error)) return fail(res, 409, 'That address is already taken', 'SLUG_TAKEN');
            throw error;
        }
        await forget(oldSlug, page.slug);
        res.status(200).json({ status: 'success', data: { page: ownerView(page.toObject()) } });
    });

    /** DELETE /api/status-pages/:id */
    const deleteStatusPage = asyncHandler(async (req, res) => {
        if (!OBJECT_ID.test(String(req.params.id))) return fail(res, 400, 'Invalid status page', 'INVALID_ID');
        const page = await StatusPage.findOneAndDelete({ _id: req.params.id, userId: req.user._id }).lean();
        if (!page) return fail(res, 404, 'Status page not found', 'NOT_FOUND');
        await forget(page.slug);
        res.status(200).json({ status: 'success', data: { id: String(page._id) } });
    });

    /** Build what a stranger sees for a published page: fresh from the database */
    const loadPublicStatus = async (slug) => {
        const page = await StatusPage.findOne({ slug, published: true }).lean();
        if (!page) return null;

        const ids = (page.servers || []).map((s) => s.serverId);
        const now = Date.now();
        const firstDay = Date.parse(`${lastDays(now)[0]}T00:00:00.000Z`);

        // Servers are matched on the page owner too, so a page can never show a monitor that is not theirs
        const [servers, owner, grouped, incidents] = await Promise.all([
            Server.find({ _id: { $in: ids }, uploadedBy: page.userId }).select('name status slowAlerted pausedAt').lean(),
            User.findById(page.userId).select('role subscription.plan').lean(),
            ids.length === 0 ? [] : ServerCheck.aggregate([
                {
                    $match: {
                        serverId: { $in: ids.map((id) => new mongoose.Types.ObjectId(String(id))) },
                        timestamp: { $gte: new Date(firstDay) },
                        // uptime describes the monitor, not how often someone pressed "Check now"
                        ...SCHEDULED_CHECKS_ONLY
                    }
                },
                {
                    $group: {
                        _id: { serverId: '$serverId', day: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } } },
                        up: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
                        // a check with no answer either way ('unknown') is not counted for or against
                        total: { $sum: { $cond: [{ $in: ['$status', ['up', 'down']] }, 1, 0] } }
                    }
                }
            ]).allowDiskUse(true),
            ids.length === 0 ? [] : Incident.find({
                serverId: { $in: ids },
                $or: [{ startedAt: { $gte: new Date(now - INCIDENT_DAYS * DAY_MS) } }, { open: true }]
            }).sort({ startedAt: -1 }).limit(200).lean()
        ]);

        const dailyRows = grouped.map((g) => ({ serverId: String(g._id.serverId), day: g._id.day, up: g.up, total: g.total }));
        return buildPublicStatus({ page, servers, dailyRows, incidents, allowance: allowanceFor(owner), now });
    };

    /** GET /api/public/status/:slug - no sign-in; cached for a minute so a busy page costs one build per minute */
    const getPublicStatus = asyncHandler(async (req, res) => {
        const slug = String(req.params.slug || '').toLowerCase();
        // Not a possible address: say not found without touching the cache or the database
        if (!isValidSlug(slug)) return fail(res, 404, 'Status page not found', 'NOT_FOUND');

        const key = `public:status:${slug}`;
        let view = await cache.get(key);
        if (!view) {
            view = await loadPublicStatus(slug);
            if (!view) return fail(res, 404, 'Status page not found', 'NOT_FOUND');
            await cache.set(key, view, PUBLIC_CACHE_SECONDS);
        }

        // Let a CDN or the web app's own cache hold it briefly too
        res.set?.('Cache-Control', `public, max-age=30, stale-while-revalidate=${PUBLIC_CACHE_SECONDS}`);
        res.status(200).json({ status: 'success', data: view });
    });

    return { listStatusPages, checkSlug, createStatusPage, updateStatusPage, deleteStatusPage, getPublicStatus, loadPublicStatus };
}

export { HISTORY_DAYS };
export default { createStatusPageHandlers, allowanceFor };
