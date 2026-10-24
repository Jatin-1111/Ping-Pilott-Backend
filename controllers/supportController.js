// controllers/supportController.js
import SupportTicket from '../models/SupportTicket.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import logger from '../utils/logger.js';
import { sendSupportNotificationEmail, sendResponseNotificationEmail } from '../services/emailService.js';

/**
 * @desc    Create a new support ticket
 * @route   POST /api/support/tickets
 * @access  Private
 */
export const createTicket = asyncHandler(async (req, res) => {
    const { subject, description, category } = req.body;
    const userId = req.user.id;
    const userPlan = req.user.subscription?.plan || 'free';

    // Determine priority based on plan
    // Paid-support plans (Pro, Business) and admins are answered first
    const priority = /^(pro|business)_/.test(userPlan) || userPlan === 'admin' ? 'high' : 'medium';

    const ticket = await SupportTicket.create({
        userId,
        subject,
        description,
        category,
        userPlan,
        priority
    });

    // Send notification to admins
    try {
        await sendSupportNotificationEmail(ticket, req.user);
    } catch (error) {
        logger.error(`Failed to send support notification: ${error.message}`);
        // Continue with ticket creation even if email fails
    }

    res.status(201).json({
        status: 'success',
        message: 'Support ticket created successfully',
        data: {
            ticket
        }
    });
});

/**
 * @desc    Get user's tickets
 * @route   GET /api/support/tickets
 * @access  Private
 */
export const getUserTickets = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const status = req.query.status || 'all';

    const filter = { userId };
    if (status !== 'all') {
        filter.status = status;
    }

    const tickets = await SupportTicket.find(filter)
        .sort({ updatedAt: -1 })
        .lean();

    res.status(200).json({
        status: 'success',
        results: tickets.length,
        data: {
            tickets
        }
    });
});

/**
 * @desc    Get ticket by ID
 * @route   GET /api/support/tickets/:id
 * @access  Private
 */
export const getTicketById = asyncHandler(async (req, res) => {
    const ticketId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    const ticket = await SupportTicket.findById(ticketId);

    if (!ticket) {
        return res.status(404).json({
            status: 'error',
            message: 'Ticket not found'
        });
    }

    // Check if user is authorized
    if (ticket.userId !== userId && !isAdmin) {
        return res.status(403).json({
            status: 'error',
            message: 'Not authorized to access this ticket'
        });
    }

    res.status(200).json({
        status: 'success',
        data: {
            ticket
        }
    });
});

/**
 * @desc    Add response to ticket
 * @route   POST /api/support/tickets/:id/responses
 * @access  Private
 */
export const addResponse = asyncHandler(async (req, res) => {
    const { message } = req.body;
    const ticketId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    const ticket = await SupportTicket.findById(ticketId);

    if (!ticket) {
        return res.status(404).json({
            status: 'error',
            message: 'Ticket not found'
        });
    }

    // Check if user is authorized
    if (ticket.userId !== userId && !isAdmin) {
        return res.status(403).json({
            status: 'error',
            message: 'Not authorized to respond to this ticket'
        });
    }

    // A closed ticket takes no more replies from the customer (admins can still write, or reopen it)
    if (ticket.status === 'closed' && !isAdmin) {
        return res.status(400).json({
            status: 'error',
            message: 'This ticket is closed. Open a new ticket if you still need help.'
        });
    }

    // Add response
    ticket.responses.push({
        message,
        fromAdmin: isAdmin,
        createdAt: new Date()
    });

    // Update status: an admin reply starts work on an open ticket; a customer reply to a resolved
    // ticket means it was not resolved, so it goes back to the queue instead of staying hidden as "resolved"
    if (isAdmin && ticket.status === 'open') {
        ticket.status = 'in_progress';
    } else if (!isAdmin && ticket.status === 'resolved') {
        ticket.status = 'open';
    }

    await ticket.save();

    // Notify the other party
    try {
        if (isAdmin) {
            // Notify user of admin response
            await sendResponseNotificationEmail(ticket, await import('../models/User.js').then(m => m.default.findById(ticket.userId)), false);
        } else {
            // Notify admin of user response
            await sendResponseNotificationEmail(ticket, req.user, true);
        }
    } catch (error) {
        logger.error(`Failed to send response notification: ${error.message}`);
        // Continue even if notification fails
    }

    res.status(200).json({
        status: 'success',
        message: 'Response added successfully',
        data: {
            ticket
        }
    });
});

/**
 * @desc    Update ticket status (admin only)
 * @route   PATCH /api/support/tickets/:id/status
 * @access  Private/Admin
 */
export const updateTicketStatus = asyncHandler(async (req, res) => {
    const { status } = req.body;
    const ticketId = req.params.id;

    if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid status value'
        });
    }

    const ticket = await SupportTicket.findByIdAndUpdate(
        ticketId,
        { status },
        { new: true }
    );

    if (!ticket) {
        return res.status(404).json({
            status: 'error',
            message: 'Ticket not found'
        });
    }

    res.status(200).json({
        status: 'success',
        message: 'Ticket status updated successfully',
        data: {
            ticket
        }
    });
});

/**
 * @desc    Get all tickets (admin only)
 * @route   GET /api/support/admin/tickets
 * @access  Private/Admin
 */
export const getAllTickets = asyncHandler(async (req, res) => {
    const status = req.query.status || 'all';
    const priority = req.query.priority || 'all';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const filter = {};
    if (status !== 'all') {
        filter.status = status;
    }

    if (priority !== 'all') {
        filter.priority = priority;
    }

    // Get total count for pagination metadata
    const totalTickets = await SupportTicket.countDocuments(filter);
    const totalPages = Math.ceil(totalTickets / limit);

    // Most urgent first, then oldest first. Sorting the stored text would put "medium" and "low" before
    // "high" (alphabetical), so priority is ranked explicitly.
    const tickets = await SupportTicket.aggregate([
        { $match: filter },
        {
            $addFields: {
                priorityRank: {
                    $switch: {
                        branches: [
                            { case: { $eq: ['$priority', 'urgent'] }, then: 0 },
                            { case: { $eq: ['$priority', 'high'] }, then: 1 },
                            { case: { $eq: ['$priority', 'medium'] }, then: 2 }
                        ],
                        default: 3
                    }
                }
            }
        },
        { $sort: { priorityRank: 1, createdAt: 1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: { priorityRank: 0 } }
    ]);

    res.status(200).json({
        status: 'success',
        results: tickets.length,
        totalPages,
        currentPage: page,
        totalTickets,
        data: {
            tickets
        }
    });
});

export default {
    createTicket,
    getUserTickets,
    getTicketById,
    addResponse,
    updateTicketStatus,
    getAllTickets
};