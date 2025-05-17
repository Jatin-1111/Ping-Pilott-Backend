import express from 'express';
import { body, param, query } from 'express-validator';
import serverController from '../controllers/serverController.js';
import { protect, authorize } from '../middleware/auth.js';
import validate from '../middleware/validator.js';

const router = express.Router();

// Apply protection to all routes
router.use(protect);

// Get all servers
router.get('/', serverController.getServers);

// Create new server
router.post('/', [
    body('name').trim().not().isEmpty().withMessage('Server name is required'),
    body('url').trim().not().isEmpty().withMessage('URL is required'),
    body('type').optional().isIn(['website', 'api', 'tcp', 'database']).withMessage('Invalid server type'),
    body('description').optional().trim(),
    body('monitoring').optional().isObject().withMessage('Monitoring must be an object'),
    body('monitoring.frequency').optional().isInt({ min: 1, max: 60 }).withMessage('Frequency must be between 1 and 60 minutes'),
    body('monitoring.daysOfWeek').optional().isArray().withMessage('Days of week must be an array'),
    body('monitoring.daysOfWeek.*').optional().isInt({ min: 0, max: 7 }).withMessage('Days must be between 0 and 7'),
    body('monitoring.timeWindows').optional().isArray().withMessage('Time windows must be an array'),
    body('monitoring.timeWindows.*.start').optional().matches(/^([01]\d|2[0-3]):([0-5]\d)$/).withMessage('Start time must be in format HH:MM'),
    body('monitoring.timeWindows.*.end').optional().matches(/^([01]\d|2[0-3]):([0-5]\d)$/).withMessage('End time must be in format HH:MM'),
    body('monitoring.alerts').optional().isObject().withMessage('Alerts must be an object'),
    body('monitoring.alerts.enabled').optional().isBoolean().withMessage('Enabled must be a boolean'),
    body('monitoring.alerts.email').optional().isBoolean().withMessage('Email alert must be a boolean'),
    body('monitoring.alerts.phone').optional().isBoolean().withMessage('Phone alert must be a boolean'),
    body('monitoring.alerts.responseThreshold').optional().isInt({ min: 100 }).withMessage('Response threshold must be at least 100ms'),
    body('contactEmails').optional().isArray().withMessage('Contact emails must be an array'),
    body('contactEmails.*').optional().isEmail().withMessage('Invalid email format'),
    body('contactPhones').optional().isArray().withMessage('Contact phones must be an array'),
    body('contactPhones.*').optional().matches(/^\d{10}$/).withMessage('Phone must be 10 digits'),
    validate
], serverController.createServer);

// Get server by ID
router.get('/:id', [
    param('id').isMongoId().withMessage('Invalid server ID'),
    validate
], serverController.getServerById);

// Update server
router.patch('/:id', [
    param('id').isMongoId().withMessage('Invalid server ID'),
    body('name').optional().trim().not().isEmpty().withMessage('Server name cannot be empty'),
    body('url').optional().trim().not().isEmpty().withMessage('URL cannot be empty'),
    body('type').optional().isIn(['website', 'api', 'tcp', 'database']).withMessage('Invalid server type'),
    body('description').optional().trim(),
    body('monitoring').optional().isObject().withMessage('Monitoring must be an object'),
    body('monitoring.frequency').optional().isInt({ min: 1, max: 60 }).withMessage('Frequency must be between 1 and 60 minutes'),
    body('monitoring.daysOfWeek').optional().isArray().withMessage('Days of week must be an array'),
    body('monitoring.daysOfWeek.*').optional().isInt({ min: 0, max: 7 }).withMessage('Days must be between 0 and 7'),
    body('monitoring.timeWindows').optional().isArray().withMessage('Time windows must be an array'),
    body('monitoring.timeWindows.*.start').optional().matches(/^([01]\d|2[0-3]):([0-5]\d)$/).withMessage('Start time must be in format HH:MM'),
    body('monitoring.timeWindows.*.end').optional().matches(/^([01]\d|2[0-3]):([0-5]\d)$/).withMessage('End time must be in format HH:MM'),
    body('monitoring.alerts').optional().isObject().withMessage('Alerts must be an object'),
    body('monitoring.alerts.enabled').optional().isBoolean().withMessage('Enabled must be a boolean'),
    body('monitoring.alerts.email').optional().isBoolean().withMessage('Email alert must be a boolean'),
    body('monitoring.alerts.phone').optional().isBoolean().withMessage('Phone alert must be a boolean'),
    body('monitoring.alerts.responseThreshold').optional().isInt({ min: 100 }).withMessage('Response threshold must be at least 100ms'),
    body('contactEmails').optional().isArray().withMessage('Contact emails must be an array'),
    body('contactEmails.*').optional().isEmail().withMessage('Invalid email format'),
    body('contactPhones').optional().isArray().withMessage('Contact phones must be an array'),
    body('contactPhones.*').optional().matches(/^\d{10}$/).withMessage('Phone must be 10 digits'),
    validate
], serverController.updateServer);

// Delete server
router.delete('/:id', [
    param('id').isMongoId().withMessage('Invalid server ID'),
    validate
], serverController.deleteServer);

// Manually check server
router.post('/:id/check', [
    param('id').isMongoId().withMessage('Invalid server ID'),
    validate
], serverController.checkServer);

// Get server history
router.get('/:id/history', [
    param('id').isMongoId().withMessage('Invalid server ID'),
    query('period').optional().isIn(['1h', '6h', '12h', '24h', '7d', '30d']).withMessage('Invalid period'),
    validate
], serverController.getServerHistory);

export default router;