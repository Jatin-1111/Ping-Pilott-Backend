import Incident from '../models/Incident.js';
import Server from '../models/Server.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { buildIncidentList, periodStart, DEFAULT_DAYS } from '../utils/incidentList.js';
import { hasDetailedDiagnosis } from '../utils/planFeatures.js';

// A user's incidents in a period are a handful in practice. This bounds the worst case (a flapping server
// over 30 days) so one request can never read an unbounded number of rows.
const MAX_ROWS = 2000;

/**
 * @desc    Incidents across all of the signed-in user's servers
 * @route   GET /api/incidents?status=&days=&serverId=&page=&limit=
 * @access  Private (owner only: the filter always uses the session's user, never a request parameter)
 */
export const getIncidents = asyncHandler(async (req, res) => {
    const status = ['ongoing', 'resolved'].includes(req.query.status) ? req.query.status : 'all';
    const days = parseInt(req.query.days, 10) === 30 ? 30 : DEFAULT_DAYS;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const since = periodStart(days);
    const filter = {
        userId: req.user._id,
        // started inside the period, or still going on whenever it started
        $or: [{ startedAt: { $gte: since } }, { open: true }],
    };
    if (req.query.serverId) {
        // An id that is not one is a bad request, not a database error
        if (typeof req.query.serverId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(req.query.serverId)) {
            return res.status(400).json({ status: 'error', message: 'Invalid server ID', code: 'INVALID_SERVER_ID' });
        }
        filter.serverId = req.query.serverId;
    }

    const [rows, servers] = await Promise.all([
        Incident.find(filter).select('+evidence').sort({ startedAt: -1 }).limit(MAX_ROWS).lean(),
        Server.find({ uploadedBy: req.user._id }).select('name url type').sort({ name: 1 }).lean(),
    ]);

    // The causes, things to check and what the server said are part of the plan; the rest of an incident is for everyone
    const result = buildIncidentList(rows, servers, { status, days, page, limit, detailed: hasDetailedDiagnosis(req.user) });

    res.status(200).json({
        status: 'success',
        data: {
            ...result,
            // for the server filter on the page
            servers: servers.map((s) => ({ id: String(s._id), name: s.name })),
        },
    });
});

export default { getIncidents };
