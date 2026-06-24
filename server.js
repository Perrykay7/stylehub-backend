require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const authRoutes = require("./auth");
const ownerRoutes = require("./ownerRoutes");
const { requireAuth } = require("./authMiddleware");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4001;

// --- Auth routes (public) ---
app.use("/auth", authRoutes);

// --- Owner routes (owner-only) ---
app.use("/owner", ownerRoutes);

// --- GET all salons (with services and reviews nested, rating computed live) ---
app.get("/salons", (req, res) => {
  const salons = db.prepare("SELECT * FROM salons").all();

  const fullSalons = salons.map((salon) => {
    const services = db
      .prepare("SELECT * FROM services WHERE salonId = ?")
      .all(salon.id);
    const reviews = db
      .prepare("SELECT * FROM reviews WHERE salonId = ?")
      .all(salon.id);

    const reviewCount = reviews.length;
    const rating =
      reviewCount === 0
        ? 0
        : Math.round(
            (reviews.reduce((sum, r) => sum + r.rating, 0) / reviewCount) * 10
          ) / 10;

    return { ...salon, rating, reviewCount, services, reviews };
  });

  res.json(fullSalons);
});

// --- GET single salon by id (rating computed live) ---
app.get("/salons/:id", (req, res) => {
  const salon = db
    .prepare("SELECT * FROM salons WHERE id = ?")
    .get(req.params.id);

  if (!salon) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const services = db
    .prepare("SELECT * FROM services WHERE salonId = ?")
    .all(salon.id);
  const reviews = db
    .prepare("SELECT * FROM reviews WHERE salonId = ?")
    .all(salon.id);

  const reviewCount = reviews.length;
  const rating =
    reviewCount === 0
      ? 0
      : Math.round(
          (reviews.reduce((sum, r) => sum + r.rating, 0) / reviewCount) * 10
        ) / 10;

  res.json({ ...salon, rating, reviewCount, services, reviews });
});

// --- GET already-booked time slots for a salon on a specific date ---
app.get("/salons/:id/booked-slots", (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: "date query parameter is required" });
  }

  const rows = db
    .prepare("SELECT time FROM bookings WHERE salonId = ? AND date = ?")
    .all(req.params.id, date);

  res.json(rows.map((r) => r.time));
});

// --- POST create a booking (requires auth, checks for conflicts) ---
app.post("/bookings", requireAuth, (req, res) => {
  const { salonId, serviceId, salonName, serviceName, date, dateLabel, time, price, promoCode } =
    req.body;

  if (!salonId || !serviceId || !date || !dateLabel || !time) {
    return res.status(400).json({ error: "Missing required booking fields" });
  }

  const conflict = db
    .prepare("SELECT id FROM bookings WHERE salonId = ? AND date = ? AND time = ?")
    .get(salonId, date, time);

  if (conflict) {
    return res.status(409).json({ error: "This time slot was just booked by someone else. Please pick another." });
  }

  let finalPrice = price;
  let discountAmount = 0;

  if (promoCode) {
    const normalizedCode = promoCode.trim().toUpperCase();
    const promo = db
      .prepare("SELECT * FROM promo_codes WHERE salonId = ? AND code = ? AND active = 1")
      .get(salonId, normalizedCode);

    const isExpired = promo?.expiresAt && new Date(promo.expiresAt) < new Date();

    let isAllowed = true;
    if (promo) {
      const recipients = db
        .prepare("SELECT userId FROM promo_code_recipients WHERE promoCodeId = ?")
        .all(promo.id);
      if (recipients.length > 0) {
        isAllowed = recipients.some((r) => r.userId === req.userId);
      }
    }

    if (promo && !isExpired && isAllowed) {
      discountAmount = Math.round(price * (promo.discountPercent / 100) * 100) / 100;
      finalPrice = Math.round((price - discountAmount) * 100) / 100;
    }
  }

  const booking = {
    id: uuidv4(),
    userId: req.userId,
    salonId,
    serviceId,
    salonName,
    serviceName,
    date,
    dateLabel,
    time,
    price: finalPrice,
    originalPrice: price,
    discountAmount,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO bookings (id, userId, salonId, serviceId, salonName, serviceName, date, dateLabel, time, price, originalPrice, discountAmount, createdAt)
     VALUES (@id, @userId, @salonId, @serviceId, @salonName, @serviceName, @date, @dateLabel, @time, @price, @originalPrice, @discountAmount, @createdAt)`
  ).run(booking);

  res.status(201).json(booking);
});
// --- DELETE cancel a booking (only if it belongs to this user) ---
app.delete("/bookings/:id", requireAuth, (req, res) => {
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);

  if (!booking || booking.userId !== req.userId) {
    return res.status(404).json({ error: "Booking not found" });
  }

  const appointmentDateTime = new Date(`${booking.date}T${booking.time}:00`);
  const hoursUntilAppointment = (appointmentDateTime.getTime() - Date.now()) / (1000 * 60 * 60);

  if (hoursUntilAppointment < 2) {
    return res.status(400).json({
      error: "Bookings can only be cancelled at least 2 hours before the appointment time.",
    });
  }

  db.prepare("DELETE FROM bookings WHERE id = ?").run(req.params.id);
  res.json({ deleted: true });
});
// --- GET bookings for the logged-in user only ---
app.get("/bookings", requireAuth, (req, res) => {
  const bookings = db
    .prepare("SELECT * FROM bookings WHERE userId = ? ORDER BY createdAt DESC")
    .all(req.userId);
  res.json(bookings);
});
// --- POST validate a promo code for a salon ---
app.post("/promo-codes/validate", requireAuth, (req, res) => {
  const { salonId, code } = req.body;
  if (!salonId || !code) {
    return res.status(400).json({ error: "salonId and code are required" });
  }

  const normalizedCode = code.trim().toUpperCase();

  const promoCode = db
    .prepare("SELECT * FROM promo_codes WHERE salonId = ? AND code = ? AND active = 1")
    .get(salonId, normalizedCode);

  if (!promoCode) {
    return res.status(404).json({ error: "Invalid or inactive promo code" });
  }

  if (promoCode.expiresAt && new Date(promoCode.expiresAt) < new Date()) {
    return res.status(400).json({ error: "This promo code has expired" });
  }

  const recipients = db
    .prepare("SELECT userId FROM promo_code_recipients WHERE promoCodeId = ?")
    .all(promoCode.id);

  if (recipients.length > 0) {
    const isAllowed = recipients.some((r) => r.userId === req.userId);
    if (!isAllowed) {
      return res.status(403).json({ error: "This promo code isn't available for your account" });
    }
  }

  res.json({
    code: promoCode.code,
    discountPercent: promoCode.discountPercent,
  });
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(`StyleHub backend running on http://0.0.0.0:${PORT}`);
});