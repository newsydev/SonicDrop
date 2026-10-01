# 🔊 SonicDrop

> **Zero-click, zero-pairing file transfer** via near-ultrasound acoustic handshaking (18.5–20 kHz) + WebRTC DataChannels.  
> No QR codes. No pairing PINs. No cloud. Just bring your devices close together.

---

## How It Works

```
Desktop (Receiver)                     Mobile (Sender)
────────────────────                   ───────────────────
1. Generate Room ID "839A"             1. User selects a file
2. Emit inaudible ultrasound           2. Tap "Send File"
   beacon encoding "839A"  ──────►     3. Mic samples audio
   via speakers (18.5–20 kHz)          4. ggwave decodes "839A"
3. Both join WebSocket room ◄──────►   5. Both join same room
4. Exchange SDP Offer/Answer           6. Exchange ICE candidates
5. RTCDataChannel established          7. RTCDataChannel established
   ◄━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  8. Stream file in 64 KB chunks
6. Reassemble → auto-download              with backpressure handling
```

---

## Project Structure

```
sonicdrop/
├── server.js          ← Node.js WebSocket signaling server + static file host
├── package.json
├── README.md
└── public/
    ├── index.html     ← Receiver page (desktop)
    ├── sender.html    ← Sender page (mobile)
    └── utils.js       ← Shared ES module (Room ID gen, WebSocket, ICE config, helpers)
```

---

## Quick Start (Local / Desktop Testing)

> **Prerequisites:** Node.js ≥ 18

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
#    Receiver: http://localhost:8080
#    Sender:   http://localhost:8080/sender
```

> ⚠️ **Both tabs on the same machine** works for desktop testing.  
> For real mobile → desktop transfers, you need HTTPS (see below).

---

## HTTPS Setup for Mobile (Required for Mic Access)

Mobile browsers (`getUserMedia`) require a **secure context** — either `localhost` or HTTPS.

### Option A: ngrok (Easiest — No Install Needed)

```bash
# Terminal 1: start SonicDrop
npm start

# Terminal 2: expose via ngrok (free account)
npx ngrok http 8080
```

Copy the `https://xxxx.ngrok.io` URL, open it on both desktop and mobile.

### Option B: Cloudflare Tunnel (Free, No Account Needed)

```bash
# Windows (PowerShell)
winget install cloudflare.cloudflared

# Start tunnel
cloudflared tunnel --url http://localhost:8080
```

### Option C: mkcert (Local Trusted HTTPS)

```bash
# Install mkcert
winget install FiloSottile.mkcert

# Create local CA + certificate
mkcert -install
mkcert localhost 127.0.0.1 ::1 YOUR_LOCAL_IP

# Then update server.js to use https module with the cert files:
# (see server.js comments at the bottom)
```

### Option D: Local IP + Android/Chrome Flag

On Chrome for Android, navigate to `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add your local IP (e.g., `http://192.168.1.100:8080`), and enable it.

---

## Architecture Details

### Signaling Server (`server.js`)

| Feature | Implementation |
|---|---|
| Transport | Native Node.js `ws` WebSocket library |
| Room state | In-memory `Map<roomId, { peers: Set<WebSocket>, timer }>` |
| Max peers/room | 2 |
| Inactivity TTL | 5 minutes (auto-prune) |
| Message types | `create-room`, `join-room`, `signal`, `peer-joined`, `peer-left`, `error` |
| Static serving | Built-in HTTP server with MIME mapping + clean URLs |

### Audio DSP (`ggwave` v0.4.2)

| Setting | Value |
|---|---|
| Protocol | `GGWAVE_PROTOCOL_ULTRASOUND_FASTEST` (id=9) |
| Frequency range | ~18.5 kHz – 20 kHz |
| Sample rate | 48,000 Hz |
| Output gain cap | 0.5 (prevents speaker distortion on budget hardware) |
| Mic constraints | `echoCancellation: false, noiseSuppression: false, autoGainControl: false` |
| Decode buffer | 2048 samples (ScriptProcessorNode) |
| Beacon interval | Every 2 seconds |
| Decode timeout | 5 seconds → manual Room ID fallback |

### WebRTC Data Transfer

| Setting | Value |
|---|---|
| ICE servers | Google STUN ×3 |
| DataChannel | `ordered: true` (TCP-like reliability) |
| Chunk size | 64 KB |
| Backpressure high-water | 16 MB → pause |
| Backpressure low-water | 2 MB → resume |
| Metadata message | JSON: `{ name, size, mimeType }` (first message) |
| Data messages | Binary `ArrayBuffer` |

---

## Browser Compatibility

| Feature | Chrome | Firefox | Safari | Edge |
|---|---|---|---|---|
| WebRTC DataChannel | ✅ | ✅ | ✅ 15.4+ | ✅ |
| AudioContext 48kHz | ✅ | ✅ | ✅ | ✅ |
| ScriptProcessorNode | ✅ | ✅ | ✅ | ✅ |
| getUserMedia (HTTPS) | ✅ | ✅ | ✅ | ✅ |
| WebAssembly (ggwave) | ✅ | ✅ | ✅ | ✅ |

> 💡 **ScriptProcessorNode** is deprecated but has universal support. Upgrade path: replace with `AudioWorkletNode` for true zero-copy audio processing in a dedicated thread.

---

## Security Notes

- **No data touches any server** — all file bytes travel directly peer-to-peer via WebRTC DataChannel encrypted with DTLS.
- The signaling server only relays SDP/ICE messages (no file data ever).
- Room IDs are ephemeral and cryptographically random (32-symbol alphabet, 4 chars = ~1M combinations).
- The ultrasound beacon stops immediately once the WebRTC connection is established.

---

## Roadmap / Future Improvements

- [ ] Replace `ScriptProcessorNode` with `AudioWorkletProcessor` for off-main-thread decoding
- [ ] Add TURN server support for cross-NAT/firewall transfers
- [ ] Multi-file / directory zip streaming
- [ ] End-to-end encryption layer (ECDH key exchange + AES-GCM) on top of DTLS
- [ ] PWA manifest + Service Worker for installable mobile app
- [ ] WebCodecs API for hardware-accelerated audio encoding

---

## License

MIT — build something cool 🚀
