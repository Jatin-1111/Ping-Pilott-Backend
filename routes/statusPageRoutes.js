import express from 'express';
import statusPageController from '../controllers/statusPageController.js';
import { protect } from '../middleware/auth.js';
import { publicStatusLimiter } from '../middleware/rateLimiter.js';

// Public: what a stranger sees of one published page. No sign-in; limited per address and page.
export const publicStatusRouter = express.Router();
publicStatusRouter.get('/status/:slug', publicStatusLimiter, statusPageController.getPublicStatus);

// The signed-in owner's pages
const router = express.Router();
router.use(protect);

router.get('/', statusPageController.listStatusPages);
// before '/:id', which would otherwise take "slug" for an id
router.get('/slug', statusPageController.checkSlug);
router.post('/', statusPageController.createStatusPage);
router.patch('/:id', statusPageController.updateStatusPage);
router.delete('/:id', statusPageController.deleteStatusPage);

export default router;
