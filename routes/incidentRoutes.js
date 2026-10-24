import express from 'express';
import { query } from 'express-validator';
import incidentController from '../controllers/incidentController.js';
import { protect } from '../middleware/auth.js';
import validate from '../middleware/validator.js';

const router = express.Router();

router.use(protect);

// Incidents across the user's servers
router.get('/', [
    query('status').optional().isIn(['all', 'ongoing', 'resolved']).withMessage('Status must be all, ongoing or resolved'),
    query('days').optional().isIn(['7', '30']).withMessage('Days must be 7 or 30'),
    query('serverId').optional().isMongoId().withMessage('Invalid server ID'),
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be 1 or more'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
    validate
], incidentController.getIncidents);

export default router;
