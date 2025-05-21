// routes/adminAnalyticsRoutes.js

import express from 'express';
import analyticsController from '../controllers/analyticsController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// Apply protection and admin authorization to all routes
router.use(protect);
router.use(authorize('admin'));

// Get analytics data
router.get('/', analyticsController.getAnalytics);

export default router;