import express from 'express';
import { param, query } from 'express-validator';
import alertController from '../controllers/alertController.js';
import { protect } from '../middleware/auth.js';
import validate from '../middleware/validator.js';

const router = express.Router();

router.use(protect);

// The user's alerts, for the mobile app's Alerts tab and its catch-up after being offline
router.get('/', [
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
    query('after').optional().isMongoId().withMessage('Invalid alert ID'),
    query('before').optional().isMongoId().withMessage('Invalid alert ID'),
    validate
], alertController.getAlerts);

// Declared before '/:id/read' so "read-all" is never taken for an id
router.post('/read-all', alertController.markAllAlertsRead);

router.patch('/:id/read', [
    param('id').isMongoId().withMessage('Invalid alert ID'),
    validate
], alertController.markAlertRead);

export default router;
