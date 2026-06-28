const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { requireAuth } = require("./authMiddleware");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

function getCurrentInviteCode() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'owner_invite_code'").get();
  return row ? row.value : "";
}

// --- POST /auth/register ---
router.post("/register", async (req, res) => {
  const { name, phone, password, role, inviteCode } = req.body;

  if (!name || !phone || !password) {
    return res.status(400).json({ error: "Name, phone, and password are required" });
  }

  const wantsOwner = role === "owner";

  if (wantsOwner) {
    const currentCode = getCurrentInviteCode();
    if (!currentCode) {
      return res.status(403).json({ error: "Owner sign-up is not available right now" });
    }
    if (!inviteCode || inviteCode !== currentCode) {
      return res.status(403).json({ error: "Invalid owner invite code" });
    }
  }

  const finalRole = wantsOwner ? "owner" : "customer";

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
    ownerCode: wantsOwner ? getCurrentInviteCode() : null,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO users (id, name, phone, passwordHash, role, ownerCode, createdAt) VALUES (@id, @name, @phone, @passwordHash, @role, @ownerCode, @createdAt)`
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

// --- POST /auth/forgot-password ---
router.post("/forgot-password", async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  const user = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
  if (!user) {
    return res.status(404).json({ error: "No account found with that phone number" });
  }

  const code = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  db.prepare(
    "INSERT OR REPLACE INTO password_resets (phone, code, expiresAt) VALUES (?, ?, ?)"
  ).run(phone, code, expiresAt);

  // TODO: replace this console.log with a real SMS send once an SMS provider is set up
  console.log(`Password reset code for ${phone}: ${code}`);

  res.json({ message: "A reset code has been sent to your phone." });
});

// --- POST /auth/reset-password ---
router.post("/reset-password", async (req, res) => {
  const { phone, code, newPassword } = req.body;

  if (!phone || !code || !newPassword) {
    return res.status(400).json({ error: "Phone, code, and new password are required" });
  }

  const resetEntry = db
    .prepare("SELECT * FROM password_resets WHERE phone = ?")
    .get(phone);

  if (!resetEntry || resetEntry.code !== code) {
    return res.status(400).json({ error: "Invalid or expired code" });
  }

  if (new Date(resetEntry.expiresAt) < new Date()) {
    return res.status(400).json({ error: "This code has expired. Please request a new one." });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  db.prepare("UPDATE users SET passwordHash = ? WHERE phone = ?").run(passwordHash, phone);
  db.prepare("DELETE FROM password_resets WHERE phone = ?").run(phone);

  res.json({ message: "Password updated successfully. You can now log in." });
});
// --- DELETE /auth/account ---
router.delete("/account", requireAuth, async (req, res) => {
  const userId = req.userId;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);

  if (!user) {
    return res.status(404).json({ error: "Account not found" });
  }

  // Delete bookings made by this user
  db.prepare("DELETE FROM bookings WHERE userId = ?").run(userId);

  // If this user owns any salons, cascade-delete everything tied to them
  const ownedSalons = db.prepare("SELECT id FROM salons WHERE ownerId = ?").all(userId);
  ownedSalons.forEach((salon) => {
    const promoCodes = db.prepare("SELECT id FROM promo_codes WHERE salonId = ?").all(salon.id);
    promoCodes.forEach((promo) => {
      db.prepare("DELETE FROM promo_code_recipients WHERE promoCodeId = ?").run(promo.id);
    });
    db.prepare("DELETE FROM promo_codes WHERE salonId = ?").run(salon.id);
    db.prepare("DELETE FROM services WHERE salonId = ?").run(salon.id);
    db.prepare("DELETE FROM reviews WHERE salonId = ?").run(salon.id);
    db.prepare("DELETE FROM bookings WHERE salonId = ?").run(salon.id);
  });
  db.prepare("DELETE FROM salons WHERE ownerId = ?").run(userId);

  // Clean up any password reset entries
  db.prepare("DELETE FROM password_resets WHERE phone = ?").run(user.phone);

  // Finally, delete the user
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);

  res.json({ deleted: true });
});
// --- PUT /auth/admin/invite-code — update referral code, downgrade unverified owners ---
router.put("/admin/invite-code", (req, res) => {
  const { newCode } = req.body;
  const secret = req.headers["x-admin-secret"];

  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  if (!newCode || typeof newCode !== "string" || !newCode.trim()) {
    return res.status(400).json({ error: "newCode is required" });
  }

  const code = newCode.trim();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('owner_invite_code', ?)").run(code);

  // Downgrade owners who verified with the old code
  const downgraded = db.prepare(
    "UPDATE users SET role = 'customer' WHERE role = 'owner' AND (ownerCode IS NULL OR ownerCode != ?)"
  ).run(code);

  res.json({ message: "Invite code updated", ownersDowngraded: downgraded.changes });
});

// --- POST /auth/reverify-owner — lets an existing account re-verify with the new code ---
router.post("/reverify-owner", requireAuth, (req, res) => {
  const { inviteCode } = req.body;
  const currentCode = getCurrentInviteCode();

  if (!currentCode) {
    return res.status(403).json({ error: "Owner sign-up is not available right now" });
  }
  if (!inviteCode || inviteCode !== currentCode) {
    return res.status(403).json({ error: "Invalid owner invite code" });
  }

  db.prepare("UPDATE users SET role = 'owner', ownerCode = ? WHERE id = ?").run(currentCode, req.userId);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
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

// --- PUT /auth/profile — update name and/or phone ---
router.put("/profile", requireAuth, async (req, res) => {
  const { name, phone, currentPassword, newPassword } = req.body;

  if (!name && !phone && !newPassword) {
    return res.status(400).json({ error: "Nothing to update" });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (phone && phone !== user.phone) {
    const existing = db.prepare("SELECT id FROM users WHERE phone = ? AND id != ?").get(phone, req.userId);
    if (existing) return res.status(409).json({ error: "That phone number is already in use" });
  }

  let passwordHash = user.passwordHash;
  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: "Current password is required to set a new one" });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
    passwordHash = await bcrypt.hash(newPassword, 10);
  }

  const updatedName = name || user.name;
  const updatedPhone = phone || user.phone;

  db.prepare("UPDATE users SET name = ?, phone = ?, passwordHash = ? WHERE id = ?")
    .run(updatedName, updatedPhone, passwordHash, req.userId);

  const token = jwt.sign(
    { userId: req.userId, name: updatedName, role: user.role },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.json({
    token,
    user: { id: req.userId, name: updatedName, phone: updatedPhone, role: user.role },
  });
});

module.exports = router;