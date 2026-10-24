// utils/schedule.js - "is it inside the user's check/alert hours?" in the user's own timezone
//
// Schedules used to be compared with the server's clock (UTC in production), so a user in India who set
// 09:00 to 18:00 was actually monitored from 14:30 to 23:30 their time. Every server now carries an IANA
// timezone (for example "Asia/Kolkata"), and every schedule check goes through here.

const DEFAULT_TIMEZONE = () => process.env.TIMEZONE || 'UTC';

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** True for names like "Asia/Kolkata"; false for anything Intl does not know. */
export const isValidTimezone = (tz) => {
    if (typeof tz !== 'string' || !tz) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
};

/** The timezone to use for a server document: its own, else the deployment default. */
export const timezoneOf = (server) => (isValidTimezone(server?.timezone) ? server.timezone : DEFAULT_TIMEZONE());

const formatters = new Map();
const formatterFor = (timeZone) => {
    if (!formatters.has(timeZone)) {
        formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
            timeZone,
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        }));
    }
    return formatters.get(timeZone);
};

/** { day: 0-6 (0 = Sunday), time: "HH:MM" } for an instant, as seen on a wall clock in `timeZone`. */
export const localParts = (date = new Date(), timeZone = DEFAULT_TIMEZONE()) => {
    const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(date).map((p) => [p.type, p.value]));
    return {
        day: WEEKDAYS[parts.weekday],
        time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`
    };
};

/**
 * Inside a start-end window? "00:00" to "00:00" means all day; a window that ends before it starts
 * (22:00 to 06:00) runs overnight.
 */
export const timeInWindow = (time, start, end) => {
    if (!start || !end) return true;
    if (start === '00:00' && end === '00:00') return true;
    return start <= end ? (time >= start && time <= end) : (time >= start || time <= end);
};

/**
 * Should a server be checked at this moment, according to its days and hours?
 * @param {Object} monitoring - { daysOfWeek, timeWindows }
 */
export const isWithinCheckSchedule = (monitoring, timeZone, date = new Date()) => {
    const { day, time } = localParts(date, timeZone);

    if (monitoring?.daysOfWeek?.length > 0 && !monitoring.daysOfWeek.includes(day)) return false;

    if (monitoring?.timeWindows?.length > 0) {
        return monitoring.timeWindows.some((w) => timeInWindow(time, w.start, w.end));
    }
    return true;
};

export default { isValidTimezone, timezoneOf, localParts, timeInWindow, isWithinCheckSchedule };
