// routes/supportRoutes.js
import express from 'express';
import supportController from '../controllers/supportController.js';
import { protect, authorize } from '../middleware/auth.js';
import { body } from 'express-validator';
import validate from '../middleware/validator.js';
import { supportTicketLimiter, supportReplyLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// Apply protection to all routes
router.use(protect);

// User routes. The per-user limits come after protect (they key on the signed-in user); every ticket and reply e-mails someone.
router.post('/tickets', supportTicketLimiter, [
    body('subject').trim().not().isEmpty().withMessage('Subject is required')
        .isLength({ max: 200 }).withMessage('Subject must be at most 200 characters'),
    body('description').trim().not().isEmpty().withMessage('Description is required')
        .isLength({ max: 5000 }).withMessage('Description must be at most 5000 characters'),
    body('category').optional().isIn(['technical', 'billing', 'feature_request', 'general']).withMessage('Invalid category'),
    validate
], supportController.createTicket);

router.get('/tickets', supportController.getUserTickets);
router.get('/tickets/:id', supportController.getTicketById);
router.post('/tickets/:id/responses', supportReplyLimiter, [
    body('message').trim().not().isEmpty().withMessage('Message is required')
        .isLength({ max: 5000 }).withMessage('Message must be at most 5000 characters'),
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