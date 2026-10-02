/**
 * SonicDrop — Credential & Authentication Store
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages persisted WebAuthn public keys, credential IDs, and counters.
 *
 * CRITICAL SECURITY ASSURANCES:
 * 1. NEVER receives, stores, or handles raw biometric data (fingerprint/face).
 *    All biometrics are processed exclusively by the device's secure hardware/OS.
 * 2. NEVER stores private keys. Private keys never leave the authenticator hardware.
 * 3. Only cryptographic public keys, credential IDs, signature counters, and
 *    anonymous device identifiers are stored here.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "credentials.json");

class AuthStore {
  constructor() {
    this._data = { devices: {} };
    this._init();
  }

  _init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(STORE_FILE)) {
        const raw = fs.readFileSync(STORE_FILE, "utf8");
        this._data = JSON.parse(raw);
        if (!this._data.devices) this._data.devices = {};
      } else {
        this._save();
      }
    } catch (err) {
      console.error("[AuthStore] Error initializing storage:", err.message);
      this._data = { devices: {} };
    }
  }

  _save() {
    try {
      const tempPath = `${STORE_FILE}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(this._data, null, 2), "utf8");
      fs.renameSync(tempPath, STORE_FILE);
    } catch (err) {
      console.error("[AuthStore] Error writing credentials:", err.message);
    }
  }

  /**
   * Retrieves a device entry by deviceId.
   * @param {string} deviceId
   * @returns {{ deviceId: string, registeredAt: number, credentials: Array } | null}
   */
  getDevice(deviceId) {
    if (!deviceId) return null;
    return this._data.devices[deviceId] || null;
  }

  /**
   * Checks if a device has at least one registered WebAuthn credential.
   * @param {string} deviceId
   * @returns {boolean}
   */
  hasDevice(deviceId) {
    const dev = this.getDevice(deviceId);
    return Boolean(dev && dev.credentials && dev.credentials.length > 0);
  }

  /**
   * Saves or appends a new WebAuthn credential for a device.
   *
   * @param {string} deviceId
   * @param {object} cred
   * @param {string} cred.id - Base64URL credential ID
   * @param {string} cred.publicKey - Base64URL encoded public key
   * @param {number} cred.counter - Authenticator signature counter
   * @param {string[]} [cred.transports] - Transport hints (e.g. ['internal'])
   * @param {string} [cred.deviceType] - 'singleDevice' | 'multiDevice'
   * @param {boolean} [cred.backedUp]
   */
  saveCredential(deviceId, cred) {
    if (!deviceId || !cred || !cred.id || !cred.publicKey) {
      throw new Error("Invalid credential data for storage");
    }

    if (!this._data.devices[deviceId]) {
      this._data.devices[deviceId] = {
        deviceId,
        registeredAt: Date.now(),
        credentials: []
      };
    }

    const device = this._data.devices[deviceId];
    const existingIdx = device.credentials.findIndex((c) => c.id === cred.id);

    const record = {
      id: cred.id,
      publicKey: cred.publicKey,
      counter: cred.counter ?? 0,
      transports: cred.transports || ["internal"],
      deviceType: cred.deviceType || "singleDevice",
      backedUp: Boolean(cred.backedUp),
      createdAt: cred.createdAt || Date.now(),
      lastUsedAt: Date.now()
    };

    if (existingIdx >= 0) {
      device.credentials[existingIdx] = record;
    } else {
      device.credentials.push(record);
    }

    this._save();
    return record;
  }

  /**
   * Updates the signature counter for a specific credential to prevent replay attacks.
   * @param {string} deviceId
   * @param {string} credentialId
   * @param {number} newCounter
   */
  updateCounter(deviceId, credentialId, newCounter) {
    const device = this.getDevice(deviceId);
    if (!device) return;

    const cred = device.credentials.find((c) => c.id === credentialId);
    if (cred) {
      cred.counter = newCounter;
      cred.lastUsedAt = Date.now();
      this._save();
    }
  }

  /**
   * Removes a device and its credentials (for testing / reset).
   * @param {string} deviceId
   */
  removeDevice(deviceId) {
    if (this._data.devices[deviceId]) {
      delete this._data.devices[deviceId];
      this._save();
    }
  }
}

module.exports = new AuthStore();
