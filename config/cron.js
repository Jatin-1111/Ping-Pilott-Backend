import cron from 'node-cron';
import logger from '../utils/logger.js';

/**
 * Cron expressions for different job frequencies
 */
export const cronExpressions = {
    // Time-based schedules
    everyMinute: '* * * * *',
    every5Minutes: '*/5 * * * *',
    every15Minutes: '*/15 * * * *',
    every30Minutes: '*/30 * * * *',
    hourly: '0 * * * *',
    daily: '0 0 * * *',
    weekly: '0 0 * * 0',
    monthly: '0 0 1 * *',

    // Custom schedules
    dailyAt1AM: '0 1 * * *',
    dailyAt2AM: '0 2 * * *',
    dailyAt3AM: '0 3 * * *',
    businessHours: '0 9-17 * * 1-5', // 9 AM to 5 PM, Monday to Friday
};

/**
 * Validate a cron expression
 * @param {String} expression - Cron expression to validate
 * @returns {Boolean} Whether the expression is valid
 */
export const isValidCronExpression = (expression) => {
    return cron.validate(expression);
};

/**
 * Get the next execution date for a cron expression
 * @param {String} expression - Cron expression
 * @returns {Date} Next execution date
 */
export const getNextExecutionDate = (expression) => {
    if (!isValidCronExpression(expression)) {
        throw new Error('Invalid cron expression');
    }

    const schedule = cron.schedule(expression, () => { });
    const next = schedule.nextDate();
    schedule.stop();

    return next.toDate();
};

/**
 * Parse a time window string (HH:MM) to Date object
 * @param {String} timeString - Time string in HH:MM format
 * @returns {Date} Date object with the specified time
 */
export const parseTimeWindow = (timeString) => {
    if (!timeString.match(/^([01]\d|2[0-3]):([0-5]\d)$/)) {
        throw new Error('Invalid time format. Expected HH:MM');
    }

    const [hours, minutes] = timeString.split(':').map(Number);
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);

    return date;
};

/**
 * Check if current time is within a time window
 * @param {Object} timeWindow - Time window object with start and end properties
 * @returns {Boolean} Whether current time is within the window
 */
export const isWithinTimeWindow = (timeWindow) => {
    if (!timeWindow || !timeWindow.start || !timeWindow.end) {
        return true; // If no time window is specified, always return true
    }

    const now = new Date();
    const currentTimeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    return currentTimeStr >= timeWindow.start && currentTimeStr <= timeWindow.end;
};

/**
 * Check if current day is within specified days of week
 * @param {Array} daysOfWeek - Array of days (0-6, where 0 is Sunday)
 * @returns {Boolean} Whether current day is within the specified days
 */
export const isWithinDaysOfWeek = (daysOfWeek) => {
    if (!daysOfWeek || daysOfWeek.length === 0) {
        return true; // If no days are specified, always return true
    }

    const currentDay = new Date().getDay();
    return daysOfWeek.includes(currentDay);
};

export default {
    cronExpressions,
    isValidCronExpression,
    getNextExecutionDate,
    parseTimeWindow,
    isWithinTimeWindow,
    isWithinDaysOfWeek
};