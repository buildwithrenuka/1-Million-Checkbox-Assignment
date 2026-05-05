import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import authRoutes from "./routes/authRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Overview of server flow (step-by-step):
// 1) Load libraries and configuration (JWT secret, total checkboxes).
// 2) Setup middleware and static file serving for the frontend.
// 3) Create three Redis clients: main, publisher, subscriber.
// 4) Subscribe to Redis channel and forward published updates to WebSocket clients.
// 5) Implement a small rate limiter using Redis counters.
// 6) Provide `/state` endpoint that returns the full bitfield as booleans.
// 7) Accept WebSocket connections (authenticate via JWT), handle toggle requests,
//    and broadcast user counts and updates.

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me-in-production";
const TOTAL_CHECKBOXES = process.env.TOTAL_CHECKBOXES
  ? parseInt(process.env.TOTAL_CHECKBOXES, 10)
  : 1_000_000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Serve frontend from /public ──────────────────────────────────────────────
app.use(express.static(join(__dirname, "public")));

app.use("/auth", authRoutes);

// ─── Redis connections ─────────────────────────────────────────────────────────
// Keep pub and sub on dedicated connections — ioredis blocks a connection in
// subscriber mode, so mixing pub/sub with normal commands on the same client
// causes an error.
const redis = new Redis(process.env.REDIS_URL || undefined);
const pub   = new Redis(process.env.REDIS_URL || undefined);
const sub   = new Redis(process.env.REDIS_URL || undefined);

// Log Redis connection errors cleanly instead of crashing
[redis, pub, sub].forEach((r, i) => {
  const name = ["main", "pub", "sub"][i];
  r.on("error", (err) => console.error(`Redis [${name}] error:`, err.message));
});

const CHANNEL      = "checkbox_updates";
const BITFIELD_KEY = "checkboxes";

// ─── Pub/Sub subscriber ────────────────────────────────────────────────────────
// Subscribe to Redis channel for checkbox updates. On error, log it.
sub.subscribe(CHANNEL, (err) => {
  if (err) console.error("Pub/Sub subscribe failed:", err);
  else console.log(`Subscribed to Redis channel: ${CHANNEL}`);
});

// When a message is published on the Redis channel, forward it to all WS clients.
sub.on("message", (_channel, message) => {
  const data = JSON.parse(message); // { index, value }

  wss.clients.forEach((client) => {
    if (client.readyState === 1 /* OPEN */) {
      client.send(JSON.stringify({
        type: "UPDATE",
        index: data.index,
        value: data.value,
      }));
    }
  });
});

// ─── Custom rate limiter ───────────────────────────────────────────────────────
// Uses a Redis counter with a 1-second TTL per user.
// Allows up to MAX_EVENTS toggles per second. No third-party package.
const MAX_EVENTS_PER_SECOND = 10;

async function isRateLimited(userId) {
  const key   = `rate:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 1);
  }
  return count > MAX_EVENTS_PER_SECOND;
}

// ─── Checkbox toggle helper ────────────────────────────────────────────────────
async function toggleCheckbox(index) {
  if (index < 0 || index >= TOTAL_CHECKBOXES) {
    throw new RangeError(`Index ${index} out of range`);
  }

  const byteIndex = Math.floor(index / 8);
  const bitIndex  = index % 8;
  const mask      = 1 << bitIndex;

  const bufBefore = await redis.getrangeBuffer(BITFIELD_KEY, byteIndex, byteIndex);
  const byte      = bufBefore.length ? bufBefore[0] : 0;
  const newByte   = byte ^ mask;
  const newValue  = (newByte & mask) !== 0;

  await redis.setrange(BITFIELD_KEY, byteIndex, Buffer.from([newByte]));
  await pub.publish(CHANNEL, JSON.stringify({ index, value: newValue }));

  return newValue;
}

// ─── State endpoint (public) ───────────────────────────────────────────────────
app.get("/state", async (req, res) => {
  try {
    const totalBytes = Math.ceil(TOTAL_CHECKBOXES / 8);
    const buf = await redis.getrangeBuffer(BITFIELD_KEY, 0, totalBytes - 1);

    const bits = [];
    for (let i = 0; i < TOTAL_CHECKBOXES; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex  = i % 8;
      const byte      = byteIndex < buf.length ? buf[byteIndex] : 0;
      bits.push((byte & (1 << bitIndex)) !== 0);
    }

    res.json(bits);
  } catch (err) {
    console.error("State fetch error:", err);
    res.status(500).json({ error: "Failed to load state." });
  }
});

// Root — serve index.html (static middleware handles it, this is a fallback)
app.get("/", (_req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
});

// ─── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─── Broadcast live user count ─────────────────────────────────────────────────
function broadcastUserCount() {
  const count = wss.clients.size;
  const msg   = JSON.stringify({ type: "USERS", count });
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

// ─── WebSocket connection handler ──────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const url   = new URL(req.url, "ws://localhost");
  const token = url.searchParams.get("token");

  let user = null;

  if (token) {
    try {
      user = jwt.verify(token, JWT_SECRET);
    } catch {
      // Token invalid or expired: close connection with code 4001
      ws.close(4001, "Invalid or expired token.");
      return;
    }
  } else {
    // No token provided: require authentication
    ws.close(4000, "Authentication required.");
    return;
  }

  // Log connection (without emoji)
  console.log(`WS connected: ${user.email}`);
  broadcastUserCount();

  ws.on("message", async (raw) => {
    let payload;

    try {
      payload = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "ERROR", message: "Invalid JSON." }));
      return;
    }

    const { index } = payload;

    if (typeof index !== "number" || !Number.isInteger(index)) {
      ws.send(JSON.stringify({ type: "ERROR", message: "index must be an integer." }));
      return;
    }

    const limited = await isRateLimited(user.email).catch(() => false);
    if (limited) {
      ws.send(JSON.stringify({ type: "RATE_LIMIT", message: "Slow down." }));
      return;
    }

    try {
      await toggleCheckbox(index);
    } catch (err) {
      console.error("Toggle error:", err);
      ws.send(JSON.stringify({ type: "ERROR", message: err.message }));
    }
  });

  ws.on("close", () => {
    console.log(`WS disconnected: ${user?.email ?? "anon"}`);
    broadcastUserCount();
  });

  ws.on("error", (err) => {
    console.error("WS error:", err.message);
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}?token=<jwt>`);
  console.log(`Total checkboxes: ${TOTAL_CHECKBOXES.toLocaleString()}`);
});