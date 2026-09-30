import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockProcessGeofencedSignature = vi.fn();

vi.mock('../../src/middleware/auth.js', () => ({
  authenticate: (req, res, next) => {
    if (!req.headers['x-user']) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: req.headers['x-user'], role: req.headers['x-role'] || 'driver' };
    next();
  },
  requireRole: (roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  },
}));

vi.mock('../../src/services/smartEbol.js', () => ({
  processGeofencedSignature: (...args) => mockProcessGeofencedSignature(...args),
}));

const { default: smartEbolRouter } = await import('../../src/routes/smartEbol.js');

// The route is under test with the service mocked, so pull the real service in
// separately for the unit block below.
const { processGeofencedSignature } = await vi.importActual('../../src/services/smartEbol.js');

const FACILITIES = JSON.stringify([
  { id: 'MUM-01', latitude: 19.076, longitude: 72.877 },
  { id: 'BLR-01', latitude: 12.9716, longitude: 77.5946 },
]);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ebols', smartEbolRouter);
  return app;
}

describe('POST /api/ebols/sign — access control', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    mockProcessGeofencedSignature.mockReset();
    mockProcessGeofencedSignature.mockReturnValue({ signed: true, data: { ebolId: 'EB-1' } });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/ebols/sign').send({});
    expect(res.status).toBe(401);
    expect(mockProcessGeofencedSignature).not.toHaveBeenCalled();
  });

  it('rejects a non-participant role', async () => {
    const res = await request(app)
      .post('/api/ebols/sign')
      .set('x-user', 'customer-1')
      .set('x-role', 'customer')
      .send({ ebolId: 'EB-1', facilityId: 'MUM-01', receiverId: 'R-1' });

    expect(res.status).toBe(403);
    expect(mockProcessGeofencedSignature).not.toHaveBeenCalled();
  });

  it('allows a driver and forwards facilityId instead of client coordinates', async () => {
    const res = await request(app)
      .post('/api/ebols/sign')
      .set('x-user', 'driver-1')
      .send({
        ebolId: 'EB-1',
        facilityId: 'MUM-01',
        receiverId: 'R-1',
        receiverCoordinates: { latitude: 19.076, longitude: 72.877 },
      });

    expect(res.status).toBe(200);
    const passed = mockProcessGeofencedSignature.mock.calls[0][0];
    expect(passed.facilityId).toBe('MUM-01');
    expect(passed).not.toHaveProperty('facilityCoordinates');
  });

  it('allows a fleet_manager', async () => {
    const res = await request(app)
      .post('/api/ebols/sign')
      .set('x-user', 'fm-1')
      .set('x-role', 'fleet_manager')
      .send({
        ebolId: 'EB-1',
        facilityId: 'MUM-01',
        receiverId: 'R-1',
        receiverCoordinates: { latitude: 19.0761, longitude: 72.8771 },
      });

    expect(res.status).toBe(200);
  });

  it('rejects a request with no facilityId', async () => {
    const res = await request(app)
      .post('/api/ebols/sign')
      .set('x-user', 'driver-1')
      .send({ ebolId: 'EB-1', receiverId: 'R-1' });

    expect(res.status).toBe(400);
    expect(mockProcessGeofencedSignature).not.toHaveBeenCalled();
  });

  it('surfaces registry misconfiguration as 503, not a client error', async () => {
    mockProcessGeofencedSignature.mockReturnValue({
      signed: false,
      reason: 'FACILITY_REGISTRY_NOT_CONFIGURED',
      message: 'no registry',
    });

    const res = await request(app)
      .post('/api/ebols/sign')
      .set('x-user', 'driver-1')
      .send({
        ebolId: 'EB-1',
        facilityId: 'MUM-01',
        receiverId: 'R-1',
        receiverCoordinates: { latitude: 19.0761, longitude: 72.8771 },
      });

    expect(res.status).toBe(503);
  });
});

describe('processGeofencedSignature — server-side facility resolution', () => {
  const original = process.env.SMART_EBOL_FACILITIES;

  beforeEach(() => {
    process.env.SMART_EBOL_FACILITIES = FACILITIES;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SMART_EBOL_FACILITIES;
    else process.env.SMART_EBOL_FACILITIES = original;
  });

  const atMumbai = { latitude: 19.0761, longitude: 72.8771 };
  const atBengaluru = { latitude: 12.9716, longitude: 77.5946 };

  it('fails closed when no facility registry is configured', () => {
    delete process.env.SMART_EBOL_FACILITIES;
    const result = processGeofencedSignature({
      ebolId: 'EB-1', facilityId: 'MUM-01', receiverId: 'R-1',
      receiverCoordinates: atMumbai,
    });
    expect(result.signed).toBe(false);
    expect(result.reason).toBe('FACILITY_REGISTRY_NOT_CONFIGURED');
  });

  it('fails closed when the registry is malformed', () => {
    process.env.SMART_EBOL_FACILITIES = 'not-json';
    const result = processGeofencedSignature({
      ebolId: 'EB-1', facilityId: 'MUM-01', receiverId: 'R-1',
      receiverCoordinates: atMumbai,
    });
    expect(result.signed).toBe(false);
    expect(result.reason).toBe('FACILITY_REGISTRY_NOT_CONFIGURED');
  });

  it('fails closed when the registry contains no usable entries', () => {
    process.env.SMART_EBOL_FACILITIES = JSON.stringify([{ id: 'X', latitude: 'north' }]);
    const result = processGeofencedSignature({
      ebolId: 'EB-1', facilityId: 'X', receiverId: 'R-1',
      receiverCoordinates: atMumbai,
    });
    expect(result.signed).toBe(false);
    expect(result.reason).toBe('FACILITY_REGISTRY_NOT_CONFIGURED');
  });

  it('rejects an unregistered facility id', () => {
    const result = processGeofencedSignature({
      ebolId: 'EB-1', facilityId: 'ATTACKER-01', receiverId: 'R-1',
      receiverCoordinates: atMumbai,
    });
    expect(result.signed).toBe(false);
    expect(result.reason).toBe('UNKNOWN_FACILITY');
  });

  it('signs when the receiver is genuinely inside the configured geofence', () => {
    const result = processGeofencedSignature({
      ebolId: 'EB-1', facilityId: 'MUM-01', receiverId: 'R-1',
      receiverCoordinates: atMumbai,
    });
    expect(result.signed).toBe(true);
    expect(result.data.status).toBe('DELIVERED_AND_SIGNED');
    expect(result.data.geofenceProof.facilityId).toBe('MUM-01');
    expect(result.data.geofenceProof.geofenceRadiusMeters).toBe(200);
  });

  it('rejects a receiver far outside the configured geofence', () => {
    const result = processGeofencedSignature({
      ebolId: 'EB-1', facilityId: 'MUM-01', receiverId: 'R-1',
      receiverCoordinates: atBengaluru,
    });
    expect(result.signed).toBe(false);
    expect(result.reason).toBe('GEOFENCE_VIOLATION');
  });

  it('resolves the facility server-side, so a caller cannot redefine it', () => {
    // The old implementation read facilityCoordinates from the request, so the
    // caller defined both ends of the distance check. Now the reference point
    // comes from the registry regardless of what the caller claims.
    const result = processGeofencedSignature({
      ebolId: 'EB-1', facilityId: 'MUM-01', receiverId: 'R-1',
      receiverCoordinates: atBengaluru,
      facilityCoordinates: { latitude: 12.9716, longitude: 77.5946 },
    });
    expect(result.signed).toBe(false);
    expect(result.reason).toBe('GEOFENCE_VIOLATION');
  });

  it('ignores a client-supplied geofenceRadiusMeters', () => {
    const result = processGeofencedSignature({
      ebolId: 'EB-1', facilityId: 'MUM-01', receiverId: 'R-1',
      receiverCoordinates: atBengaluru,
      facilityCoordinates: {
        latitude: 12.9716, longitude: 77.5946, geofenceRadiusMeters: 999999999,
      },
    });
    expect(result.signed).toBe(false);
    expect(result.reason).toBe('GEOFENCE_VIOLATION');
  });

  it('rejects non-finite receiver coordinates', () => {
    const result = processGeofencedSignature({
      ebolId: 'EB-1', facilityId: 'MUM-01', receiverId: 'R-1',
      receiverCoordinates: { latitude: 'abc', longitude: null },
    });
    expect(result.signed).toBe(false);
    expect(result.reason).toBe('INVALID_RECEIVER_COORDINATES');
  });

  it('does not claim a digital signature or verified biometrics', () => {
    const result = processGeofencedSignature({
      ebolId: 'EB-1', facilityId: 'MUM-01', receiverId: 'R-1',
      receiverCoordinates: atMumbai,
      biometricAuthToken: 'anything-the-caller-wants',
    });
    expect(result.signed).toBe(true);
    expect(result.data.auditTrail).toHaveProperty('contentChecksum');
    expect(result.data.auditTrail).not.toHaveProperty('immutableHash');
    expect(result.data.auditTrail).not.toHaveProperty('verificationAlgorithm');
    expect(result.data.signatureDetails).not.toHaveProperty('biometricVerified');
    expect(result.data.signatureDetails.biometricTokenPresent).toBe(true);
  });
});
