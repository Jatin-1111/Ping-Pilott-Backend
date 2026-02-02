// config/socket.js - Enhanced Socket.IO with room-based broadcasting

import { Server as SocketServer } from 'socket.io';
import logger from '../utils/logger.js';

let io;

/**
 * Initialize Socket.IO with room-based broadcasting support
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

    io.on('connection', (socket) => {
        logger.info(`Client connected: ${socket.id}`);

        // Subscribe to specific server updates
        socket.on('subscribe-server', (serverId) => {
            socket.join(`server:${serverId}`);
            logger.debug(`Client ${socket.id} subscribed to server:${serverId}`);
        });

        // Unsubscribe from server updates
        socket.on('unsubscribe-server', (serverId) => {
            socket.leave(`server:${serverId}`);
            logger.debug(`Client ${socket.id} unsubscribed from server:${serverId}`);
        });

        // Subscribe to user-specific updates
        socket.on('subscribe-user', (userId) => {
            socket.join(`user:${userId}`);
            logger.debug(`Client ${socket.id} subscribed to user:${userId}`);
        });

        // Unsubscribe from user updates
        socket.on('unsubscribe-user', (userId) => {
            socket.leave(`user:${userId}`);
            logger.debug(`Client ${socket.id} unsubscribed from user:${userId}`);
        });

        socket.on('disconnect', (reason) => {
            logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
        });

        socket.on('error', (error) => {
            logger.error(`Socket error for ${socket.id}:`, error);
        });
    });

    logger.info('✅ Socket.IO initialized with room-based broadcasting');
    return io;
}

/**
 * Broadcast server update to interested clients only
 * @param {Object} updateData - Server update data
 */
export function broadcastServerUpdate(updateData) {
    if (!io) {
        logger.warn('Socket.IO not initialized, cannot broadcast update');
        return;
    }

    const { serverId, userId } = updateData;

    // Broadcast to specific server room
    if (serverId) {
        io.to(`server:${serverId}`).emit('server-update', updateData);
    }

    // Broadcast to user room
    if (userId) {
        io.to(`user:${userId}`).emit('server-update', updateData);
    }

    logger.debug(`Broadcasted update for server ${serverId} to targeted rooms`);
}

/**
 * Broadcast global notification (admin alerts, system messages)
 * @param {string} event - Event name
 * @param {Object} data - Event data
 */
export function broadcastGlobal(event, data) {
    if (!io) {
        logger.warn('Socket.IO not initialized, cannot broadcast global event');
        return;
    }

    io.emit(event, data);
    logger.debug(`Broadcasted global event: ${event}`);
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
