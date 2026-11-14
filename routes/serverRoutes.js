import express from 'express';
import { body, param, query } from 'express-validator';
import serverController from '../controllers/serverController.js';
import { protect, authorize } from '../middleware/auth.js';
import validate from '../middleware/validator.js';
import hostAgentController from '../controllers/hostAgentController.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// Apply protection to all routes
router.use(protect);

// Get all servers
router.get('/', serverController.getServers);

// Create new server (the body is validated by the Zod schema in the controller, see the note on PATCH below)
router.post('/', serverController.createServer);

// Host agent: turn it on (the token is in this response only), replace the token, turn it off
router.post('/:id/agent', [param('id').isMongoId().withMessage('Invalid server ID'), validate], asyncHandler(hostAgentController.enable));
router.post('/:id/agent/rotate', [param('id').isMongoId().withMessage('Invalid server ID'), validate], asyncHandler(hostAgentController.rotate));
router.delete('/:id/agent', [param('id').isMongoId().withMessage('Invalid server ID'), validate], asyncHandler(hostAgentController.disable));

router.get('/:id/metrics', [param('id').isMongoId().withMessage('Invalid server ID'), validate], asyncHandler(hostAgentController.metrics));

// Get server by ID
router.get('/:id', [
    param('id').isMongoId().withMessage('Invalid server ID'),
    validate
], serverController.getServerById);

// Update server. The body is validated by the Zod schema in the controller (utils/validations.js), the one place the rules
// live: this route used to repeat them with express-validator, with different phone and threshold rules, and its trim()
// turned a number into a string before the schema saw it.
router.patch('/:id', [
    param('id').isMongoId().withMessage('Invalid server ID'),
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

// Batch check servers
router.post('/batch-check', [
    body('serverIds').isArray({ min: 1, max: 10 }).withMessage('Server IDs array required (1-10 items)'),
    body('serverIds.*').isMongoId().withMessage('Invalid server ID'),
    validate
], serverController.batchCheckServers);

export default router;