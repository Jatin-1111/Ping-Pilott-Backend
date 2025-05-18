import express from 'express';
import { createAdmin, listAdmins, revokeAdmin, initialSetup } from '../controllers/adminController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// Public route for initial setup (first-time admin creation)
router.post('/initial-setup', initialSetup);

// Protected admin routes - use your existing middleware
router.post('/create', protect, authorize('admin'), createAdmin);
router.get('/list', protect, authorize('admin'), listAdmins);
router.patch('/revoke/:userId', protect, authorize('admin'), revokeAdmin);

export default router;