require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const authRoutes = require("./auth");
const ownerRoutes = require("./ownerRoutes");
const professionalRoutes = require("./professionalRoutes");
const { requireAuth } = require("./authMiddleware");
const { attachImages } = require("./serviceImages");
const { initChatServer, sendMessage } = require("./chat");
const {
  generateTimeSlots,
  isProfessionalUnavailable,
  isProfessionalOffAllDay,
  isSlotFullyBooked,
} = require("./professionalAvailability");

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
// --- POST upload a service's photo (owner only) ---
const serviceUploadsDir = path.join("/data", "uploads", "services");
fs.mkdirSync(serviceUploadsDir, { recursive: true });

const serviceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, serviceUploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${uuidv4()}${ext}`);
  },
});
const serviceUpload = multer({
  storage: serviceStorage,
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
  "/upload/service-photo",
  requireAuth,
  serviceUpload.single("photo"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No photo uploaded" });
    }
    const photoUrl = `${req.protocol}://${req.get("host")}/uploads/services/${req.file.filename}`;
    res.json({ photoUrl });
  }
);
// --- Auth routes (public) ---
app.use("/auth", authRoutes);

// --- Owner routes (owner-only) ---
app.use("/owner", ownerRoutes);
app.use("/professional", professionalRoutes);

// --- GET all salons (with services and reviews nested, rating computed live) ---
app.get("/salons", (req, res) => {
  const salons = db.prepare("SELECT * FROM salons ORDER BY createdAt DESC").all();

  const fullSalons = salons.map((salon) => {
    const services = attachImages(
      db.prepare("SELECT * FROM services WHERE salonId = ?").all(salon.id)
    );
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

  const services = attachImages(
    db.prepare("SELECT * FROM services WHERE salonId = ?").all(salon.id)
  );
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

// --- GET the logged-in customer's chat with a salon ---
app.get("/salons/:id/messages", requireAuth, (req, res) => {
  const salon = db.prepare("SELECT id FROM salons WHERE id = ?").get(req.params.id);
  if (!salon) return res.status(404).json({ error: "Salon not found" });

  const messages = db
    .prepare(
      `SELECT * FROM messages WHERE salonId = ? AND customerId = ? ORDER BY createdAt ASC`
    )
    .all(req.params.id, req.userId);

  db.prepare(
    `UPDATE messages SET readByCustomer = 1
     WHERE salonId = ? AND customerId = ? AND senderRole = 'owner' AND readByCustomer = 0`
  ).run(req.params.id, req.userId);

  res.json(messages);
});

// --- POST send a chat message to a salon as the logged-in customer ---
app.post("/salons/:id/messages", requireAuth, (req, res) => {
  const salon = db.prepare("SELECT id FROM salons WHERE id = ?").get(req.params.id);
  if (!salon) return res.status(404).json({ error: "Salon not found" });

  const body = (req.body.body || "").trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: "Message cannot be empty" });

  const message = sendMessage({
    salonId: req.params.id,
    customerId: req.userId,
    senderRole: "customer",
    body,
  });

  res.status(201).json(message);
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
  const { serviceId, date } = req.query;
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
      unavailableAllDay: date ? isProfessionalOffAllDay(pro.id, date) : false,
    };
  });

  res.json(withRatings);
});

// --- GET already-booked time slots for a salon on a specific date ---
// Pass professionalId to get that specific professional's own busy slots
// instead of the salon-wide "every qualified professional is busy" slots.
app.get("/salons/:id/booked-slots", (req, res) => {
  const { date, serviceId, professionalId } = req.query;
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

  if (professionalId) {
    // A specific professional was picked — show only their own busy times.
    if (isProfessionalOffAllDay(professionalId, date)) {
      const salon = db.prepare("SELECT openTime, closeTime FROM salons WHERE id = ?").get(req.params.id);
      fullTimes = salon ? generateTimeSlots(salon.openTime, salon.closeTime) : [];
    } else {
      const bookedTimes = db
        .prepare("SELECT time FROM bookings WHERE professionalId = ? AND date = ?")
        .all(professionalId, date)
        .map((r) => r.time);
      const unavailableTimes = db
        .prepare("SELECT time FROM professional_unavailability WHERE professionalId = ? AND date = ? AND time IS NOT NULL")
        .all(professionalId, date)
        .map((r) => r.time);
      fullTimes = [...bookedTimes, ...unavailableTimes];
    }
  } else if (serviceId) {
    // Get professionals who can perform this service at this salon
    const pros = db
      .prepare(
        `SELECT p.id FROM professionals p
         INNER JOIN professional_services ps ON ps.professionalId = p.id
         WHERE p.salonId = ? AND ps.serviceId = ?`
      )
      .all(req.params.id, serviceId);

    if (pros.length > 0) {
      // A slot is full only when EVERY professional for this service is
      // either booked or marked unavailable (owner time-off) at that time.
      const salon = db.prepare("SELECT openTime, closeTime FROM salons WHERE id = ?").get(req.params.id);
      const allSlots = salon ? generateTimeSlots(salon.openTime, salon.closeTime) : [];
      fullTimes = allSlots.filter((time) =>
        pros.every((p) => {
          const booked = db
            .prepare("SELECT id FROM bookings WHERE professionalId = ? AND date = ? AND time = ?")
            .get(p.id, date, time);
          return !!booked || isProfessionalUnavailable(p.id, date, time);
        })
      );
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

const { notify } = require("./notify");
const { autoAssignStaleBookings, findFreeQualifiedProfessionals } = require("./bookingAssignment");
const { generateCancellationReminders } = require("./reminders");
const { checkLoyaltyMilestone } = require("./loyalty");
const { checkWaitlistOnFreedSlot } = require("./waitlist");

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
  let noPreference = false;
  let professionalsToNotify = [];

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
    if (conflict || isProfessionalUnavailable(finalProfessionalId, date, time)) {
      return res.status(409).json({ error: "That professional is not available at this time. Please choose another." });
    }
  } else {
    // "No Preference" — leave unassigned so any qualified, free professional can
    // claim it. Only fall back to auto-assignment if nobody claims it in time
    // (see autoAssignStaleBookings, called lazily whenever bookings are read).
    const available = findFreeQualifiedProfessionals(salonId, serviceId, date, time);

    if (available.length === 0) {
      return res.status(409).json({ error: "This time slot is fully booked. Please pick another." });
    }

    noPreference = true;
    professionalsToNotify = available.map((p) => p.id);
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
    noPreference: noPreference ? 1 : 0,
  };

  db.prepare(
    `INSERT INTO bookings (id, userId, salonId, serviceId, salonName, serviceName, date, dateLabel, time, price, originalPrice, discountAmount, createdAt, professionalId, noPreference)
     VALUES (@id, @userId, @salonId, @serviceId, @salonName, @serviceName, @date, @dateLabel, @time, @price, @originalPrice, @discountAmount, @createdAt, @professionalId, @noPreference)`
  ).run(booking);

  notify(
    req.userId,
    "Booking Confirmed! ✂️",
    `${salonName} · ${serviceName} on ${dateLabel} at ${time}`,
    "booking_confirmed",
    { bookingId: booking.id }
  );

  checkLoyaltyMilestone(salonId, req.userId, salonName);

  if (noPreference && professionalsToNotify.length > 0) {
    const placeholders = professionalsToNotify.map(() => "?").join(",");
    const proUsers = db
      .prepare(
        `SELECT u.id AS userId FROM professionals p
         INNER JOIN users u ON u.id = p.userId
         WHERE p.id IN (${placeholders})`
      )
      .all(...professionalsToNotify);
    proUsers.forEach((u) => {
      notify(
        u.userId,
        "New booking available 💈",
        `${serviceName} on ${dateLabel} at ${time} — tap to accept it`,
        "new_open_job",
        { bookingId: booking.id }
      );
    });
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

  db.prepare(
    `INSERT INTO booking_events (id, bookingId, salonId, serviceId, professionalId, price, date, eventType, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'cancelled', ?)`
  ).run(
    uuidv4(),
    booking.id,
    booking.salonId,
    booking.serviceId,
    booking.professionalId,
    booking.price,
    booking.date,
    new Date().toISOString()
  );

  db.prepare("DELETE FROM bookings WHERE id = ?").run(req.params.id);

  // Notify the salon owner about the cancellation
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(booking.salonId);
  if (salon?.ownerId) {
    const customer = db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId);
    notify(
      salon.ownerId,
      "Booking Cancelled ❌",
      `${customer?.name || "A customer"} cancelled ${booking.serviceName} on ${booking.dateLabel} at ${booking.time}`,
      "booking_cancelled",
      { bookingId: booking.id }
    );
  }

  checkWaitlistOnFreedSlot(booking.salonId, booking.serviceId, booking.date, booking.time, booking.professionalId);

  res.json({ deleted: true });
});

// --- POST join the waitlist for a fully-booked slot ---
app.post("/waitlist", requireAuth, (req, res) => {
  const { salonId, serviceId, professionalId, date, time, dateLabel, salonName, serviceName } = req.body;
  if (!salonId || !serviceId || !date || !time || !dateLabel || !salonName || !serviceName) {
    return res.status(400).json({ error: "Missing required waitlist fields" });
  }

  if (!isSlotFullyBooked(salonId, serviceId, date, time)) {
    return res.status(400).json({ error: "This slot still has openings — just book it directly." });
  }

  const existing = db
    .prepare(
      `SELECT id FROM waitlist_entries
       WHERE userId = ? AND salonId = ? AND serviceId = ? AND date = ? AND time = ?
       AND (professionalId IS ? OR professionalId = ?)`
    )
    .get(req.userId, salonId, serviceId, date, time, professionalId || null, professionalId || null);
  if (existing) {
    return res.status(409).json({ error: "You're already on the waitlist for this slot." });
  }

  const entry = {
    id: uuidv4(),
    userId: req.userId,
    salonId,
    serviceId,
    professionalId: professionalId || null,
    date,
    time,
    dateLabel,
    salonName,
    serviceName,
    notified: 0,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO waitlist_entries (id, userId, salonId, serviceId, professionalId, date, time, dateLabel, salonName, serviceName, notified, createdAt)
     VALUES (@id, @userId, @salonId, @serviceId, @professionalId, @date, @time, @dateLabel, @salonName, @serviceName, @notified, @createdAt)`
  ).run(entry);

  res.status(201).json(entry);
});

// --- GET the logged-in customer's waitlist entries ---
app.get("/my-waitlist", requireAuth, (req, res) => {
  const entries = db
    .prepare("SELECT * FROM waitlist_entries WHERE userId = ? ORDER BY createdAt DESC")
    .all(req.userId);
  res.json(entries);
});

// --- DELETE leave a waitlist entry ---
app.delete("/waitlist/:id", requireAuth, (req, res) => {
  const entry = db.prepare("SELECT * FROM waitlist_entries WHERE id = ?").get(req.params.id);
  if (!entry || entry.userId !== req.userId) {
    return res.status(404).json({ error: "Waitlist entry not found" });
  }
  db.prepare("DELETE FROM waitlist_entries WHERE id = ?").run(req.params.id);
  res.json({ deleted: true });
});

// --- GET bookings for the logged-in user only ---
app.get("/bookings", requireAuth, (req, res) => {
  autoAssignStaleBookings();
  generateCancellationReminders();
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

// --- GET the logged-in customer's favorited salon ids ---
app.get("/favorites", requireAuth, (req, res) => {
  const rows = db
    .prepare("SELECT salonId FROM favorites WHERE userId = ? ORDER BY createdAt DESC")
    .all(req.userId);
  res.json(rows.map((r) => r.salonId));
});

// --- POST favorite a salon ---
app.post("/favorites/:salonId", requireAuth, (req, res) => {
  const salon = db.prepare("SELECT id FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon) return res.status(404).json({ error: "Salon not found" });

  db.prepare(
    "INSERT OR IGNORE INTO favorites (id, userId, salonId, createdAt) VALUES (?, ?, ?, ?)"
  ).run(uuidv4(), req.userId, req.params.salonId, new Date().toISOString());

  res.status(201).json({ favorited: true });
});

// --- DELETE unfavorite a salon ---
app.delete("/favorites/:salonId", requireAuth, (req, res) => {
  db.prepare("DELETE FROM favorites WHERE userId = ? AND salonId = ?").run(
    req.userId,
    req.params.salonId
  );
  res.json({ favorited: false });
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

// --- GET the logged-in customer's active promo for a salon, if any ---
// Owners target promos to specific customers (no code to type); this lets the
// app silently detect and apply it for that customer.
app.get("/salons/:salonId/my-promo", requireAuth, (req, res) => {
  const promos = db
    .prepare(
      `SELECT pc.code, pc.discountPercent, pc.expiresAt
       FROM promo_codes pc
       INNER JOIN promo_code_recipients r ON r.promoCodeId = pc.id
       WHERE pc.salonId = ? AND r.userId = ? AND pc.active = 1
       ORDER BY pc.discountPercent DESC`
    )
    .all(req.params.salonId, req.userId);

  const promo = promos.find((p) => !p.expiresAt || new Date(p.expiresAt) > new Date());

  if (!promo) {
    return res.status(404).json({ error: "No active promo" });
  }

  res.json(promo);
});

// --- GET the logged-in customer's loyalty progress at a salon ---
app.get("/salons/:salonId/my-loyalty-status", requireAuth, (req, res) => {
  const settings = db
    .prepare("SELECT * FROM loyalty_settings WHERE salonId = ?")
    .get(req.params.salonId);

  if (!settings || !settings.enabled) {
    return res.json({ enabled: false });
  }

  const { count } = db
    .prepare("SELECT COUNT(*) as count FROM bookings WHERE salonId = ? AND userId = ?")
    .get(req.params.salonId, req.userId);

  const remainder = count % settings.visitsRequired;
  const visitsUntilNextReward = remainder === 0 ? settings.visitsRequired : settings.visitsRequired - remainder;

  res.json({
    enabled: true,
    visitsRequired: settings.visitsRequired,
    discountPercent: settings.discountPercent,
    currentVisitCount: count,
    visitsUntilNextReward,
  });
});

// --- GET the logged-in customer's loyalty progress across every salon they've visited ---
app.get("/my-loyalty", requireAuth, (req, res) => {
  const salonIds = db
    .prepare("SELECT DISTINCT salonId FROM bookings WHERE userId = ?")
    .all(req.userId)
    .map((r) => r.salonId);

  const results = salonIds
    .map((salonId) => {
      const settings = db.prepare("SELECT * FROM loyalty_settings WHERE salonId = ?").get(salonId);
      if (!settings || !settings.enabled) return null;

      const salon = db.prepare("SELECT name FROM salons WHERE id = ?").get(salonId);
      if (!salon) return null;

      const { count } = db
        .prepare("SELECT COUNT(*) as count FROM bookings WHERE salonId = ? AND userId = ?")
        .get(salonId, req.userId);

      const remainder = count % settings.visitsRequired;
      const visitsUntilNextReward =
        remainder === 0 ? settings.visitsRequired : settings.visitsRequired - remainder;

      return {
        salonId,
        salonName: salon.name,
        visitsRequired: settings.visitsRequired,
        discountPercent: settings.discountPercent,
        currentVisitCount: count,
        visitsUntilNextReward,
      };
    })
    .filter(Boolean);

  res.json(results);
});

// --- GET /cron/reminders — send push reminders for bookings 1 hour from now ---
// Call this every 5-10 minutes from an external cron (e.g. cron-job.org)
app.get("/cron/reminders", async (req, res) => {
  const secret = req.headers["x-cron-secret"];
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  autoAssignStaleBookings();
  generateCancellationReminders();

  const now = new Date();
  const targetMin = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour from now
  const targetDate = targetMin.toISOString().slice(0, 10);
  const targetTime = `${String(targetMin.getHours()).padStart(2, "0")}:${String(targetMin.getMinutes()).padStart(2, "0")}`;

  const upcomingBookings = db
    .prepare(
      `SELECT b.* FROM bookings b
       JOIN users u ON u.id = b.userId
       WHERE b.date = ? AND b.time = ? AND b.userId != 'guest'`
    )
    .all(targetDate, targetTime);

  upcomingBookings.forEach((booking) => {
    notify(
      booking.userId,
      "Appointment in 1 hour! ⏰",
      `${booking.salonName} · ${booking.serviceName} at ${booking.time}`,
      "appointment_reminder",
      { bookingId: booking.id }
    );
  });

  res.json({ checked: targetDate + " " + targetTime, sent: upcomingBookings.length });
});

// --- GET the logged-in user's notification history ---
app.get("/notifications", requireAuth, (req, res) => {
  generateCancellationReminders();
  const notifications = db
    .prepare("SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT 100")
    .all(req.userId)
    .map((n) => ({ ...n, data: n.data ? JSON.parse(n.data) : null }));
  res.json(notifications);
});

// --- PUT mark all of the logged-in user's notifications as read ---
app.put("/notifications/read-all", requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET read = 1 WHERE userId = ? AND read = 0").run(req.userId);
  res.json({ marked: true });
});

// --- GET the logged-in user's notification channel preferences ---
app.get("/notification-preferences", requireAuth, (req, res) => {
  const user = db
    .prepare(
      `SELECT smsAppointmentNotifications, whatsappAppointmentNotifications,
       smsMarketingNotifications, whatsappMarketingNotifications
       FROM users WHERE id = ?`
    )
    .get(req.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    smsAppointmentNotifications: !!user.smsAppointmentNotifications,
    whatsappAppointmentNotifications: !!user.whatsappAppointmentNotifications,
    smsMarketingNotifications: !!user.smsMarketingNotifications,
    whatsappMarketingNotifications: !!user.whatsappMarketingNotifications,
  });
});

// --- PUT update the logged-in user's notification channel preferences ---
app.put("/notification-preferences", requireAuth, (req, res) => {
  const {
    smsAppointmentNotifications,
    whatsappAppointmentNotifications,
    smsMarketingNotifications,
    whatsappMarketingNotifications,
  } = req.body;

  db.prepare(
    `UPDATE users SET
       smsAppointmentNotifications = @smsAppointmentNotifications,
       whatsappAppointmentNotifications = @whatsappAppointmentNotifications,
       smsMarketingNotifications = @smsMarketingNotifications,
       whatsappMarketingNotifications = @whatsappMarketingNotifications
     WHERE id = @userId`
  ).run({
    userId: req.userId,
    smsAppointmentNotifications: smsAppointmentNotifications ? 1 : 0,
    whatsappAppointmentNotifications: whatsappAppointmentNotifications ? 1 : 0,
    smsMarketingNotifications: smsMarketingNotifications ? 1 : 0,
    whatsappMarketingNotifications: whatsappMarketingNotifications ? 1 : 0,
  });

  res.json({ updated: true });
});

const httpServer = http.createServer(app);
initChatServer(httpServer);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`StyleHub backend running on http://0.0.0.0:${PORT}`);
});