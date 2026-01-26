import User from '../models/User.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import logger from '../utils/logger.js';

/**
 * @desc    Create or promote a user to admin
 * @route   POST /api/admin/create
 * @access  Private/Admin
 */
export const createAdmin = asyncHandler(async (req, res) => {
    const { email, password, displayName, existingUserId } = req.body;

    let adminUser;

    // If existingUserId is provided, promote existing user to admin
    if (existingUserId) {
        // Find the existing user
        const existingUser = await User.findById(existingUserId);

        if (!existingUser) {
            return res.status(404).json({
                status: 'error',
                message: 'User not found',
            });
        }

        // Update user to admin role
        existingUser.role = 'admin';
        existingUser.emailVerified = true; // Admins must be verified

        // Subscription details will be auto-set by the model pre-save hook
        // but explicit setting here acts as a double-check/override
        existingUser.subscription.plan = 'admin';
        existingUser.subscription.status = 'unlimited';

        // Save the updated user - model hooks will populate 'subscription.features'
        adminUser = await existingUser.save();

        logger.info(`User ${existingUser.email} promoted to admin by ${req.user.email}`);
    }
    // Create a new admin user if existingUserId is not provided
    else {
        // Check if required fields are provided
        if (!email || !password) {
            return res.status(400).json({
                status: 'error',
                message: 'Email and password are required to create a new admin',
            });
        }

        // Check if user with this email already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({
                status: 'error',
                message: 'Email already in use. If you want to promote this user, use the existingUserId parameter.',
            });
        }

        // Create new admin user
        adminUser = await User.create({
            email,
            password,
            displayName: displayName || '',
            role: 'admin',
            emailVerified: true, // Auto-verify admin accounts
            subscription: {
                plan: 'admin',
                status: 'unlimited'
                // Features auto-set by model hook
            }
        });

        logger.info(`New admin user ${email} created by ${req.user.email}`);
    }

    // Remove password from response
    adminUser.password = undefined;

    res.status(201).json({
        status: 'success',
        message: existingUserId ? 'User promoted to admin successfully' : 'Admin user created successfully',
        data: {
            user: adminUser,
        },
    });
});

/**
 * @desc    Get all admin users
 * @route   GET /api/admin/list
 * @access  Private/Admin
 */
export const listAdmins = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Get total count
    const totalAdmins = await User.countDocuments({ role: 'admin' });
    const totalPages = Math.ceil(totalAdmins / limit);

    // Find admin users with pagination
    const admins = await User.find({ role: 'admin' })
        .select('-password')
        .skip(skip)
        .limit(limit);

    res.status(200).json({
        status: 'success',
        results: admins.length,
        totalPages,
        currentPage: page,
        totalAdmins,
        data: {
            admins,
        },
    });
});

/**
 * @desc    Revoke admin privileges
 * @route   PATCH /api/admin/revoke/:userId
 * @access  Private/Admin
 */
export const revokeAdmin = asyncHandler(async (req, res) => {
    const { userId } = req.params;

    // Prevent self-demotion
    if (userId === req.user.id) {
        return res.status(400).json({
            status: 'error',
            message: 'You cannot revoke your own admin privileges',
        });
    }

    // Find the admin user
    const adminUser = await User.findById(userId);

    if (!adminUser) {
        return res.status(404).json({
            status: 'error',
            message: 'User not found',
        });
    }

    if (adminUser.role !== 'admin') {
        return res.status(400).json({
            status: 'error',
            message: 'This user is not an admin',
        });
    }

    // Downgrade to regular user
    adminUser.role = 'user';

    // Update subscription to free plan
    adminUser.subscription.plan = 'free';
    adminUser.subscription.status = 'trial';
    adminUser.subscription.features.maxServers = 1;
    adminUser.subscription.features.minCheckFrequency = 5;
    adminUser.subscription.features.maxCheckFrequency = 30;
    adminUser.subscription.features.advancedAlerts = false;
    adminUser.subscription.features.apiAccess = false;
    adminUser.subscription.features.prioritySupport = false;
    adminUser.subscription.features.webhookIntegrations = false;
    adminUser.subscription.features.historicalReporting = false;
    adminUser.subscription.features.unlimitedMonitoring = false;

    // Save the updated user
    await adminUser.save();

    logger.info(`Admin privileges revoked from ${adminUser.email} by ${req.user.email}`);

    res.status(200).json({
        status: 'success',
        message: 'Admin privileges revoked successfully',
        data: {
            user: adminUser,
        },
    });
});

/**
 * @desc    Create initial admin (first-time setup)
 * @route   POST /api/admin/initial-setup
 * @access  Public (one-time use)
 */
export const initialSetup = asyncHandler(async (req, res) => {
    const { email, password, displayName, setupToken } = req.body;

    // Verify setup token (should match environment variable)
    if (!setupToken || setupToken !== process.env.ADMIN_SETUP_TOKEN) {
        return res.status(401).json({
            status: 'error',
            message: 'Invalid setup token',
        });
    }

    // Check if any admin already exists
    const existingAdmin = await User.findOne({ role: 'admin' });
    if (existingAdmin) {
        return res.status(400).json({
            status: 'error',
            message: 'Initial setup has already been completed',
        });
    }

    // Check if required fields are provided
    if (!email || !password) {
        return res.status(400).json({
            status: 'error',
            message: 'Email and password are required',
        });
    }

    // Check if user with this email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        return res.status(400).json({
            status: 'error',
            message: 'Email already in use',
        });
    }

    // Create the first admin user
    const adminUser = await User.create({
        email,
        password,
        displayName: displayName || '',
        role: 'admin',
        emailVerified: true, // Auto-verify admin accounts
        subscription: {
            plan: 'admin',
            status: 'unlimited'
            // Features auto-set by model hook
        }
    });

    // Remove password from response
    adminUser.password = undefined;

    logger.info(`Initial admin user ${email} created during system setup`);

    res.status(201).json({
        status: 'success',
        message: 'Initial admin setup completed successfully',
        data: {
            user: adminUser,
        },
    });
});

export default {
    createAdmin,
    listAdmins,
    revokeAdmin,
    initialSetup,
};