
import { Server } from 'socket.io';
import logger from '../utils/logger.js';

let io;

export const initializeSocket = (httpServer) => {
    io = new Server(httpServer, {
        cors: {
            origin: process.env.CLIENT_URL || 'http://localhost:3000',
            methods: ['GET', 'POST'],
            credentials: true
        },
        transports: ['websocket', 'polling'], // Support both transports
        pingTimeout: 60000,
        pingInterval: 25000
    });

    io.on('connection', (socket) => {
        logger.info(`🔌 Socket connected: ${socket.id}`);

        socket.on('disconnect', () => {
            logger.info(`❌ Socket disconnected: ${socket.id}`);
        });

        socket.on('error', (error) => {
            logger.error(`⚠️ Socket error for ${socket.id}:`, error);
        });
    });

    logger.info('✅ Socket.io initialized successfully');
    return io;
};

export const getIO = () => {
    if (!io) {
        throw new Error('Socket.io not initialized!');
    }
    return io;
};

// Helper for broadcasting updates
export const broadcastServerUpdate = (data) => {
    if (io) {
        io.emit('server:update', data);
    }
};
