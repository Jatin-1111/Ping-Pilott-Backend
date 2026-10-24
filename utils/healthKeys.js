// utils/healthKeys.js - the Redis keys the workers use to show they are alive (no imports: scripts can use it too)
//
//   pp:health:monitor-worker:<host>:<pid>   written every 15 s by each monitor worker, expires after 60 s
//   pp:health:alert-worker:<host>:<pid>     the same for each alert worker
//   pp:health:last-check-completed          epoch ms of the last check a worker finished

import os from 'os';

export const HEALTH_PREFIX = 'pp:health:';
export const LAST_CHECK_KEY = `${HEALTH_PREFIX}last-check-completed`;

/** 'monitor' or 'alert' */
export const ROLES = ['monitor', 'alert'];

export const instanceId = () => `${os.hostname()}:${process.pid}`;

export const beatKey = (role, id = instanceId()) => `${HEALTH_PREFIX}${role}-worker:${id}`;

/** Pattern matching every worker of a role, or only those on one host (what a container's healthcheck looks for) */
export const beatPattern = (role, host = '*') => `${HEALTH_PREFIX}${role}-worker:${host}${host === '*' ? '' : ':*'}`;

export default { HEALTH_PREFIX, LAST_CHECK_KEY, ROLES, instanceId, beatKey, beatPattern };
