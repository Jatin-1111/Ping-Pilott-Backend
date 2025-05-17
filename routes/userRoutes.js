import express from 'express';
import { body, param } from 'express-validator';
import userController from '../controllers/userController.js';
import { protect, authorize } from '../middleware/auth.js';
import validate from '../middleware/validator.js';

const router = express.Router();

// Apply protection to all routes
router.use(protect);

// Routes accessible by all authenticated users
router.patch('/me', [
    body('name').optional().trim(),
    body('email').optional().isEmail().withMessage('Please provide a valid email'),
    validate
], userController.updateUserProfile);

router.patch('/change-password', [
    body('currentPassword').exists().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters long'),
    validate
], userController.changePassword);

// Admin only routes
router.use(authorize('admin'));

router.get('/', userController.getAllUsers);

router.get('/:id', [
    param('id').isMongoId().withMessage('Invalid user ID'),
    validate
], userController.getUserById);

router.patch('/:id', [
    param('id').isMongoId().withMessage('Invalid user ID'),
    body('name').optional().trim(),
    body('email').optional().isEmail().withMessage('Please provide a valid email'),
    body('role').optional().isIn(['user', 'admin']).withMessage('Invalid role'),
    body('subscription').optional().isObject().withMessage('Subscription must be an object'),
    body('subscription.plan').optional().isIn(['free', 'monthly', 'halfYearly', 'yearly', 'admin']).withMessage('Invalid subscription plan'),
    validate
], userController.updateUser);

router.delete('/:id', [
    param('id').isMongoId().withMessage('Invalid user ID'),
    validate
], userController.deleteUser);

export default router;