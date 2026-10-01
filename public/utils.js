/**
 * SonicDrop — Shared Utilities
 * ─────────────────────────────────────────────────────────────────────────────
 * Common helpers shared between receiver.html and sender.html.
 * Loaded as a plain ES module via <script type="module">.
 */

// ─── Room ID Generation ───────────────────────────────────────────────────────
/**
 * Generates a cryptographically random 4-character uppercase alphanumeric Room ID.
 * Characters chosen to avoid ambiguous glyphs (0/O, 1/I).
 */
export function generateRoomId() {
  const chars   = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 unambiguous chars
  const bytes   = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// ─── WebSocket Factory ────────────────────────────────────────────────────────
/**
 * Creates a WebSocket connection to the signaling server.
 * Automatically selects ws:// or wss:// based on the page protocol.
 * @returns {WebSocket}
 */
export function createSignalingSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // Append ngrok bypass token as a query param — the browser WebSocket API
  // does not support custom headers, so this is the only way to skip the
  // ngrok interstitial page that otherwise blocks WebSocket upgrades.
  const url = `${proto}://${location.host}/ws?ngrok-skip-browser-warning=true`;
  const ws  = new WebSocket(url);
  return ws;
}

// ─── ICE / RTC Configuration ──────────────────────────────────────────────────
// iceCandidatePoolSize: pre-gather candidates BEFORE createOffer() is called.
// Without this the browser starts gathering only after setLocalDescription,
// adding 1-3 seconds of dead time.
// bundlePolicy max-bundle: gather a single candidate set for all media/data,
// halving the number of STUN round-trips needed.
export const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302"  },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }, // low-latency global anycast
  ],
};

export const RTC_CONFIG = {
  ...ICE_SERVERS,
  iceCandidatePoolSize: 10,        // pre-warm: start gathering immediately
  bundlePolicy:        "max-bundle", // one ICE component for all channels
  rtcpMuxPolicy:       "require",    // no separate RTCP port needed
};

// ─── Byte Formatter ───────────────────────────────────────────────────────────
/**
 * Formats bytes into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k     = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i     = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

// ─── Transfer Speed Calculator ────────────────────────────────────────────────
export class SpeedCalculator {
  constructor() {
    this._samples = []; // [{ bytes, ts }]
    this._window  = 2000; // 2-second rolling window
  }

  record(bytes) {
    const now = performance.now();
    this._samples.push({ bytes, ts: now });
    // Evict samples older than window
    const cutoff = now - this._window;
    this._samples = this._samples.filter((s) => s.ts >= cutoff);
  }

  /** @returns {number} bytes/sec */
  getBytesPerSec() {
    if (this._samples.length < 2) return 0;
    const total = this._samples.reduce((sum, s) => sum + s.bytes, 0);
    const span  = this._samples[this._samples.length - 1].ts - this._samples[0].ts;
    return span > 0 ? (total / span) * 1000 : 0;
  }

  getFormatted() {
    const bps = this.getBytesPerSec();
    return `${formatBytes(bps)}/s`;
  }
}

// ─── DOM Helpers ──────────────────────────────────────────────────────────────
export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function setStatus(el, text, type = "info") {
  if (!el) return;
  const colorMap = {
    info:    "text-blue-400",
    success: "text-emerald-400",
    warning: "text-amber-400",
    error:   "text-red-400",
    muted:   "text-slate-400",
  };
  el.className = `text-sm font-medium ${colorMap[type] || colorMap.info} transition-colors duration-300`;
  el.textContent = text;
}

export function setProgress(barEl, labelEl, pct, label = "") {
  if (barEl) {
    barEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    barEl.setAttribute("aria-valuenow", pct.toFixed(0));
  }
  if (labelEl) labelEl.textContent = label || `${pct.toFixed(1)}%`;
}
