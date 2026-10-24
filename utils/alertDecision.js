// utils/alertDecision.js - pure rule for what a finished check should tell the user

/**
 * What, if anything, to tell the user about this check.
 *  up -> down        : "down"
 *  down -> up        : "recovery"
 *  unknown -> down   : "down"   (a server that has never been up still needs to be reported)
 *  unknown -> up     : nothing  (the first check is not a recovery)
 *  up and slow       : one "slow" alert per slow streak
 */
export const decideAlert = (previous, result, slowAlreadyAlerted) => {
    if (previous !== result.status) {
        if (result.status === 'down') return 'server_down';
        if (result.status === 'up' && previous === 'down') return 'server_recovery';
        return null;
    }
    if (result.status === 'up' && result.slow && !slowAlreadyAlerted) return 'slow_response';
    return null;
};


export default { decideAlert };
