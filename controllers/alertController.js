import AlertEvent from '../models/AlertEvent.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { parseAlertQuery, toAlertItem, feedTypes } from '../utils/alertFeed.js';

/**
 * @desc    The signed-in user's alerts, newest first
 * @route   GET /api/alerts?limit=&after=<alertId>&before=<alertId>
 * @access  Private (owner only: the filter always uses the session's user, never a request parameter)
 *
 * `after` is how the mobile app catches up: it sends the newest alert it has seen and gets what came since.
 * `before` pages backwards through older ones.
 */
export const getAlerts = asyncHandler(async (req, res) => {
    const { limit, after, before, includeHost } = parseAlertQuery(req.query);

    // Only the types this app asked for: an older app does not know the host ones and would show them blank
    const types = { $in: feedTypes(includeHost) };
    const filter = { userId: req.user._id, type: types };
    if (after || before) {
        filter._id = {};
        if (after) filter._id.$gt = after;
        if (before) filter._id.$lt = before;
    }

    const [rows, unreadCount] = await Promise.all([
        AlertEvent.find(filter).sort({ _id: -1 }).limit(limit).lean(),
        // `readAt: null` also matches rows written before the field existed
        AlertEvent.countDocuments({ userId: req.user._id, readAt: null, type: types }),
    ]);

    res.status(200).json({
        status: 'success',
        data: {
            alerts: rows.map(toAlertItem),
            unreadCount,
        },
    });
});

/**
 * @desc    Mark one alert as read (safe to repeat)
 * @route   PATCH /api/alerts/:id/read
 * @access  Private
 */
export const markAlertRead = asyncHandler(async (req, res) => {
    const filter = { _id: req.params.id, userId: req.user._id };

    const result = await AlertEvent.updateOne({ ...filter, readAt: null }, { $set: { readAt: new Date() } });

    // Nothing changed: either it was already read, or it isn't this user's alert
    if (result.matchedCount === 0 && !(await AlertEvent.exists(filter))) {
        return res.status(404).json({ status: 'error', message: 'Alert not found' });
    }

    res.status(200).json({ status: 'success', data: { id: req.params.id } });
});

/**
 * @desc    Mark all of the user's alerts as read
 * @route   POST /api/alerts/read-all
 * @access  Private
 */
export const markAllAlertsRead = asyncHandler(async (req, res) => {
    const result = await AlertEvent.updateMany({ userId: req.user._id, readAt: null }, { $set: { readAt: new Date() } });

    res.status(200).json({ status: 'success', data: { updated: result.modifiedCount } });
});

export default { getAlerts, markAlertRead, markAllAlertsRead };
