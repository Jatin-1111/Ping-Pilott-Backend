// middleware/noStore.js - API answers are not for browsers or shared caches to keep
//
// Signed-in answers (the user, their servers, their alerts) carried an ETag and no Cache-Control, so a browser or a proxy was free
// to decide how long to keep them, and a shared device could show the last user's data from its cache. `no-store` says not to
// keep any of it. A handler that really wants caching (the public status page, the app version check) sets its own
// Cache-Control afterwards, which replaces this one.

export const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
};

export default noStore;
