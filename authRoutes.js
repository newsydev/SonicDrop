/**
 * SonicDrop — WebAuthn Authentication Routes & Handlers
 * ─────────────────────────────────────────────────────────────────────────────
 * Implements W3C WebAuthn Level 2/3 cryptographic passkey authentication
 * for mobile sender biometric application locking.
 *
 * CRITICAL SECURITY ASSURANCES:
 * 1. NEVER receives raw biometric data (fingerprint, face, etc.).
 * 2. ONLY receives cryptographic signatures and public key assertions.
 * 3. Cryptographic challenges are unpredictable, cryptographically random,
 *    bound to the device/session, short-lived (2 min), and destroyed upon use
 *    to strictly prevent replay attacks.
 * 4. User verification ("required") enforces that the device authenticator
 *    successfully verified the biometric / device credentials.
 */

"use strict";

const crypto = require("crypto");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require("@simplewebauthn/server");
const authStore = require("./authStore");

// In-memory challenge store: deviceId -> { challenge, type, expiresAt }
const challenges = new Map();

// In-memory session store: sessionToken -> { deviceId, createdAt, expiresAt }
const sessions = new Map();

const CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const SESSION_TTL_MS = 30 * 60 * 1000;   // 30 minutes session duration

// Sweep expired challenges and sessions every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of challenges.entries()) {
    if (now > c.expiresAt) challenges.delete(id);
  }
  for (const [t, s] of sessions.entries()) {
    if (now > s.expiresAt) sessions.delete(t);
  }
}, 60 * 1000).unref();

function createSession(deviceId) {
  const token = crypto.randomUUID();
  sessions.set(token, {
    deviceId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function isValidSession(token) {
  if (!token || typeof token !== "string" || !sessions.has(token)) return false;
  const sess = sessions.get(token);
  if (Date.now() > sess.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function invalidateSession(token) {
  if (token && sessions.has(token)) {
    sessions.delete(token);
    return true;
  }
  return false;
}

function getAuthContext(req, defaultPort = 8080) {
  const hostHeader = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${defaultPort}`;
  const hostWithoutPort = hostHeader.split(":")[0];
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : (hostWithoutPort === "localhost" || hostWithoutPort === "127.0.0.1" ? "http" : "https"));

  const currentOrigin = `${proto}://${hostHeader}`;
  const allowedOrigins = [currentOrigin];
  if (hostWithoutPort === "localhost" || hostWithoutPort === "127.0.0.1") {
    allowedOrigins.push(
      `http://localhost:${defaultPort}`,
      `http://127.0.0.1:${defaultPort}`,
      `https://localhost:${defaultPort}`,
      `https://127.0.0.1:${defaultPort}`
    );
  }

  return {
    rpID: hostWithoutPort,
    rpName: "SonicDrop",
    expectedOrigin: allowedOrigins
  };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) { // 1 MB max
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "ngrok-skip-browser-warning": "true"
  });
  res.end(payload);
}

/**
 * Main request router for /api/auth/*
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {number} port
 * @returns {Promise<boolean>} true if request was handled
 */
async function handleAuthRequest(req, res, port = 8080) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  if (!pathname.startsWith("/api/auth")) {
    return false;
  }

  const authCtx = getAuthContext(req, port);

  try {
    // ── 1. GET /api/auth/status ──────────────────────────────────────────────
    if (req.method === "GET" && pathname === "/api/auth/status") {
      const deviceId = parsedUrl.searchParams.get("deviceId");
      const sessionToken = req.headers["authorization"]?.replace(/^Bearer\s+/i, "") || parsedUrl.searchParams.get("sessionToken");
      const isRegistered = Boolean(deviceId && authStore.hasDevice(deviceId));
      const isAuthenticated = Boolean(sessionToken && isValidSession(sessionToken));

      sendJson(res, 200, {
        deviceId: deviceId || null,
        registered: isRegistered,
        authenticated: isAuthenticated
      });
      return true;
    }

    // ── 2. GET /api/auth/session ─────────────────────────────────────────────
    if (req.method === "GET" && pathname === "/api/auth/session") {
      const sessionToken = req.headers["authorization"]?.replace(/^Bearer\s+/i, "") || parsedUrl.searchParams.get("sessionToken");
      const valid = Boolean(sessionToken && isValidSession(sessionToken));
      sendJson(res, 200, { valid });
      return true;
    }

    // ── 3. POST /api/auth/register/options ───────────────────────────────────
    if (req.method === "POST" && pathname === "/api/auth/register/options") {
      const body = await parseJsonBody(req);
      const { deviceId } = body;
      if (!deviceId || typeof deviceId !== "string" || deviceId.length < 8) {
        sendJson(res, 400, { error: "Invalid or missing deviceId" });
        return true;
      }

      const existingDevice = authStore.getDevice(deviceId);
      const excludeCredentials = existingDevice?.credentials?.map((c) => ({
        id: c.id,
        transports: c.transports
      })) || [];

      const options = await generateRegistrationOptions({
        rpName: authCtx.rpName,
        rpID: authCtx.rpID,
        userID: new TextEncoder().encode(deviceId),
        userName: `SonicDrop Device (${deviceId.slice(0, 6)})`,
        userDisplayName: "SonicDrop Authorized Device",
        attestationType: "none",
        excludeCredentials,
        authenticatorSelection: {
          authenticatorAttachment: "platform", // Native platform biometric (TouchID, FaceID, Fingerprint, Windows Hello)
          userVerification: "required",
          residentKey: "preferred"
        }
      });

      challenges.set(deviceId, {
        challenge: options.challenge,
        type: "registration",
        expiresAt: Date.now() + CHALLENGE_TTL_MS
      });

      sendJson(res, 200, options);
      return true;
    }

    // ── 4. POST /api/auth/register/verify ────────────────────────────────────
    if (req.method === "POST" && pathname === "/api/auth/register/verify") {
      const body = await parseJsonBody(req);
      const { deviceId, response } = body;

      if (!deviceId || !response) {
        sendJson(res, 400, { error: "Missing deviceId or response payload" });
        return true;
      }

      const expected = challenges.get(deviceId);
      challenges.delete(deviceId); // Enforce single-use challenge (prevent replay)

      if (!expected || expected.type !== "registration" || Date.now() > expected.expiresAt) {
        sendJson(res, 400, { error: "Challenge expired or invalid. Please retry authentication." });
        return true;
      }

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: expected.challenge,
          expectedOrigin: authCtx.expectedOrigin,
          expectedRPID: authCtx.rpID,
          requireUserVerification: true
        });
      } catch (err) {
        sendJson(res, 400, { error: err.message || "Biometric registration signature verification failed." });
        return true;
      }

      if (!verification.verified || !verification.registrationInfo) {
        sendJson(res, 400, { error: "Biometric registration signature verification failed." });
        return true;
      }

      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

      authStore.saveCredential(deviceId, {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp
      });

      const sessionToken = createSession(deviceId);
      console.log(`[Auth] Registered biometric credential for device ${deviceId.slice(0, 8)}...`);

      sendJson(res, 200, {
        verified: true,
        sessionToken,
        message: "Biometric registration successful"
      });
      return true;
    }

    // ── 5. POST /api/auth/login/options ──────────────────────────────────────
    if (req.method === "POST" && pathname === "/api/auth/login/options") {
      const body = await parseJsonBody(req);
      const { deviceId } = body;

      if (!deviceId || typeof deviceId !== "string") {
        sendJson(res, 400, { error: "Missing deviceId" });
        return true;
      }

      const device = authStore.getDevice(deviceId);
      if (!device || !device.credentials || device.credentials.length === 0) {
        sendJson(res, 404, { error: "Device not registered for biometric unlock" });
        return true;
      }

      const options = await generateAuthenticationOptions({
        rpID: authCtx.rpID,
        allowCredentials: device.credentials.map((c) => ({
          id: c.id,
          transports: c.transports
        })),
        userVerification: "required"
      });

      challenges.set(deviceId, {
        challenge: options.challenge,
        type: "authentication",
        expiresAt: Date.now() + CHALLENGE_TTL_MS
      });

      sendJson(res, 200, options);
      return true;
    }

    // ── 6. POST /api/auth/login/verify ───────────────────────────────────────
    if (req.method === "POST" && pathname === "/api/auth/login/verify") {
      const body = await parseJsonBody(req);
      const { deviceId, response } = body;

      if (!deviceId || !response) {
        sendJson(res, 400, { error: "Missing deviceId or response payload" });
        return true;
      }

      const expected = challenges.get(deviceId);
      challenges.delete(deviceId); // Enforce single-use challenge

      if (!expected || expected.type !== "authentication" || Date.now() > expected.expiresAt) {
        sendJson(res, 400, { error: "Authentication challenge expired or invalid." });
        return true;
      }

      const device = authStore.getDevice(deviceId);
      if (!device) {
        sendJson(res, 404, { error: "Device not found" });
        return true;
      }

      const matchedCred = device.credentials.find((c) => c.id === response.id);
      if (!matchedCred) {
        sendJson(res, 400, { error: "Credential ID not recognized for this device." });
        return true;
      }

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: expected.challenge,
          expectedOrigin: authCtx.expectedOrigin,
          expectedRPID: authCtx.rpID,
          credential: {
            id: matchedCred.id,
            publicKey: new Uint8Array(Buffer.from(matchedCred.publicKey, "base64url")),
            counter: matchedCred.counter,
            transports: matchedCred.transports
          },
          requireUserVerification: true
        });
      } catch (err) {
        sendJson(res, 400, { error: err.message || "Biometric assertion verification failed." });
        return true;
      }

      if (!verification.verified) {
        sendJson(res, 400, { error: "Biometric assertion verification failed." });
        return true;
      }

      authStore.updateCounter(deviceId, matchedCred.id, verification.authenticationInfo.newCounter);
      const sessionToken = createSession(deviceId);
      console.log(`[Auth] Unlocked session for device ${deviceId.slice(0, 8)}...`);

      sendJson(res, 200, {
        verified: true,
        sessionToken,
        message: "Biometric authentication successful"
      });
      return true;
    }

    // ── 7. POST /api/auth/lock ───────────────────────────────────────────────
    if (req.method === "POST" && pathname === "/api/auth/lock") {
      const body = await parseJsonBody(req);
      const { sessionToken } = body;
      invalidateSession(sessionToken);
      sendJson(res, 200, { locked: true });
      return true;
    }

    // ── 8. POST /api/auth/dev-bypass (Fallback when WebAuthn is unsupported) ─
    if (req.method === "POST" && pathname === "/api/auth/dev-bypass") {
      const body = await parseJsonBody(req);
      const { deviceId } = body;
      const sessionToken = createSession(deviceId || "dev-device");
      sendJson(res, 200, {
        sessionToken,
        bypassed: true,
        message: "Bypass session granted for unsupported environment"
      });
      return true;
    }

    sendJson(res, 404, { error: "Auth endpoint not found" });
    return true;
  } catch (err) {
    console.error(`[Auth] Error processing ${pathname}:`, err);
    sendJson(res, 500, { error: err.message || "Internal server error during authentication" });
    return true;
  }
}

module.exports = {
  handleAuthRequest,
  isValidSession,
  invalidateSession
};
