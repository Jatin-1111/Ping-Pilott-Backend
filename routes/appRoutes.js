import express from 'express';
import { buildVersionInfo } from '../utils/appVersion.js';

const router = express.Router();

// Public on purpose: the app checks it before (and without) signing in. It holds no user data.
router.get('/version', (req, res) => {
    // a few minutes of caching is plenty and keeps a fleet of phones from asking every time they open
    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json({ status: 'success', data: buildVersionInfo() });
});

export default router;
