/**
 * SonicDrop Signaling Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight WebSocket signaling server for WebRTC handshake coordination.
 *
 * Message protocol (all messages are JSON strings):
 *   → { type: "create-room", roomId: string }         (Receiver → Server)
 *   → { type: "join-room",   roomId: string }         (Sender   → Server)
 *   → { type: "signal",      roomId: string, data: RTCSdpInit | RTCIceCandidate } (Peer → Server → Peer)
 *
 *   ← { type: "room-created", roomId: string }        (Server → Receiver)
 *   ← { type: "peer-joined" }                         (Server → Receiver)
 *   ← { type: "room-joined",  roomId: string }        (Server → Sender)
 *   ← { type: "signal",       data: ... }             (Server → other Peer)
 *   ← { type: "error",        message: string }       (Server → Client)
 */

"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 8080;
const ROOM_TTL_MS   = 5 * 60 * 1000; // 5-minute inactivity TTL
const MAX_ROOM_PEERS = 2;

// ─── Room State ───────────────────────────────────────────────────────────────
/**
 * rooms: Map<roomId, { peers: Set<WebSocket>, timer: NodeJS.Timeout | null, createdAt: number }>
 */
const rooms = new Map();

// ─── MIME type map for static file serving ────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".wasm": "application/wasm",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

// ─── serveFile helper ─────────────────────────────────────────────────────────
function serveFile(fp, res) {
  const ext  = path.extname(fp).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type":  mime,
    "Cache-Control": "no-cache",
    "Service-Worker-Allowed": "/",
    "Cross-Origin-Opener-Policy":   "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    // Skip ngrok's browser-warning interstitial for all responses.
    "ngrok-skip-browser-warning":   "true",
  });
  fs.createReadStream(fp).pipe(res);
}

// ─── HTTP Server (static file serving) ───────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split("?")[0];

  // Fallback for Web Share Target POST if service worker not yet activated
  if (req.method === "POST" && urlPath === "/share-target") {
    res.writeHead(303, { Location: "/sender" });
    res.end();
    return;
  }

  // Clean URL routing
  const cleanRoutes = { "/": "/index.html", "/sender": "/sender.html" };
  urlPath = cleanRoutes[urlPath] ?? urlPath;

  const filePath = path.join(__dirname, "public", urlPath);

  const tryServe = (fp, cb) => {
    fs.stat(fp, (err, stat) => {
      if (!err && stat.isFile()) cb(fp);
      else cb(null);
    });
  };

  tryServe(filePath, (found) => {
    if (!found) {
      // extensionless fallback: try .html
      tryServe(filePath + ".html", (found2) => {
        if (!found2) { res.writeHead(404, {"Content-Type":"text/plain"}); res.end("404 Not Found"); return; }
        serveFile(found2, res);
      });
      return;
    }
    serveFile(found, res);
  });
});


// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${clientIp}`);

  ws._roomId = null; // track which room this socket belongs to

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "create-room":  handleCreateRoom(ws, msg);  break;
      case "join-room":    handleJoinRoom(ws, msg);    break;
      case "signal":       handleSignal(ws, msg);      break;
      default:
        send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on("close", () => {
    console.log(`[WS] Client disconnected: ${clientIp}`);
    cleanupSocket(ws);
  });

  ws.on("error", (err) => {
    console.error(`[WS] Socket error (${clientIp}):`, err.message);
    cleanupSocket(ws);
  });
});

// ─── Handler: create-room ─────────────────────────────────────────────────────
function handleCreateRoom(ws, msg) {
  const { roomId } = msg;

  if (!isValidRoomId(roomId)) {
    send(ws, { type: "error", message: "Invalid Room ID format (4 alphanumeric chars required)" });
    return;
  }

  if (rooms.has(roomId)) {
    // Room already exists — reuse (receiver reload case)
    const room = rooms.get(roomId);
    if (!room.peers.has(ws)) {
      room.peers.add(ws);
    }
    resetRoomTimer(roomId);
  } else {
    const timer = setTimeout(() => pruneRoom(roomId), ROOM_TTL_MS);
    rooms.set(roomId, { peers: new Set([ws]), timer, createdAt: Date.now() });
  }

  ws._roomId = roomId;
  send(ws, { type: "room-created", roomId });
  console.log(`[Room] Created: ${roomId} | Active rooms: ${rooms.size}`);
}

// ─── Handler: join-room ───────────────────────────────────────────────────────
function handleJoinRoom(ws, msg) {
  const { roomId } = msg;

  if (!isValidRoomId(roomId)) {
    send(ws, { type: "error", message: "Invalid Room ID" });
    return;
  }

  if (!rooms.has(roomId)) {
    send(ws, { type: "error", message: `Room "${roomId}" not found` });
    return;
  }

  const room = rooms.get(roomId);

  if (room.peers.size >= MAX_ROOM_PEERS) {
    send(ws, { type: "error", message: `Room "${roomId}" is full` });
    return;
  }

  room.peers.add(ws);
  ws._roomId = roomId;
  resetRoomTimer(roomId);

  send(ws, { type: "room-joined", roomId });

  // Notify the receiver that a sender peer has joined
  room.peers.forEach((peer) => {
    if (peer !== ws && peer.readyState === peer.OPEN) {
      send(peer, { type: "peer-joined" });
    }
  });

  console.log(`[Room] Joined: ${roomId} | Peers: ${room.peers.size}`);
}

// ─── Handler: signal (relay SDP / ICE) ───────────────────────────────────────
function handleSignal(ws, msg) {
  const { roomId, data } = msg;

  if (!rooms.has(roomId)) {
    send(ws, { type: "error", message: `Room "${roomId}" not found for signaling` });
    return;
  }

  const room = rooms.get(roomId);

  room.peers.forEach((peer) => {
    if (peer !== ws && peer.readyState === peer.OPEN) {
      send(peer, { type: "signal", data });
    }
  });
}

// ─── Utility: send JSON safely ────────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─── Utility: validate Room ID ────────────────────────────────────────────────
function isValidRoomId(id) {
  return typeof id === "string" && /^[A-Z0-9]{4}$/.test(id);
}

// ─── Utility: reset inactivity timer ─────────────────────────────────────────
function resetRoomTimer(roomId) {
  if (!rooms.has(roomId)) return;
  const room = rooms.get(roomId);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => pruneRoom(roomId), ROOM_TTL_MS);
}

// ─── Utility: prune empty/expired room ───────────────────────────────────────
function pruneRoom(roomId) {
  if (!rooms.has(roomId)) return;
  const room = rooms.get(roomId);
  clearTimeout(room.timer);
  room.peers.forEach((ws) => {
    try { ws.close(); } catch {}
  });
  rooms.delete(roomId);
  console.log(`[Room] Pruned: ${roomId} | Active rooms: ${rooms.size}`);
}

// ─── Utility: clean up socket on disconnect ───────────────────────────────────
function cleanupSocket(ws) {
  const roomId = ws._roomId;
  if (!roomId || !rooms.has(roomId)) return;

  const room = rooms.get(roomId);
  room.peers.delete(ws);

  if (room.peers.size === 0) {
    pruneRoom(roomId);
  } else {
    // Notify remaining peer
    room.peers.forEach((peer) => {
      if (peer.readyState === peer.OPEN) {
        send(peer, { type: "peer-left" });
      }
    });
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║                  🔊  SonicDrop  🔊                   ║
╠══════════════════════════════════════════════════════╣
║  Signaling server running on http://localhost:${PORT}  ║
║                                                      ║
║  Receiver (Desktop):  http://localhost:${PORT}/         ║
║  Sender   (Mobile):   http://localhost:${PORT}/sender   ║
║                                                      ║
║  ⚠  Mobile requires HTTPS for microphone access.    ║
║     Use a tunnel (ngrok/cloudflared) or mkcert.     ║
╚══════════════════════════════════════════════════════╝
  `);
});
