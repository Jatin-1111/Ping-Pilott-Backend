import express from 'express';
import hostAgentController from '../controllers/hostAgentController.js';
import agentAuth from '../middleware/agentAuth.js';
import { agentLimiter, agentGuessLimiter } from '../middleware/rateLimiter.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// What a host agent calls, signed in with its token (not a user session). Mounted before the general API limiter in
// index.js: an agent's allowance is per token, so agents on one network do not share one.
const router = express.Router();

router.post('/v1/metrics', agentGuessLimiter, agentLimiter, agentAuth, asyncHandler(hostAgentController.ingest));

export default router;
