import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import authRoutes from "../routes/authRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me-in-production";
const TOTAL_CHECKBOXES = process.env.TOTAL_CHECKBOXES
  ? parseInt(process.env.TOTAL_CHECKBOXES, 10)
  : 1_000_000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Serve frontend from /public ──────────────────────────────────────────────
// __dirname = /app, public folder root mein hai, isliye ".." se upar jaate hain
app.use(express.static(join(__dirname, "..", "public")));
app.use("/auth", authRoutes);

// ─── Redis connections ─────────────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL;

function maskedUrl(url) {
  if (!url) return "(not set)";
  return url.replace(/:\/\/([^@]+)@/, "//:****@");
}

console.log(`Using REDIS_URL=${maskedUrl(REDIS_URL)}`);
console.log("REDIS_URL SET:", REDIS_URL ? "✅" : "❌");

// Upstash rediss:// (TLS) aur normal redis:// dono handle karta hai
function createRedisClient(url) {
  if (!url) return new Redis();

  const parsed = new URL(url);
  const isTLS  = url.startsWith("rediss://");

  return new Redis({
    host:     parsed.hostname,
    port:     parseInt(parsed.port, 10),
    password: decodeURIComponent(parsed.password),
    username: parsed.username || "default",
    tls:      isTLS ? { rejectUnauthorized: false } : undefined,
  });
}

const redis = createRedisClient(REDIS_URL);
const pub   = createRedisClient(REDIS_URL);
const sub   = createRedisClient(REDIS_URL);

// Log Redis connection errors cleanly
[redis, pub, sub].forEach((r, i) => {
  const name = ["main", "pub", "sub"][i];
  r.on("error", (err) => console.error(`Redis [${name}] error:`, err.message));
});

const CHANNEL      = "checkbox_updates";
const BITFIELD_KEY = "checkboxes";

// ─── Pub/Sub subscriber ────────────────────────────────────────────────────────
sub.subscribe(CHANNEL, (err) => {
  if (err) console.error("Pub/Sub subscribe failed:", err);
  else     console.log(`Subscribed to Redis channel: ${CHANNEL}`);
});

sub.on("message", (_channel, message) => {
  const data = JSON.parse(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({
        type:  "UPDATE",
        index: data.index,
        value: data.value,
      }));
    }
  });
});

// ─── Custom rate limiter ───────────────────────────────────────────────────────
const MAX_EVENTS_PER_SECOND = 10;

async function isRateLimited(userId) {
  const key   = `rate:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 1);
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

// ─── State endpoint ────────────────────────────────────────────────────────────
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

// Root fallback
app.get("/", (_req, res) => {
  res.sendFile(join(__dirname, "..", "public", "index.html"));
});

// ─── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

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
      ws.close(4001, "Invalid or expired token.");
      return;
    }
  } else {
    ws.close(4000, "Authentication required.");
    return;
  }

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
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
  console.log(`Public URL: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}?token=<jwt>`);
  console.log(`Total checkboxes: ${TOTAL_CHECKBOXES.toLocaleString()}`);
});