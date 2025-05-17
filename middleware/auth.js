import jwt from 'jsonwebtoken';
import { asyncHandler } from '../utils/asyncHandler.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';

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

        // Find user by id
        const user = await User.findById(decoded.id);

        // Check if user exists
        if (!user) {
            return res.status(401).json({
                status: 'error',
                message: 'User not found',
            });
        }

        // Check if email is verified
        if (!user.emailVerified) {
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