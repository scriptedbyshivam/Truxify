import crypto from 'crypto';

const DEFAULT_GEOFENCE_RADIUS_METERS = 200; // Facility boundary threshold

/**
 * Facilities are resolved from a server-side allowlist (SMART_EBOL_FACILITIES),
 * never from the request. The facility coordinate is the reference point of the
 * geofence check, so accepting it from the caller means the caller defines where
 * "the facility" is and the check compares two caller-supplied values against
 * each other. That is not a geofence.
 *
 * Shape: [{"id":"MUM-01","latitude":19.076,"longitude":72.877}]
 */
function loadConfiguredFacilities() {
  const raw = process.env.SMART_EBOL_FACILITIES;
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const byId = new Map();
  for (const entry of parsed) {
    const latitude = Number(entry?.latitude);
    const longitude = Number(entry?.longitude);
    if (typeof entry?.id !== 'string' || entry.id === '') continue;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    byId.set(entry.id, { id: entry.id, latitude, longitude });
  }
  return byId.size > 0 ? byId : null;
}

/**
 * Calculates straight-line distance (haversine formula) in meters between two GPS coordinates.
 */
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return parseFloat((R * c).toFixed(2));
}

/**
 * Validates receiver proximity to a server-configured facility and builds a
 * tamper-evident record of the signing event.
 *
 * The geofence radius is always the server constant. It is deliberately not
 * read from the request: an attacker-supplied radius is how a proximity check
 * stops being one.
 *
 * @param {Object} signParams - { ebolId, facilityId, receiverId, receiverName,
 *   receiverCoordinates, signatureData, biometricAuthToken }
 * @returns {Object} Signature verification result and audit record
 */
export function processGeofencedSignature(signParams) {
    const {
        ebolId,
        facilityId,
        receiverId,
        receiverName = 'Authorized Personnel',
        receiverCoordinates = {},
        signatureData,
        biometricAuthToken
    } = signParams;

    const facilities = loadConfiguredFacilities();

    // Fail closed: with no facility allowlist there is no trustworthy reference
    // point, so there is nothing meaningful to compare against.
    if (!facilities) {
        return {
            signed: false,
            reason: 'FACILITY_REGISTRY_NOT_CONFIGURED',
            message: 'eBOL geofence verification is unavailable because no facility registry is configured on the server.'
        };
    }

    const facility = facilities.get(facilityId);
    if (!facility) {
        return {
            signed: false,
            reason: 'UNKNOWN_FACILITY',
            message: 'The requested facility is not registered on this server.'
        };
    }

    const receiverLat = Number(receiverCoordinates?.latitude);
    const receiverLng = Number(receiverCoordinates?.longitude);

    if (!Number.isFinite(receiverLat) || !Number.isFinite(receiverLng)) {
        return {
            signed: false,
            reason: 'INVALID_RECEIVER_COORDINATES',
            message: 'Receiver coordinates must be finite numbers.'
        };
    }

    const geofenceRadiusMeters = DEFAULT_GEOFENCE_RADIUS_METERS;
    const distanceMeters = calculateDistanceMeters(
        facility.latitude,
        facility.longitude,
        receiverLat,
        receiverLng
    );
    const isWithinGeofence = distanceMeters <= geofenceRadiusMeters;

    if (!isWithinGeofence) {
        return {
            signed: false,
            reason: 'GEOFENCE_VIOLATION',
            message: `Signature rejected. Device is ${distanceMeters}m away from facility center (Maximum allowed: ${geofenceRadiusMeters}m).`,
            proximityMetrics: {
                distanceMeters,
                geofenceRadiusMeters,
                isWithinGeofence: false
            }
        };
    }

    const timestamp = new Date().toISOString();

    // Unkeyed SHA-256. This is a tamper-evidence checksum over the payload, not
    // a digital signature: it proves the fields have not changed, but anyone
    // who can read this record can recompute it, so it proves nothing about who
    // signed. Treating it as a signature would be a false assurance on a
    // regulated document.
    const auditPayload = `${ebolId}:${facilityId}:${receiverId}:${receiverLat},${receiverLng}:${timestamp}`;
    const auditChecksum = crypto.createHash('sha256').update(auditPayload).digest('hex');

    const signedEbolRecord = {
        ebolId,
        status: 'DELIVERED_AND_SIGNED',
        signatureDetails: {
            receiverId,
            receiverName,
            signedAt: timestamp,
            signatureImage: signatureData ? '[STORED_VECTOR_SIGNATURE]' : null,
            // Presence of a token, not proof it was validated. The caller
            // asserted it; nothing here verifies it.
            biometricTokenPresent: !!biometricAuthToken
        },
        geofenceProof: {
            facilityId: facility.id,
            facilityCoordinates: { latitude: facility.latitude, longitude: facility.longitude },
            receiverCoordinates: { latitude: receiverLat, longitude: receiverLng },
            distanceMeters,
            geofenceRadiusMeters,
            isWithinGeofence: true
        },
        auditTrail: {
            contentChecksum: auditChecksum,
            checksumAlgorithm: 'SHA-256',
            note: 'Unkeyed checksum for tamper-evidence only. Not a digital signature.'
        }
    };

    return {
        signed: true,
        data: signedEbolRecord
    };
}
