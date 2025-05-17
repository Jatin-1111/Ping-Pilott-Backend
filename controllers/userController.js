import User from '../models/User.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendVerificationEmail } from '../services/emailService.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';

/**
 * @desc    Get all users
 * @route   GET /api/users
 * @access  Private/Admin
 */
export const getAllUsers = asyncHandler(async (req, res) => {
    // Apply pagination
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    // Apply search filter if provided
    const filter = {};
    if (req.query.search) {
        const searchRegex = new RegExp(req.query.search, 'i');
        filter.$or = [
            { displayName: searchRegex },
            { email: searchRegex }
        ];
    }

    // Apply role filter if provided
    if (req.query.role && ['user', 'admin'].includes(req.query.role)) {
        filter.role = req.query.role;
    }

    // Get total count for pagination
    const total = await User.countDocuments(filter);

    // Get users
    const users = await User.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

    res.status(200).json({
        status: 'success',
        results: users.length,
        total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        data: {
            users
        }
    });
});

/**
 * @desc    Get user by ID
 * @route   GET /api/users/:id
 * @access  Private/Admin
 */
export const getUserById = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);

    if (!user) {
        return res.status(404).json({
            status: 'error',
            message: 'User not found'
        });
    }

    res.status(200).json({
        status: 'success',
        data: {
            user
        }
    });
});

/**
 * @desc    Update user profile
 * @route   PATCH /api/users/me
 * @access  Private
 */
export const updateUserProfile = asyncHandler(async (req, res) => {
    const { name, email } = req.body;
    const updates = {};

    // Update name if provided
    if (name !== undefined) {
        updates.displayName = name;
    }

    // Update email if provided and different from current
    if (email && email !== req.user.email) {
        // Check if email is already taken
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({
                status: 'error',
                message: 'Email already in use'
            });
        }

        // Generate verification token for new email
        const verificationToken = uuidv4();
        const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        updates.email = email;
        updates.emailVerified = false;
        updates.verificationToken = verificationToken;
        updates.verificationTokenExpiry = verificationTokenExpiry;

        // Send verification email
        await sendVerificationEmail(
            { ...req.user.toObject(), email, id: req.user.id },
            verificationToken
        );
    }

    // Update user
    const user = await User.findByIdAndUpdate(
        req.user.id,
        updates,
        { new: true, runValidators: true }
    );

    res.status(200).json({
        status: 'success',
        message: email && email !== req.user.email
            ? 'Profile updated successfully. Please verify your new email address.'
            : 'Profile updated successfully',
        data: {
            user
        }
    });
});

/**
 * @desc    Change password
 * @route   PATCH /api/users/change-password
 * @access  Private
 */
export const changePassword = asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    // Get user with password
    const user = await User.findById(req.user.id).select('+password');

    // Check if current password is correct
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
        return res.status(401).json({
            status: 'error',
            message: 'Current password is incorrect'
        });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.status(200).json({
        status: 'success',
        message: 'Password updated successfully'
    });
});

/**
 * @desc    Update user (admin)
 * @route   PATCH /api/users/:id
 * @access  Private/Admin
 */
export const updateUser = asyncHandler(async (req, res) => {
    const { name, email, role, subscription } = req.body;
    const updates = {};

    // Update name if provided
    if (name !== undefined) {
        updates.displayName = name;
    }

    // Update email if provided
    if (email) {
        // Check if email is already taken
        const existingUser = await User.findOne({ email, _id: { $ne: req.params.id } });
        if (existingUser) {
            return res.status(400).json({
                status: 'error',
                message: 'Email already in use'
            });
        }

        updates.email = email;
    }

    // Update role if provided
    if (role) {
        updates.role = role;
    }

    // Update subscription if provided
    if (subscription) {
        // Get current user to merge subscription data
        const currentUser = await User.findById(req.params.id);
        if (!currentUser) {
            return res.status(404).json({
                status: 'error',
                message: 'User not found'
            });
        }

        updates.subscription = {
            ...currentUser.subscription.toObject(),
            ...subscription
        };
    }

    // Update user
    const user = await User.findByIdAndUpdate(
        req.params.id,
        updates,
        { new: true, runValidators: true }
    );

    if (!user) {
        return res.status(404).json({
            status: 'error',
            message: 'User not found'
        });
    }

    res.status(200).json({
        status: 'success',
        message: 'User updated successfully',
        data: {
            user
        }
    });
});

/**
 * @desc    Delete user
 * @route   DELETE /api/users/:id
 * @access  Private/Admin
 */
export const deleteUser = asyncHandler(async (req, res) => {
    // Check if trying to delete self
    if (req.params.id === req.user.id) {
        return res.status(400).json({
            status: 'error',
            message: 'You cannot delete your own account'
        });
    }

    const user = await User.findByIdAndDelete(req.params.id);

    if (!user) {
        return res.status(404).json({
            status: 'error',
            message: 'User not found'
        });
    }

    res.status(200).json({
        status: 'success',
        message: 'User deleted successfully'
    });
});

export default {
    getAllUsers,
    getUserById,
    updateUserProfile,
    changePassword,
    updateUser,
    deleteUser
};