// config/socket.js - Socket.IO with authenticated, room-based live updates
//
// Every connection must present a valid access token. A client is put in its own `user:<id>` room
// automatically and receives updates for its own servers only; admins also join `admins` to see everything.
// Nothing about who may hear what is decided by the client: the earlier version let any visitor join
// `user:<anyone>` or `server:<anyone>` and read that account's live status.

import { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Server from '../models/Server.js';
import logger from '../utils/logger.js';

let io;

/**
 * Initialize Socket.IO
 * @param {http.Server} httpServer - HTTP server instance
 * @returns {SocketServer} Socket.IO server instance
 */
export function initializeSocket(httpServer) {
    io = new SocketServer(httpServer, {
        cors: {
            origin: process.env.CLIENT_URL || 'http://localhost:3000',
            methods: ['GET', 'POST'],
            credentials: true
        },
        pingTimeout: 60000,
        pingInterval: 25000
    });

    // Authenticate before the connection is accepted
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (!token) return next(new Error('Not authorized'));

            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await User.findById(decoded.id).select('role emailVerified');
            if (!user || !user.emailVerified) return next(new Error('Not authorized'));

            socket.data.userId = String(user._id);
            socket.data.role = user.role;
            next();
        } catch (error) {
            next(new Error('Not authorized'));
        }
    });

    io.on('connection', (socket) => {
        const { userId, role } = socket.data;
        logger.info(`Client connected: ${socket.id} (user ${userId})`);

        socket.join(`user:${userId}`);
        if (role === 'admin') socket.join('admins');

        // Optional: follow one server's room. Only for servers the user owns (admins: any).
        socket.on('subscribe-server', async (serverId) => {
            try {
                if (!mongoose.Types.ObjectId.isValid(serverId)) return;
                const server = await Server.findById(serverId).select('uploadedBy').lean();
                if (server && (role === 'admin' || String(server.uploadedBy) === userId)) {
                    socket.join(`server:${serverId}`);
                }
            } catch (error) {
                logger.error(`subscribe-server failed for ${socket.id}: ${error.message}`);
            }
        });

        socket.on('unsubscribe-server', (serverId) => {
            socket.leave(`server:${serverId}`);
        });

        socket.on('disconnect', (reason) => {
            logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
        });

        socket.on('error', (error) => {
            logger.error(`Socket error for ${socket.id}:`, error);
        });
    });

    logger.info('✅ Socket.IO initialized with authenticated room-based broadcasting');
    return io;
}

/**
 * Send a server's new status to the people who may see it: its owner, anyone following that server's
 * room, and admins. Chaining the rooms in one call delivers once per socket even if it is in several.
 * The event is named `server:update`, which is what the dashboard listens for.
 * @param {Object} updateData - { serverId, userId, status, latency, error, lastChecked }
 */
export function broadcastServerUpdate(updateData) {
    if (!io) {
        logger.warn('Socket.IO not initialized, cannot broadcast update');
        return;
    }

    const { serverId, userId } = updateData;
    const rooms = ['admins'];
    if (userId) rooms.push(`user:${userId}`);
    if (serverId) rooms.push(`server:${serverId}`);

    io.to(rooms).emit('server:update', updateData);
}

/**
 * Broadcast global notification (admin alerts, system messages) to every authenticated client
 * @param {string} event - Event name
 * @param {Object} data - Event data
 */
export function broadcastGlobal(event, data) {
    if (!io) {
        logger.warn('Socket.IO not initialized, cannot broadcast global event');
        return;
    }

    io.emit(event, data);
}

/**
 * Get Socket.IO instance
 * @returns {SocketServer} Socket.IO server instance
 */
export function getIO() {
    if (!io) {
        throw new Error('Socket.IO not initialized');
    }
    return io;
}

export default { initializeSocket, broadcastServerUpdate, broadcastGlobal, getIO };
