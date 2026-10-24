import User from '../models/User.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendVerificationEmail } from '../services/emailService.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { applyPlanChange } from '../services/planService.js';
import { purgeUserData } from '../services/accountCleanup.js';

/**
 * @desc    Get all users
 * @route   GET /api/users
 * @access  Private/Admin
 */
export const getAllUsers = asyncHandler(async (req, res) => {
    // Apply pagination
    // Bounded: an unbounded `limit` lets one request pull the whole collection
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    // Apply search filter if provided
    const filter = {};
    if (req.query.search) {
        // Escaped: search text is literal text. Unescaped, "(" crashed the query and a crafted pattern could hang it.
        const escaped = String(req.query.search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const searchRegex = new RegExp(escaped, 'i');
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

    // A new email address is kept aside until it is confirmed. (Before, the account was switched to the
    // new address and marked unverified at once: every request then failed, and a typo meant being locked
    // out of an account with no valid address on it.)
    let emailChangePending = false;
    if (email && email.toLowerCase().trim() !== req.user.email) {
        const wanted = email.toLowerCase().trim();
        const existingUser = await User.findOne({ email: wanted });
        if (existingUser) {
            return res.status(400).json({
                status: 'error',
                message: 'Email already in use'
            });
        }

        const verificationToken = uuidv4();
        updates.pendingEmail = wanted;
        updates.verificationToken = verificationToken;
        updates.verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
        emailChangePending = true;

        // The link goes to the NEW address, which is what proves it belongs to this person
        await sendVerificationEmail(
            { ...req.user.toObject(), email: wanted, id: req.user.id },
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
        message: emailChangePending
            ? 'Profile updated. Check your new email address and open the link to confirm the change.'
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
 * @desc    Delete own account
 * @route   DELETE /api/users/me
 * @access  Private
 */
export const deleteMyAccount = asyncHandler(async (req, res) => {
    // A stolen access token must not be enough to destroy an account: ask for the password again
    const { password } = req.body || {};
    const current = await User.findById(req.user.id).select('+password');
    if (!password || !current || !(await current.comparePassword(password))) {
        return res.status(401).json({
            status: 'error',
            message: 'Enter your current password to delete your account'
        });
    }

    // Servers first (that stops the checks and the emails), then the account itself
    const { servers } = await purgeUserData(current._id);
    const user = await User.findByIdAndDelete(current._id);

    if (!user) {
        return res.status(404).json({
            status: 'error',
            message: 'User not found'
        });
    }

    logger.info(`User deleted own account: ${user.email} (${user._id}), ${servers} server(s) removed`);

    res.status(200).json({
        status: 'success',
        message: 'Your account has been successfully deleted'
    });
});

/**
 * @desc    Update user (admin)
 * @route   PATCH /api/users/:id
 * @access  Private/Admin
 */
export const updateUser = asyncHandler(async (req, res) => {
    const { name, email, role, subscription } = req.body;

    // Load the document and save() it, instead of findByIdAndUpdate: only save() runs the model hooks that
    // keep an admin's plan and a plan's feature limits consistent with the role/plan that was just set.
    const user = await User.findById(req.params.id);
    if (!user) {
        return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    if (name !== undefined) user.displayName = name;

    if (email && email.toLowerCase() !== user.email) {
        const existingUser = await User.findOne({ email, _id: { $ne: user._id } });
        if (existingUser) {
            return res.status(400).json({ status: 'error', message: 'Email already in use' });
        }
        user.email = email;
    }

    if (role && role !== user.role) {
        // An admin who demotes themselves locks themselves out of the admin area
        if (String(user._id) === String(req.user._id) && role !== 'admin') {
            return res.status(400).json({ status: 'error', message: 'You cannot remove your own admin access' });
        }
        const wasAdmin = user.role === 'admin';
        user.role = role;
        if (wasAdmin && role !== 'admin') {
            // Back to a normal account: the unlimited admin plan does not carry over
            await applyPlanChange(user, 'free');
        }
    }

    if (subscription?.plan) {
        await applyPlanChange(user, subscription.plan, {
            status: subscription.status,
            endDate: subscription.endDate
        });
    } else {
        if (subscription?.status) user.subscription.status = subscription.status;
        if (subscription?.endDate !== undefined) user.subscription.endDate = subscription.endDate;
        await user.save();
    }

    res.status(200).json({
        status: 'success',
        message: 'User updated successfully',
        data: { user }
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

    // Their servers must not keep being checked (and emailed about) after the account is gone
    const { servers } = await purgeUserData(user._id);
    logger.info(`Admin ${req.user.email} deleted user ${user.email} and ${servers} server(s)`);

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
    updateUser,
    deleteUser,
    deleteMyAccount
};