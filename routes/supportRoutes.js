// routes/supportRoutes.js
import express from 'express';
import supportController from '../controllers/supportController.js';
import { protect, authorize } from '../middleware/auth.js';
import { body } from 'express-validator';
import validate from '../middleware/validator.js';

const router = express.Router();

// Apply protection to all routes
router.use(protect);

// User routes
router.post('/tickets', [
    body('subject').trim().not().isEmpty().withMessage('Subject is required'),
    body('description').trim().not().isEmpty().withMessage('Description is required'),
    body('category').optional().isIn(['technical', 'billing', 'feature_request', 'general']).withMessage('Invalid category'),
    validate
], supportController.createTicket);

router.get('/tickets', supportController.getUserTickets);
router.get('/tickets/:id', supportController.getTicketById);
router.post('/tickets/:id/responses', [
    body('message').trim().not().isEmpty().withMessage('Message is required'),
    validate
], supportController.addResponse);

// Admin routes
router.use('/admin', authorize('admin'));
router.get('/admin/tickets', supportController.getAllTickets);
router.patch('/admin/tickets/:id/status', [
    body('status').isIn(['open', 'in_progress', 'resolved', 'closed']).withMessage('Invalid status'),
    validate
], supportController.updateTicketStatus);

export default router;