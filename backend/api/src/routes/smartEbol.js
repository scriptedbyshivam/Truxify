import express from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { processGeofencedSignature } from '../services/smartEbol.js';

const router = express.Router();

router.post(
    '/sign',
    authenticate,
    // An eBOL records a physical handover at a facility, so only convoy
    // participants may sign one.
    requireRole(['driver', 'fleet_manager']),
    (req, res) => {
        try {
            const {
                ebolId,
                facilityId,
                receiverId,
                receiverName,
                receiverCoordinates,
                signatureData,
                biometricAuthToken
            } = req.body;

            if (!ebolId || !receiverId) {
                return res.status(400).json({ error: 'ebolId and receiverId are required.' });
            }

            if (typeof facilityId !== 'string' || facilityId.trim() === '') {
                return res.status(400).json({ error: 'facilityId is required.' });
            }

            if (!receiverCoordinates || receiverCoordinates.latitude === undefined || receiverCoordinates.longitude === undefined) {
                return res.status(400).json({ error: 'Valid receiverCoordinates (latitude, longitude) are required.' });
            }

            const result = processGeofencedSignature({
                ebolId,
                facilityId,
                receiverId,
                receiverName,
                receiverCoordinates,
                signatureData,
                biometricAuthToken
            });

            if (!result.signed) {
                // Registry misconfiguration is a server fault, not a client one.
                const status = result.reason === 'FACILITY_REGISTRY_NOT_CONFIGURED' ? 503 : 422;
                return res.status(status).json({
                    success: false,
                    error: result.reason,
                    message: result.message,
                    proximityMetrics: result.proximityMetrics
                });
            }

            return res.json({
                success: true,
                data: result.data
            });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }
);

export default router;
