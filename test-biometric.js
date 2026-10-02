/**
 * SonicDrop — End-to-End Test Suite for Biometric Application Lock & WebRTC Signaling
 */

const http = require("http");
const { WebSocket } = require("ws");
const authStore = require("./authStore");

const PORT = 8089;
process.env.PORT = PORT;

// Start server
const server = require("./server.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://localhost:${PORT}${path}`,
      {
        method: options.method || "GET",
        headers: options.headers || {}
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, data, json });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runTests() {
  console.log("==================================================");
  console.log("       SONICDROP BIOMETRIC TEST SUITE             ");
  console.log("==================================================\n");

  await sleep(600); // Give server a moment to bind

  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`  [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${name}`);
      failed++;
    }
  }

  try {
    const testDeviceId = "test-device-uuid-" + Date.now();

    // ── Test 1: Device Status (Unregistered) ───────────────────────────────────
    console.log("Test 1: Check unregistered device status");
    const st1 = await request(`/api/auth/status?deviceId=${testDeviceId}`);
    assert(st1.status === 200, "Status endpoint returns 200");
    assert(st1.json.registered === false, "Device initially reported as unregistered");
    assert(st1.json.authenticated === false, "Device initially reported as unauthenticated");

    // ── Test 2: Register Options Generation ────────────────────────────────────
    console.log("\nTest 2: Generate WebAuthn registration options");
    const regOptRes = await request("/api/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { deviceId: testDeviceId }
    });
    assert(regOptRes.status === 200, "Registration options returns 200");
    assert(typeof regOptRes.json.challenge === "string", "Challenge is present and string");
    assert(regOptRes.json.rp.name === "SonicDrop", "RP Name is SonicDrop");
    assert(regOptRes.json.authenticatorSelection.authenticatorAttachment === "platform", "Platform authenticator requested");
    assert(regOptRes.json.authenticatorSelection.userVerification === "required", "User verification is required");

    // ── Test 3: Invalid Registration Verification (Replay / Tamper Prevention) ─
    console.log("\nTest 3: Reject invalid/tampered registration response");
    const badRegVerify = await request("/api/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        deviceId: testDeviceId,
        response: { id: "fake", rawId: "fake", response: { clientDataJSON: "fake" }, type: "public-key" }
      }
    });
    assert(badRegVerify.status === 400, "Server rejects invalid registration response with 400");

    // ── Test 4: Challenge Single-Use (Replay Prevention) ───────────────────────
    console.log("\nTest 4: Verify challenge is destroyed after use (prevent replay)");
    const replayRegVerify = await request("/api/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        deviceId: testDeviceId,
        response: { id: "fake", rawId: "fake", response: { clientDataJSON: "fake" }, type: "public-key" }
      }
    });
    assert(replayRegVerify.status === 400, "Challenge re-use fails immediately");
    assert(replayRegVerify.json.error.includes("expired or invalid"), "Replay attempt returns expired/invalid challenge error");

    // ── Test 5: Login Options for Unregistered Device ─────────────────────────
    console.log("\nTest 5: Login options for unregistered device returns 404");
    const unregAuth = await request("/api/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { deviceId: "non-existent-device" }
    });
    assert(unregAuth.status === 404, "Unregistered device login options returns 404");

    // ── Test 6: AuthStore Persistence & Login Options ─────────────────────────
    console.log("\nTest 6: Store registered credential and generate login options");
    authStore.saveCredential(testDeviceId, {
      id: "mock_cred_id_base64url",
      publicKey: Buffer.from("mock_public_key_bytes").toString("base64url"),
      counter: 0,
      transports: ["internal"]
    });
    assert(authStore.hasDevice(testDeviceId), "AuthStore confirms device has registered credential");

    const authOptRes = await request("/api/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { deviceId: testDeviceId }
    });
    assert(authOptRes.status === 200, "Authentication options returns 200");
    assert(typeof authOptRes.json.challenge === "string", "Authentication challenge generated");
    assert(authOptRes.json.allowCredentials.length === 1, "allowCredentials contains registered credential");
    assert(authOptRes.json.allowCredentials[0].id === "mock_cred_id_base64url", "Credential ID matches");

    // ── Test 7: Bypass Session & Session Validation ───────────────────────────
    console.log("\nTest 7: Ephemeral session creation and validation");
    const bypassRes = await request("/api/auth/dev-bypass", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { deviceId: testDeviceId }
    });
    assert(bypassRes.status === 200, "Bypass session endpoint returns 200");
    const sessionToken = bypassRes.json.sessionToken;
    assert(typeof sessionToken === "string" && sessionToken.length > 20, "Valid session token returned");

    const sessionCheck = await request(`/api/auth/session?sessionToken=${sessionToken}`);
    assert(sessionCheck.status === 200, "Session check returns 200");
    assert(sessionCheck.json.valid === true, "Session check confirms session is valid");

    // ── Test 8: Manual Lock & Invalidation ────────────────────────────────────
    console.log("\nTest 8: Manual lock invalidates active session");
    const lockRes = await request("/api/auth/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { sessionToken }
    });
    assert(lockRes.status === 200, "Lock endpoint returns 200");
    const sessionAfterLock = await request(`/api/auth/session?sessionToken=${sessionToken}`);
    assert(sessionAfterLock.json.valid === false, "Session is confirmed invalid after lock");

    // ── Test 9: WebSocket Signaling with Lock Enforcement ─────────────────────
    console.log("\nTest 9: WebSocket room joining with session token verification");

    // First, receiver creates room "TST1"
    const wsReceiver = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise((resolve) => (wsReceiver.onopen = resolve));

    let roomCreatedPromise = new Promise((resolve) => {
      wsReceiver.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "room-created") resolve(msg.roomId);
      };
    });
    wsReceiver.send(JSON.stringify({ type: "create-room", roomId: "TST1" }));
    const createdRoomId = await roomCreatedPromise;
    assert(createdRoomId === "TST1", "Desktop receiver created room TST1");

    // Sender attempts to join with invalid/locked session token
    const wsSenderLocked = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise((resolve) => (wsSenderLocked.onopen = resolve));

    let lockedErrorPromise = new Promise((resolve) => {
      wsSenderLocked.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "error") resolve(msg.message);
      };
    });
    wsSenderLocked.send(JSON.stringify({
      type: "join-room",
      roomId: "TST1",
      sessionToken: "invalid-or-locked-token"
    }));
    const lockErrMsg = await lockedErrorPromise;
    assert(lockErrMsg.includes("locked") || lockErrMsg.includes("Biometric"), "Sender blocked from joining room when locked");
    wsSenderLocked.close();

    // Now generate a valid unlocked session and join
    const newSessRes = await request("/api/auth/dev-bypass", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { deviceId: testDeviceId }
    });
    const validToken = newSessRes.json.sessionToken;

    const wsSenderUnlocked = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise((resolve) => (wsSenderUnlocked.onopen = resolve));

    let joinedPromise = new Promise((resolve) => {
      wsSenderUnlocked.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "room-joined") resolve(msg.roomId);
      };
    });
    wsSenderUnlocked.send(JSON.stringify({
      type: "join-room",
      roomId: "TST1",
      sessionToken: validToken
    }));
    const joinedRoomId = await joinedPromise;
    assert(joinedRoomId === "TST1", "Authenticated sender joined room successfully");

    // Verify WebRTC signal relay between peers
    let receiverReceivedSignalPromise = new Promise((resolve) => {
      wsReceiver.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "signal") resolve(msg.data);
      };
    });
    wsSenderUnlocked.send(JSON.stringify({
      type: "signal",
      roomId: "TST1",
      data: { type: "offer", sdp: "v=0\r\no=- 12345 2 IN IP4 127.0.0.1..." }
    }));
    const relayedSignal = await receiverReceivedSignalPromise;
    assert(relayedSignal && relayedSignal.type === "offer", "WebRTC signal relayed from sender to receiver");

    let senderReceivedSignalPromise = new Promise((resolve) => {
      wsSenderUnlocked.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "signal") resolve(msg.data);
      };
    });
    wsReceiver.send(JSON.stringify({
      type: "signal",
      roomId: "TST1",
      data: { type: "answer", sdp: "v=0\r\no=- 67890 2 IN IP4 127.0.0.1..." }
    }));
    const answerSignal = await senderReceivedSignalPromise;
    assert(answerSignal && answerSignal.type === "answer", "WebRTC signal relayed from receiver to sender");

    wsReceiver.close();
    wsSenderUnlocked.close();

    // ── Test 10: Static assets verification ───────────────────────────────────
    console.log("\nTest 10: Static asset delivery & PWA files");
    const resSender = await request("/sender");
    assert(resSender.status === 200, "/sender serves 200");
    assert(resSender.data.includes("Biometric Security Lock"), "sender.html contains Biometric Security Lock");
    assert(resSender.data.includes("simplewebauthn-browser.min.js"), "sender.html imports simplewebauthn-browser.min.js");

    const resSw = await request("/sw.js");
    assert(resSw.status === 200, "sw.js serves 200");
    assert(resSw.data.includes("simplewebauthn-browser.min.js"), "sw.js pre-caches simplewebauthn-browser.min.js");
    assert(resSw.data.includes("sonicdrop-v2"), "sw.js cache bumped to v2");

    const resWebAuthnJs = await request("/simplewebauthn-browser.min.js");
    assert(resWebAuthnJs.status === 200, "simplewebauthn-browser.min.js serves 200");
    assert(resWebAuthnJs.headers["content-type"].includes("javascript"), "Content-Type is javascript");

    // Clean up test device
    authStore.removeDevice(testDeviceId);

    console.log(`\n==================================================`);
    console.log(`TEST SUMMARY: ${passed} passed, ${failed} failed`);
    console.log(`==================================================\n`);

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("Test error:", err);
    process.exit(1);
  }
}

runTests();
