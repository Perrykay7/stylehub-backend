const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

// --- POST /auth/register ---
router.post("/register", async (req, res) => {
  const { name, phone, password, role } = req.body;

  if (!name || !phone || !password) {
    return res.status(400).json({ error: "Name, phone, and password are required" });
  }

  const finalRole = role === "owner" ? "owner" : "customer";

  const existing = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (existing) {
    return res.status(409).json({ error: "An account with this phone number already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    name,
    phone,
    passwordHash,
    role: finalRole,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO users (id, name, phone, passwordHash, role, createdAt) VALUES (@id, @name, @phone, @passwordHash, @role, @createdAt)`
  ).run(user);

  const token = jwt.sign(
    { userId: user.id, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.status(201).json({
    token,
    user: { id: user.id, name: user.name, phone: user.phone, role: user.role },
  });
});

// --- POST /auth/login ---
router.post("/login", async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: "Phone and password are required" });
  }

  const user = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
  if (!user) {
    return res.status(401).json({ error: "Invalid phone number or password" });
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return res.status(401).json({ error: "Invalid phone number or password" });
  }

  const token = jwt.sign(
    { userId: user.id, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, phone: user.phone, role: user.role },
  });
});

module.exports = router;