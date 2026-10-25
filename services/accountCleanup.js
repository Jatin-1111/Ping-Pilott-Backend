// services/accountCleanup.js - what has to go when an account goes
//
// Deleting only the user row left their servers behind. Those kept being checked every few minutes and
// kept emailing the old contact addresses, with nobody able to log in and stop them.

import Server from '../models/Server.js';
import ServerCheck from '../models/ServerCheck.js';
import SupportTicket from '../models/SupportTicket.js';
import { invalidateServerCache } from '../utils/cacheManager.js';
import Incident from '../models/Incident.js';
import HostMetric from '../models/HostMetric.js';
import HostMetric5m from '../models/HostMetric5m.js';

/** Remove a user's servers (so monitoring stops first), their check history and their tickets. */
export async function purgeUserData(userId) {
    const servers = await Server.find({ uploadedBy: userId }).select('_id').lean();
    const serverIds = servers.map((s) => s._id);

    // Servers first: that is what stops the checks and the alerts
    await Server.deleteMany({ uploadedBy: userId });
    if (serverIds.length > 0) {
        await ServerCheck.deleteMany({ serverId: { $in: serverIds } });
        // what their host agents sent, raw and rolled up
        await HostMetric.deleteMany({ serverId: { $in: serverIds } });
        await HostMetric5m.deleteMany({ serverId: { $in: serverIds } });
    }
    await Incident.deleteMany({ userId });
    await SupportTicket.deleteMany({ userId: String(userId) });
    await invalidateServerCache(String(userId));

    return { servers: serverIds.length };
}

export default { purgeUserData };
