import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import Redis from "ioredis";

const router = express.Router();

const JWT_SECRET  = process.env.JWT_SECRET || "dev-secret-change-me-in-production";
const SALT_ROUNDS = 10;

// ─── Redis client — Upstash (rediss://) aur normal (redis://) dono support ───
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

const redis = createRedisClient(process.env.REDIS_URL);

redis.on("error", (err) => console.error("Auth Redis error:", err.message));

// POST /auth/register
router.post("/register", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  try {
    const existing = await redis.hget("users", email);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await redis.hset("users", email, hash);

    return res.status(201).json({ message: "Account created. You can now log in." });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Registration failed. Try again." });
  }
});

// POST /auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const hash = await redis.hget("users", email);
    if (!hash) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const match = await bcrypt.compare(password, hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "24h" });
    return res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed. Try again." });
  }
});

export default router;