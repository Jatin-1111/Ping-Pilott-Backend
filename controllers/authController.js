import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import User from '../models/User.js';
import logger from '../utils/logger.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/emailService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireEmailVerification } from '../utils/emailVerification.js';

// Generate JWT token
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '1d',
    });
};

// Generate refresh token
const generateRefreshToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, {
        expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    });
};

/**
 * @desc    Register a new user
 * @route   POST /api/auth/register
 * @access  Public
 */
export const register = asyncHandler(async (req, res) => {
    const { email, password, name } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        return res.status(400).json({
            status: 'error',
            message: 'Email already in use',
        });
    }

    const verificationRequired = requireEmailVerification();

    // Generate verification token
    const verificationToken = uuidv4();
    const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create user
    const user = await User.create({
        email,
        password,
        displayName: name || '',
        ...(verificationRequired ? { verificationToken, verificationTokenExpiry } : { emailVerified: true }),
    });

    if (!verificationRequired) {
        // No email step: the account is ready, so sign the new user in straight away
        const token = generateToken(user._id);
        const refreshToken = generateRefreshToken(user._id);
        user.password = undefined;

        return res.status(201).json({
            status: 'success',
            message: 'Account created.',
            data: {
                user,
                token,
                refreshToken,
            },
        });
    }

    // The account exists now, so answer straight away. A slow mail server must not keep the browser waiting,
    // and if the email fails the user can ask for a new link with "resend verification".
    sendVerificationEmail(user, verificationToken).catch((err) =>
        logger.error(`Verification email to ${user.email} failed: ${err?.message || err}`)
    );

    // Remove password from response
    user.password = undefined;

    res.status(201).json({
        status: 'success',
        message: 'User registered successfully. Please check your email to verify your account before logging in.',
        data: {
            user
        },
    });
});

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
export const login = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // Check if email and password are provided
    if (!email || !password) {
        return res.status(400).json({
            status: 'error',
            message: 'Please provide email and password',
        });
    }

    // Find user
    const user = await User.findOne({ email }).select('+password');

    // Check if user exists
    if (!user) {
        return res.status(401).json({
            status: 'error',
            message: 'Invalid credentials',
        });
    }

    // Check if password is correct
    const isPasswordCorrect = await user.comparePassword(password);
    if (!isPasswordCorrect) {
        return res.status(401).json({
            status: 'error',
            message: 'Invalid credentials',
        });
    }

    // Old passwords were hashed at a higher cost than we use now, which made every sign-in slow.
    // Re-hash in the background so the next one is quick.
    user.upgradePasswordHash(password);

    // Check if email is verified (only when verification is switched on)
    if (requireEmailVerification() && !user.emailVerified) {
        return res.status(401).json({
            status: 'error',
            code: 'email_not_verified',
            message: 'Please verify your email before logging in',
        });
    }

    // Generate tokens
    const token = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    // Remove password from response
    user.password = undefined;

    res.status(200).json({
        status: 'success',
        message: 'Logged in successfully',
        data: {
            user,
            token,
            refreshToken,
        },
    });
});

/**
 * @desc    Verify email
 * @route   GET /api/auth/verify-email
 * @access  Public
 */
export const verifyEmail = asyncHandler(async (req, res) => {
    const { token, userId } = req.query;

    // Check if token and userId are provided
    if (!token || !userId) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid verification link',
        });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
        return res.status(404).json({
            status: 'error',
            message: 'User not found',
        });
    }

    // Already confirmed (usually: an email security scanner opened the link first, then the person did).
    // Telling them "invalid link" for an account that is in fact verified would be wrong.
    if (user.emailVerified && !user.pendingEmail && !user.verificationToken) {
        return res.status(200).json({
            status: 'success',
            message: 'Email already verified',
        });
    }

    // Check if token matches
    if (user.verificationToken !== token) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid verification token',
        });
    }

    // Check if token has expired
    if (user.verificationTokenExpiry < Date.now()) {
        return res.status(400).json({
            status: 'error',
            message: 'Verification link has expired',
        });
    }

    // Confirming a changed address: only now does it replace the old one
    if (user.pendingEmail) {
        const taken = await User.findOne({ email: user.pendingEmail, _id: { $ne: user._id } });
        if (taken) {
            return res.status(400).json({
                status: 'error',
                message: 'That email address is now used by another account',
            });
        }
        user.email = user.pendingEmail;
        user.pendingEmail = undefined;
    }

    // Mark email as verified and clear verification token
    user.emailVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpiry = undefined;
    await user.save();

    res.status(200).json({
        status: 'success',
        message: 'Email verified successfully',
    });
});

/**
 * @desc    Resend verification email
 * @route   POST /api/auth/resend-verification
 * @access  Public
 */
export const resendVerification = asyncHandler(async (req, res) => {
    const { email } = req.body;

    // The answer is identical whether the address is unknown, already verified or pending. Different answers
    // let anyone test which email addresses have an account.
    const sameAnswer = () => res.status(200).json({
        status: 'success',
        message: 'If that account needs verification, we have sent a new link',
    });

    const user = await User.findOne({ email });
    if (!user || user.emailVerified) {
        return sameAnswer();
    }

    // Generate new verification token
    const verificationToken = uuidv4();
    const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Update user with new token
    user.verificationToken = verificationToken;
    user.verificationTokenExpiry = verificationTokenExpiry;
    await user.save();

    // Answer first; the email is sent in the background
    sendVerificationEmail(user, verificationToken).catch((err) =>
        logger.error(`Verification email to ${user.email} failed: ${err?.message || err}`)
    );

    return sameAnswer();
});

/**
 * @desc    Forgot password
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
export const forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
        // For security reasons, don't reveal if the email exists
        return res.status(200).json({
            status: 'success',
            message: 'If an account with that email exists, we have sent password reset instructions',
        });
    }

    // Generate reset token
    const resetToken = uuidv4();
    const resetTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Update user with reset token
    user.resetToken = resetToken;
    user.resetTokenExpiry = resetTokenExpiry;
    await user.save();

    // Send password reset email
    sendPasswordResetEmail(user, resetToken).catch((err) =>
        logger.error(`Password reset email to ${user.email} failed: ${err?.message || err}`)
    );

    res.status(200).json({
        status: 'success',
        message: 'If an account with that email exists, we have sent password reset instructions',
    });
});

/**
 * @desc    Reset password
 * @route   POST /api/auth/reset-password
 * @access  Public
 */
export const resetPassword = asyncHandler(async (req, res) => {
    const { token, userId, password } = req.body;

    // Check if token, userId and password are provided
    if (!token || !userId || !password) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid reset request',
        });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
        return res.status(404).json({
            status: 'error',
            message: 'Invalid reset link',
        });
    }

    // Check if token matches
    if (user.resetToken !== token) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid reset token',
        });
    }

    // Check if token has expired
    if (user.resetTokenExpiry < Date.now()) {
        return res.status(400).json({
            status: 'error',
            message: 'Reset link has expired',
        });
    }

    // Update password and clear reset token
    user.password = password;
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();

    res.status(200).json({
        status: 'success',
        message: 'Password reset successfully',
    });
});

/**
 * @desc    Refresh token
 * @route   POST /api/auth/refresh-token
 * @access  Public
 */
export const refreshToken = asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
        return res.status(400).json({
            status: 'error',
            message: 'Refresh token is required',
        });
    }

    try {
        // Verify refresh token
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

        // Find user
        const user = await User.findById(decoded.id);
        if (!user) {
            return res.status(401).json({
                status: 'error',
                message: 'Invalid refresh token',
            });
        }

        // Same rules as a normal request: unverified accounts and sessions older than a password change
        // cannot be extended
        const passwordChangedSession = user.passwordChangedAt &&
            decoded.iat < Math.floor(user.passwordChangedAt.getTime() / 1000);
        if ((requireEmailVerification() && !user.emailVerified) || passwordChangedSession) {
            return res.status(401).json({
                status: 'error',
                message: 'Invalid refresh token',
            });
        }

        // Generate new tokens
        const token = generateToken(user._id);
        const newRefreshToken = generateRefreshToken(user._id);

        res.status(200).json({
            status: 'success',
            message: 'Token refreshed successfully',
            data: {
                token,
                refreshToken: newRefreshToken,
            },
        });
    } catch (error) {
        logger.error(`Error refreshing token: ${error.message}`);

        return res.status(401).json({
            status: 'error',
            message: 'Invalid or expired refresh token',
        });
    }
});

/**
 * @desc    Get current user
 * @route   GET /api/auth/me
 * @access  Private
 */
export const getCurrentUser = asyncHandler(async (req, res) => {
    // protect already loaded this user for the request; asking the database again returned the same thing
    res.status(200).json({
        status: 'success',
        data: {
            user: req.user,
        },
    });
});

export default {
    register,
    login,
    verifyEmail,
    resendVerification,
    forgotPassword,
    resetPassword,
    refreshToken,
    getCurrentUser,
};