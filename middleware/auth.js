import jwt from 'jsonwebtoken';
import { asyncHandler } from '../utils/asyncHandler.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';
import { requireEmailVerification } from '../utils/emailVerification.js';
import { userCache } from '../utils/userCache.js';

/**
 * Protect routes - authentication middleware
 * @desc Verify the JWT token in the Authorization header
 */
export const protect = asyncHandler(async (req, res, next) => {
    // Check for token in headers
    let token;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer')) {
        token = authHeader.split(' ')[1];
    }

    // Check if token exists
    if (!token) {
        return res.status(401).json({
            status: 'error',
            message: 'Not authorized to access this route',
        });
    }

    try {
        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Find user by id. Recently seen users come from a short in-process cache instead of the database;
        // a fresh document is built per request, so nothing one request does leaks into another.
        let user;
        const cached = userCache.get(decoded.id);
        if (cached) {
            user = User.hydrate(cached);
        } else {
            const found = await User.findById(decoded.id).lean();
            if (found) {
                userCache.set(decoded.id, found);
                user = User.hydrate(found);
            }
        }

        // Check if user exists
        if (!user) {
            return res.status(401).json({
                status: 'error',
                message: 'User not found',
            });
        }

        // A password change or reset signs out every session that existed before it
        if (user.passwordChangedAt && decoded.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
            return res.status(401).json({
                status: 'error',
                message: 'Your password was changed. Please sign in again.',
            });
        }

        // Check if email is verified (only when verification is switched on)
        if (requireEmailVerification() && !user.emailVerified) {
            return res.status(401).json({
                status: 'error',
                code: 'email_not_verified',
                message: 'Please verify your email before accessing this resource',
            });
        }

        // Set user in request
        req.user = user;
        next();
    } catch (error) {
        logger.error(`Auth error: ${error.message}`);

        return res.status(401).json({
            status: 'error',
            message: 'Not authorized to access this route',
        });
    }
});

/**
 * Authorize roles middleware
 * @desc Check if user has the required role
 * @param {...String} roles - Roles to authorize
 */
export const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                status: 'error',
                message: 'Not authorized to access this route',
            });
        }

        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                status: 'error',
                message: `Role ${req.user.role} is not authorized to access this route`,
            });
        }

        next();
    };
};

export default {
    protect,
    authorize,
};