// routes/adminAnalyticsRoutes.js

import express from 'express';
import analyticsController from '../controllers/analyticsController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// Apply protection and admin authorization to all routes
router.use(protect);
router.use(authorize('admin'));

// Get analytics data (Aggregated)
router.get('/', analyticsController.getAnalytics);

// Granular Analytics Endpoints
router.get('/kpi', analyticsController.getAnalyticsKPIs);
router.get('/users', analyticsController.getAnalyticsUserGrowth);
router.get('/servers', analyticsController.getAnalyticsServerStatus);
router.get('/alerts', analyticsController.getAnalyticsAlerts);
router.get('/response-time', analyticsController.getAnalyticsResponseTime);

export default router;