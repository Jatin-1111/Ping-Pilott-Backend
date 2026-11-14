import express from 'express';
import { createAdmin, listAdmins, revokeAdmin } from '../controllers/adminController.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

// There is no public route that creates the first admin. The old POST /initial-setup was open to anyone holding a setup
// token (which had been committed to git history), had no limiter, and two concurrent calls created two admins. Create the
// first admin with the command line instead: `node scripts/createAdmin.js`.

// Protected admin routes - use your existing middleware
router.post('/create', protect, authorize('admin'), createAdmin);
router.get('/list', protect, authorize('admin'), listAdmins);
router.patch('/revoke/:userId', protect, authorize('admin'), revokeAdmin);

export default router;