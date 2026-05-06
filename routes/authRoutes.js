// Express aur required libraries import kar rahe hain
import express from "express";
import bcrypt from "bcrypt";        // password hashing ke liye
import jwt from "jsonwebtoken";     // JWT token generate/verify ke liye
import Redis from "ioredis";        // Redis database

// Router instance create (modular routes ke liye)
const router = express.Router();

// JWT secret (production mein strong secret use karo)
const JWT_SECRET  = process.env.JWT_SECRET || "dev-secret-change-me-in-production";

// Password hash karne ke liye salt rounds (higher = more secure but slower)
const SALT_ROUNDS = 10;


// ─── Redis Client Setup ─────────────────────────────────────────

// Yeh function Redis client banata hai (Upstash + local dono support)
function createRedisClient(url) {
  // Agar URL nahi diya → default local Redis connect karega
  if (!url) return new Redis();

  const parsed = new URL(url);

  // Check TLS required hai ya nahi (rediss:// = secure)
  const isTLS  = url.startsWith("rediss://");

  return new Redis({
    host:     parsed.hostname,
    port:     parseInt(parsed.port, 10),
    password: decodeURIComponent(parsed.password),
    username: parsed.username || "default",

    // TLS enable agar secure connection hai
    tls:      isTLS ? { rejectUnauthorized: false } : undefined,
  });
}

// Redis instance create
const redis = createRedisClient(process.env.REDIS_URL);

// Redis error handling (debug ke liye useful)
redis.on("error", (err) => console.error("Auth Redis error:", err.message));


// ─── REGISTER ROUTE ─────────────────────────────────────────────
// POST /auth/register
router.post("/register", async (req, res) => {

  // Request body se email + password le rahe hain
  const { email, password } = req.body;

  // Basic validation
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  // Password length check
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  try {
    // Check karo user already exist karta hai ya nahi
    const existing = await redis.hget("users", email);

    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    // Password ko hash kar rahe hain (plain text kabhi store nahi karte)
    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    // Redis hash me store kar rahe hain
    // "users" = hash key, email = field, hash = value
    await redis.hset("users", email, hash);

    return res.status(201).json({ message: "Account created. You can now log in." });

  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Registration failed. Try again." });
  }
});


// ─── LOGIN ROUTE ───────────────────────────────────────────────
// POST /auth/login
router.post("/login", async (req, res) => {

  // Request body se credentials le rahe hain
  const { email, password } = req.body;

  // Basic validation
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    // Redis se stored password hash nikaal rahe hain
    const hash = await redis.hget("users", email);

    // Agar user exist nahi karta
    if (!hash) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Password compare (entered vs stored hash)
    const match = await bcrypt.compare(password, hash);

    if (!match) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // JWT token generate kar rahe hain (email payload me)
    const token = jwt.sign(
      { email },
      JWT_SECRET,
      { expiresIn: "24h" } // token valid for 24 hours
    );

    // Client ko token bhej rahe hain
    return res.json({ token });

  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed. Try again." });
  }
});


// Router export (app me use hoga)
export default router;