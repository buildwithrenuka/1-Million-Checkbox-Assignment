import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import Redis from "ioredis";

// Auth routes overview (steps):
// 1) Validate input (email, password).
// 2) For register: check existing user, hash password with bcrypt, store in Redis hash `users`.
// 3) For login: fetch hash from Redis, compare with bcrypt, return a JWT on success.
// 4) Keep errors and status codes clear for the client.

const router = express.Router();
const redis = new Redis();

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me-in-production";
const SALT_ROUNDS = 10;

// POST /auth/register
// Register endpoint
router.post("/register", async (req, res) => {
  // Step 1: Basic validation
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  try {
    // Step 2: Check existing user in Redis hash `users`
    const existing = await redis.hget("users", email);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    // Step 3: Hash password and store
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await redis.hset("users", email, hash);

    // Step 4: Respond success
    return res.status(201).json({ message: "Account created. You can now log in." });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Registration failed. Try again." });
  }
});

// POST /auth/login
// Login endpoint
router.post("/login", async (req, res) => {
  // Step 1: Basic validation
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    // Step 2: Fetch stored hash for this email
    const hash = await redis.hget("users", email);
    if (!hash) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Step 3: Compare password with bcrypt
    const match = await bcrypt.compare(password, hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Step 4: Sign and return JWT (short-lived)
    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "24h" });
    return res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed. Try again." });
  }
});

export default router;