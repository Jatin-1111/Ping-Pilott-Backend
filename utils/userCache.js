// Short-lived in-process cache of the signed-in user, so an authenticated request does not need a database
// round trip just to find out who is calling. Entries are plain objects (a fresh document is built from them
// per request), live 15 seconds, and are cleared by the User model whenever a user is saved, updated or deleted.

const TTL_MS = 15 * 1000;
const MAX_ENTRIES = 1000;

const entries = new Map();

export const userCache = {
    get(id) {
        const hit = entries.get(String(id));
        if (!hit) return null;
        if (hit.expires < Date.now()) {
            entries.delete(String(id));
            return null;
        }
        return hit.user;
    },
    set(id, user) {
        if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value); // oldest first
        entries.set(String(id), { user, expires: Date.now() + TTL_MS });
    },
    invalidate(id) {
        entries.delete(String(id));
    },
    clear() {
        entries.clear();
    },
};

export default userCache;
