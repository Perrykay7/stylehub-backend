require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const authRoutes = require("./auth");
const ownerRoutes = require("./ownerRoutes");
const { requireAuth } = require("./authMiddleware");

const app = express();
app.use(cors());
app.use(express.json());

// --- File upload setup ---
const UPLOADS_DIR = path.join("/data", "uploads", "professionals");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// Serve uploaded images publicly
app.use("/uploads", express.static(path.join("/data", "uploads")));

const PORT = process.env.PORT || 4001;

// --- POST upload a professional's photo (owner only) ---
app.post(
  "/upload/professional-photo",
  requireAuth,
  upload.single("photo"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No photo uploaded" });
    }
    const photoUrl = `${req.protocol}://${req.get("host")}/uploads/professionals/${req.file.filename}`;
    res.json({ photoUrl });
  }
);
// --- POST upload a salon's photo (owner only) ---
const salonUploadsDir = path.join("/data", "uploads", "salons");
fs.mkdirSync(salonUploadsDir, { recursive: true });

const salonStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, salonUploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${uuidv4()}${ext}`);
  },
});
const salonUpload = multer({
  storage: salonStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

app.post(
  "/upload/salon-photo",
  requireAuth,
  salonUpload.single("photo"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No photo uploaded" });
    }
    const photoUrl = `${req.protocol}://${req.get("host")}/uploads/salons/${req.file.filename}`;
    res.json({ photoUrl });
  }
);
// --- Auth routes (public) ---
app.use("/auth", authRoutes);

// --- Owner routes (owner-only) ---
app.use("/owner", ownerRoutes);

// --- GET all salons (with services and reviews nested, rating computed live) ---
app.get("/salons", (req, res) => {
  const salons = db.prepare("SELECT * FROM salons ORDER BY createdAt DESC").all();

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

// --- POST a review for a salon (requires auth, one per user per salon, must have booked) ---
app.post("/salons/:id/reviews", requireAuth, (req, res) => {
  const { id: salonId } = req.params;
  const { rating, comment } = req.body;
  const userId = req.userId;

  if (!rating || !comment) {
    return res.status(400).json({ error: "Rating and comment are required" });
  }
  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Rating must be between 1 and 5" });
  }

  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(salonId);
  if (!salon) return res.status(404).json({ error: "Salon not found" });

  const hasBooked = db.prepare(
    "SELECT id FROM bookings WHERE salonId = ? AND userId = ? AND userId != 'guest'"
  ).get(salonId, userId);
  if (!hasBooked) {
    return res.status(403).json({ error: "You can only review salons you have booked at" });
  }

  const existing = db.prepare("SELECT id FROM reviews WHERE salonId = ? AND userId = ?").get(salonId, userId);
  if (existing) {
    return res.status(409).json({ error: "You have already reviewed this salon" });
  }

  const user = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
  const review = {
    id: uuidv4(),
    salonId,
    userId,
    customerName: user.name,
    rating: Number(rating),
    comment,
    date: new Date().toISOString().split("T")[0],
  };

  db.prepare(
    `INSERT INTO reviews (id, salonId, userId, customerName, rating, comment, date)
     VALUES (@id, @salonId, @userId, @customerName, @rating, @comment, @date)`
  ).run(review);

  res.status(201).json(review);
});

// --- GET professionals at a salon who perform a specific service ---
app.get("/salons/:id/professionals", (req, res) => {
  const { serviceId } = req.query;
  if (!serviceId) {
    return res.status(400).json({ error: "serviceId query parameter is required" });
  }

  const professionals = db
    .prepare(
      `SELECT p.* FROM professionals p
       INNER JOIN professional_services ps ON ps.professionalId = p.id
       WHERE p.salonId = ? AND ps.serviceId = ?`
    )
    .all(req.params.id, serviceId);

  const withRatings = professionals.map((pro) => {
    const stats = db
      .prepare(
        `SELECT AVG(rating) as avgRating, COUNT(*) as ratingCount
         FROM professional_ratings WHERE professionalId = ?`
      )
      .get(pro.id);
    return {
      ...pro,
      avgRating: stats.avgRating ? Math.round(stats.avgRating * 10) / 10 : null,
      ratingCount: stats.ratingCount,
    };
  });

  res.json(withRatings);
});

// --- GET already-booked time slots for a salon on a specific date ---
app.get("/salons/:id/booked-slots", (req, res) => {
  const { date, serviceId } = req.query;
  if (!date) {
    return res.status(400).json({ error: "date query parameter is required" });
  }

  const blocked = db
    .prepare("SELECT time FROM blocked_slots WHERE salonId = ? AND date = ?")
    .all(req.params.id, date);

  // If the salon is closed on this day of week, return all slots as unavailable
  const dayOfWeek = new Date(date).getDay();
  const dayHours = db
    .prepare("SELECT * FROM salon_hours WHERE salonId = ? AND dayOfWeek = ?")
    .get(req.params.id, dayOfWeek);
  if (dayHours?.isClosed) {
    return res.json(["CLOSED"]);
  }

  let fullTimes = [];

  if (serviceId) {
    // Get professionals who can perform this service at this salon
    const pros = db
      .prepare(
        `SELECT p.id FROM professionals p
         INNER JOIN professional_services ps ON ps.professionalId = p.id
         WHERE p.salonId = ? AND ps.serviceId = ?`
      )
      .all(req.params.id, serviceId);

    if (pros.length > 0) {
      // A slot is full only when ALL professionals for this service are booked at that time
      const placeholders = pros.map(() => "?").join(",");
      const proIds = pros.map((p) => p.id);
      const bookedAtTimes = db
        .prepare(
          `SELECT time, COUNT(DISTINCT professionalId) as bookedCount
           FROM bookings
           WHERE salonId = ? AND date = ? AND professionalId IN (${placeholders})
           GROUP BY time`
        )
        .all(req.params.id, date, ...proIds);

      fullTimes = bookedAtTimes
        .filter((r) => r.bookedCount >= pros.length)
        .map((r) => r.time);
    } else {
      // No professionals set up — fall back to one-per-slot
      fullTimes = db
        .prepare("SELECT time FROM bookings WHERE salonId = ? AND date = ?")
        .all(req.params.id, date)
        .map((r) => r.time);
    }
  } else {
    // No serviceId provided — fall back to one-per-slot
    fullTimes = db
      .prepare("SELECT time FROM bookings WHERE salonId = ? AND date = ?")
      .all(req.params.id, date)
      .map((r) => r.time);
  }

  const allUnavailable = [...new Set([...fullTimes, ...blocked.map((r) => r.time)])];
  res.json(allUnavailable);
});

// --- POST save push token for the logged-in user ---
app.post("/users/push-token", requireAuth, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token is required" });
  db.prepare("UPDATE users SET pushToken = ? WHERE id = ?").run(token, req.userId);
  res.json({ saved: true });
});

async function sendPushNotification(pushToken, title, body) {
  if (!pushToken || !pushToken.startsWith("ExponentPushToken")) return;
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: pushToken, title, body, sound: "default" }),
    });
  } catch {}
}

// --- POST create a booking (requires auth, checks for conflicts) ---
app.post("/bookings", requireAuth, (req, res) => {
  const { salonId, serviceId, salonName, serviceName, date, dateLabel, time, price, promoCode, professionalId } =
    req.body;

  if (!salonId || !serviceId || !date || !dateLabel || !time) {
    return res.status(400).json({ error: "Missing required booking fields" });
  }

  // Get professionals who can perform this service
  const qualifiedProfessionals = db
    .prepare(
      `SELECT p.id FROM professionals p
       INNER JOIN professional_services ps ON ps.professionalId = p.id
       WHERE p.salonId = ? AND ps.serviceId = ?`
    )
    .all(salonId, serviceId);

  let finalProfessionalId = professionalId || null;

  if (qualifiedProfessionals.length === 0) {
    // No professionals configured — one booking per slot
    const conflict = db
      .prepare("SELECT id FROM bookings WHERE salonId = ? AND date = ? AND time = ?")
      .get(salonId, date, time);
    if (conflict) {
      return res.status(409).json({ error: "This time slot was just booked by someone else. Please pick another." });
    }
  } else if (finalProfessionalId) {
    // Customer picked a specific professional — check that professional is free
    const conflict = db
      .prepare("SELECT id FROM bookings WHERE professionalId = ? AND date = ? AND time = ?")
      .get(finalProfessionalId, date, time);
    if (conflict) {
      return res.status(409).json({ error: "That professional is no longer available at this time. Please choose another." });
    }
  } else {
    // "No Preference" — check if all professionals for this service are fully booked at this time
    const proIds = qualifiedProfessionals.map((p) => p.id);
    const placeholders = proIds.map(() => "?").join(",");
    const bookedCount = db
      .prepare(
        `SELECT COUNT(DISTINCT professionalId) as count FROM bookings
         WHERE salonId = ? AND date = ? AND time = ? AND professionalId IN (${placeholders})`
      )
      .get(salonId, date, time, ...proIds);

    if (bookedCount.count >= proIds.length) {
      return res.status(409).json({ error: "This time slot is fully booked. Please pick another." });
    }

    // Auto-assign the professional with fewest bookings today who is free at this time
    const available = qualifiedProfessionals.filter((p) => {
      const alreadyBooked = db
        .prepare("SELECT id FROM bookings WHERE professionalId = ? AND date = ? AND time = ?")
        .get(p.id, date, time);
      return !alreadyBooked;
    });

    const counts = available.map((p) => {
      const count = db
        .prepare("SELECT COUNT(*) as count FROM bookings WHERE professionalId = ? AND date = ?")
        .get(p.id, date);
      return { id: p.id, count: count.count };
    });
    counts.sort((a, b) => a.count - b.count);
    finalProfessionalId = counts[0]?.id || null;
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
    professionalId: finalProfessionalId,
  };

  db.prepare(
    `INSERT INTO bookings (id, userId, salonId, serviceId, salonName, serviceName, date, dateLabel, time, price, originalPrice, discountAmount, createdAt, professionalId)
     VALUES (@id, @userId, @salonId, @serviceId, @salonName, @serviceName, @date, @dateLabel, @time, @price, @originalPrice, @discountAmount, @createdAt, @professionalId)`
  ).run(booking);

  const user = db.prepare("SELECT pushToken FROM users WHERE id = ?").get(req.userId);
  if (user?.pushToken) {
    sendPushNotification(
      user.pushToken,
      "Booking Confirmed! ✂️",
      `${salonName} · ${serviceName} on ${dateLabel} at ${time}`
    );
  }

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
    .prepare(
      `SELECT b.*, p.name AS professionalName,
       (SELECT COUNT(*) FROM professional_ratings WHERE bookingId = b.id) AS hasRating
       FROM bookings b
       LEFT JOIN professionals p ON b.professionalId = p.id
       WHERE b.userId = ?
       ORDER BY b.createdAt DESC`
    )
    .all(req.userId);
  res.json(bookings);
});

// --- POST submit a rating for a professional after a completed booking ---
app.post("/professionals/:id/ratings", requireAuth, (req, res) => {
  const { bookingId, rating, comment } = req.body;
  if (!bookingId || !rating) {
    return res.status(400).json({ error: "bookingId and rating are required" });
  }
  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Rating must be between 1 and 5" });
  }

  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
  if (!booking || booking.userId !== req.userId) {
    return res.status(404).json({ error: "Booking not found" });
  }
  if (booking.professionalId !== req.params.id) {
    return res.status(400).json({ error: "This booking is not associated with this professional" });
  }

  const existing = db
    .prepare("SELECT id FROM professional_ratings WHERE bookingId = ?")
    .get(bookingId);
  if (existing) {
    return res.status(409).json({ error: "You have already rated this booking" });
  }

  const newRating = {
    id: uuidv4(),
    professionalId: req.params.id,
    bookingId,
    userId: req.userId,
    rating,
    comment: comment || null,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO professional_ratings (id, professionalId, bookingId, userId, rating, comment, createdAt)
     VALUES (@id, @professionalId, @bookingId, @userId, @rating, @comment, @createdAt)`
  ).run(newRating);

  res.status(201).json(newRating);
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