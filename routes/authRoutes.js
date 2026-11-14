import express from 'express';
import { body } from 'express-validator';
import authController from '../controllers/authController.js';
import { protect } from '../middleware/auth.js';
import validate from '../middleware/validator.js';
import {
    authLimiter, emailLimiter, tokenLimiter, registerLimiter, loginIpLimiter, loginFailureIpLimiter, loginFailureAccountLimiter
} from '../middleware/rateLimiter.js';

const router = express.Router();

// Registration and login routes. registerLimiter and loginIpLimiter count every attempt from an address (each one costs
// a password hash); authLimiter counts only failures, per address and email.
router.post('/register', registerLimiter, authLimiter, [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
    validate
], authController.register);

router.post('/login', loginIpLimiter, loginFailureIpLimiter, authLimiter, loginFailureAccountLimiter, [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').exists().withMessage('Password is required'),
    validate
], authController.login);

// Email verification routes
router.get('/verify-email', tokenLimiter, authController.verifyEmail); // links e-mailed before the POST form existed
router.post('/verify-email', tokenLimiter, authController.verifyEmail);
router.post('/resend-verification', emailLimiter, [
    body('email').isEmail().withMessage('Please provide a valid email'),
    validate
], authController.resendVerification);

// Password reset routes
router.post('/forgot-password', emailLimiter, [
    body('email').isEmail().withMessage('Please provide a valid email'),
    validate
], authController.forgotPassword);

router.post('/reset-password', tokenLimiter, [
    body('token').exists().withMessage('Token is required'),
    body('userId').exists().withMessage('User ID is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
    validate
], authController.resetPassword);

// Token refresh route
router.post('/refresh-token', tokenLimiter, [
    body('refreshToken').exists().withMessage('Refresh token is required'),
    validate
], authController.refreshToken);

// Sign out this device (the refresh token is the credential, so this works after the access token expired), or every device
router.post('/logout', tokenLimiter, authController.logout);
router.post('/logout-all', protect, authController.logoutAll);

// Get current user - protected route
router.get('/me', protect, authController.getCurrentUser);

export default router;