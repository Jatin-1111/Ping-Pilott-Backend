
import { Server } from 'socket.io';
import logger from '../utils/logger.js';

let io;

export const initializeSocket = (httpServer) => {
    io = new Server(httpServer, {
        cors: {
            origin: process.env.CLIENT_URL || '*', // Allow all in dev/production if not strictly set
            methods: ['GET', 'POST']
        }
    });

    io.on('connection', (socket) => {
        logger.info(`🔌 Socket connected: ${socket.id}`);

        socket.on('disconnect', () => {
            logger.info(`❌ Socket disconnected: ${socket.id}`);
        });
    });

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
