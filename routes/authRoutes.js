import express from 'express';
import { body } from 'express-validator';
import authController from '../controllers/authController.js';
import { protect } from '../middleware/auth.js';
import validate from '../middleware/validator.js';

const router = express.Router();

// Registration and login routes
router.post('/register', [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
    validate
], authController.register);

router.post('/login', [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').exists().withMessage('Password is required'),
    validate
], authController.login);

// Email verification routes
router.get('/verify-email', authController.verifyEmail);
router.post('/resend-verification', [
    body('email').isEmail().withMessage('Please provide a valid email'),
    validate
], authController.resendVerification);

// Password reset routes
router.post('/forgot-password', [
    body('email').isEmail().withMessage('Please provide a valid email'),
    validate
], authController.forgotPassword);

router.post('/reset-password', [
    body('token').exists().withMessage('Token is required'),
    body('userId').exists().withMessage('User ID is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
    validate
], authController.resetPassword);

// Token refresh route
router.post('/refresh-token', [
    body('refreshToken').exists().withMessage('Refresh token is required'),
    validate
], authController.refreshToken);

// Get current user - protected route
router.get('/me', protect, authController.getCurrentUser);

export default router;