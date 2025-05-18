import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import logger from '../utils/logger.js';

/**
 * Generate JWT token
 * @param {String} id - User ID
 * @returns {String} JWT token
 */
export const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '1d',
    });
};

/**
 * Generate refresh token
 * @param {String} id - User ID
 * @returns {String} Refresh token
 */
export const generateRefreshToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, {
        expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    });
};

/**
 * Verify JWT token
 * @param {String} token - JWT token to verify
 * @returns {Object} Decoded token
 */
export const verifyToken = token => {
    try {
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
        logger.error(`Token verification error: ${error.message}`);
        throw error;
    }
};

/**
 * Verify refresh token
 * @param {String} token - Refresh token to verify
 * @returns {Object} Decoded token
 */
export const verifyRefreshToken = token => {
    try {
        return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    } catch (error) {
        logger.error(`Refresh token verification error: ${error.message}`);
        throw error;
    }
};

/**
 * Find user by ID
 * @param {String} id - User ID
 * @returns {Object} User document
 */
export const findUserById = async (id) => {
    return await User.findById(id);
};

/**
 * Find user by email
 * @param {String} email - User email
 * @returns {Object} User document
 */
export const findUserByEmail = async (email) => {
    return await User.findOne({ email });
};

/**
 * Check if user exists by email
 * @param {String} email - User email
 * @returns {Boolean} Whether user exists
 */
export const userExists = async (email) => {
    const user = await findUserByEmail(email);
    return !!user;
};

/**
 * Create a new user
 * @param {Object} userData - User data
 * @returns {Object} Created user
 */
export const createUser = async (userData) => {
    return await User.create(userData);
};

/**
 * Update user data
 * @param {String} id - User ID
 * @param {Object} updates - Fields to update
 * @returns {Object} Updated user
 */
export const updateUser = async (id, updates) => {
    return await User.findByIdAndUpdate(id, updates, {
        new: true,
        runValidators: true
    });
};

export default {
    generateToken,
    generateRefreshToken,
    verifyToken,
    verifyRefreshToken,
    findUserById,
    findUserByEmail,
    userExists,
    createUser,
    updateUser
};