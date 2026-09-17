import express from 'express';
import { loadCredential, resolveCredentialSubject, handshake } from '../controllers/escortWalletController.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { requirePolicy } from '../middleware/requirePolicy.js';
import { validateBody } from '../middleware/validate.js';
import { issueCredentialSchema, convoyHandshakeSchema } from '../validation/requestSchemas.js';

const router = express.Router();

// Escort drivers load their certifications, insurance, and state permits.
// Only the wallet owner (or an admin) may issue a credential for a subject.
router.post(
    '/credential',
    authenticate,
    validateBody(issueCredentialSchema),
    // Only the escort driver themselves (for their own wallet address) or an
    // administrator may issue a credential — never any authenticated user for
    // an arbitrary subject.
    requirePolicy('escort:issue-credential', resolveCredentialSubject),
    loadCredential
);

// Truck drivers verify the entire convoy's legal compliance
router.post(
    '/handshake',
    authenticate,
    requireRole('driver', 'fleet_manager'),
    validateBody(convoyHandshakeSchema),
    handshake
);

export default router;
