import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Middleware to restrict access to admin users only
 */
export const adminOnly = asyncHandler(async (req, res, next) => {
    // Check if user exists and is an admin
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({
            status: 'error',
            message: 'Unauthorized: Admin access required',
        });
    }

    next();
});