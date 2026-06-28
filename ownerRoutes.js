const express = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { requireAuth, requireOwner } = require("./authMiddleware");
const { sendPushNotification } = require("./pushHelper");

const router = express.Router();

// All routes here require login AND owner role
router.use(requireAuth, requireOwner);

// --- GET salons owned by the logged-in owner ---
router.get("/salons", (req, res) => {
  const salons = db
    .prepare("SELECT * FROM salons WHERE ownerId = ?")
    .all(req.userId);

  const fullSalons = salons.map((salon) => {
    const services = db
      .prepare("SELECT * FROM services WHERE salonId = ?")
      .all(salon.id);
    return { ...salon, services };
  });

  res.json(fullSalons);
});

// --- POST create a new salon owned by this user ---
router.post("/salons", (req, res) => {
  const { name, category, address, openTime, closeTime, imageUrl } = req.body;

  if (!name || !category || !address || !openTime || !closeTime) {
    return res.status(400).json({ error: "Missing required salon fields" });
  }

  const salon = {
    id: uuidv4(),
    ownerId: req.userId,
    name,
    category,
    address,
    distanceKm: 0,
    rating: 0,
    reviewCount: 0,
    imageUrl: imageUrl || "https://images.unsplash.com/photo-1560066984-138dadb4c035?w=800",
    openTime,
    closeTime,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO salons (id, ownerId, name, category, address, distanceKm, rating, reviewCount, imageUrl, openTime, closeTime, createdAt)
     VALUES (@id, @ownerId, @name, @category, @address, @distanceKm, @rating, @reviewCount, @imageUrl, @openTime, @closeTime, @createdAt)`
  ).run(salon);

  res.status(201).json(salon);
});

// --- DELETE a salon (only if owned by this user) ---
router.delete("/salons/:id", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.id);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const promoCodes = db.prepare("SELECT id FROM promo_codes WHERE salonId = ?").all(salon.id);
  promoCodes.forEach((promo) => {
    db.prepare("DELETE FROM promo_code_recipients WHERE promoCodeId = ?").run(promo.id);
  });
  db.prepare("DELETE FROM promo_codes WHERE salonId = ?").run(salon.id);

  const professionals = db.prepare("SELECT id FROM professionals WHERE salonId = ?").all(salon.id);
  professionals.forEach((pro) => {
    db.prepare("DELETE FROM professional_services WHERE professionalId = ?").run(pro.id);
  });
  db.prepare("DELETE FROM professionals WHERE salonId = ?").run(salon.id);

  const salonServices = db.prepare("SELECT id FROM services WHERE salonId = ?").all(salon.id);
  salonServices.forEach((s) => {
    db.prepare("DELETE FROM professional_services WHERE serviceId = ?").run(s.id);
  });
  db.prepare("DELETE FROM bookings WHERE salonId = ?").run(salon.id);
  db.prepare("DELETE FROM reviews WHERE salonId = ?").run(salon.id);
  db.prepare("DELETE FROM services WHERE salonId = ?").run(salon.id);
  db.prepare("DELETE FROM salons WHERE id = ?").run(salon.id);
  res.json({ deleted: true });
});
;// --- PUT update a salon (only if owned by this user) ---
router.put("/salons/:id", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.id);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const { name, category, address, openTime, closeTime, imageUrl } = req.body;

  db.prepare(
    `UPDATE salons SET name = ?, category = ?, address = ?, openTime = ?, closeTime = ?, imageUrl = ? WHERE id = ?`
  ).run(
    name ?? salon.name,
    category ?? salon.category,
    address ?? salon.address,
    openTime ?? salon.openTime,
    closeTime ?? salon.closeTime,
    imageUrl ?? salon.imageUrl,
    salon.id
  );

  res.json({ ...salon, name, category, address, openTime, closeTime, imageUrl });
});

// --- POST add a service to one of this owner's salons ---
router.post("/salons/:salonId/services", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const { name, durationMins, price, category } = req.body;
  if (!name || !durationMins || price == null) {
    return res.status(400).json({ error: "Missing required service fields" });
  }

  const service = {
    id: uuidv4(),
    salonId: salon.id,
    name,
    durationMins,
    price,
    category: category || null,
  };

  db.prepare(
    `INSERT INTO services (id, salonId, name, durationMins, price, category) VALUES (@id, @salonId, @name, @durationMins, @price, @category)`
  ).run(service);

  res.status(201).json(service);
});

// --- PUT update a service (only if it belongs to one of this owner's salons) ---
router.put("/services/:id", (req, res) => {
  const service = db.prepare("SELECT * FROM services WHERE id = ?").get(req.params.id);
  if (!service) {
    return res.status(404).json({ error: "Service not found" });
  }

  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(service.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(403).json({ error: "Not authorized to edit this service" });
  }

  const { name, durationMins, price, category } = req.body;
  if (!name || !durationMins || price == null) {
    return res.status(400).json({ error: "Missing required service fields" });
  }

  db.prepare(
    "UPDATE services SET name = ?, durationMins = ?, price = ?, category = ? WHERE id = ?"
  ).run(name, durationMins, price, category || null, req.params.id);

  res.json({ ...service, name, durationMins, price, category: category || null });
});
// --- DELETE a service (only if it belongs to one of this owner's salons) ---
router.delete("/services/:id", (req, res) => {
  const service = db.prepare("SELECT * FROM services WHERE id = ?").get(req.params.id);
  if (!service) {
    return res.status(404).json({ error: "Service not found" });
  }

  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(service.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(403).json({ error: "Not authorized to delete this service" });
  }

  db.prepare("DELETE FROM professional_services WHERE serviceId = ?").run(req.params.id);
  db.prepare("DELETE FROM services WHERE id = ?").run(req.params.id);
  res.json({ deleted: true });
});

// --- POST create a manual booking on behalf of a walk-in/phone customer ---
router.post("/salons/:salonId/manual-booking", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const {
    serviceId,
    serviceName,
    date,
    dateLabel,
    time,
    price,
    guestName,
    guestPhone,
    professionalId,
  } = req.body;

  if (!serviceId || !serviceName || !date || !dateLabel || !time || price == null || !guestName) {
    return res.status(400).json({ error: "Missing required booking fields" });
  }

  const conflict = db
    .prepare("SELECT id FROM bookings WHERE salonId = ? AND date = ? AND time = ?")
    .get(salon.id, date, time);

  if (conflict) {
    return res.status(409).json({ error: "This time slot is already booked." });
  }

  const booking = {
    id: uuidv4(),
    userId: "guest",
    salonId: salon.id,
    serviceId,
    salonName: salon.name,
    serviceName,
    date,
    dateLabel,
    time,
    price,
    originalPrice: price,
    discountAmount: 0,
    createdAt: new Date().toISOString(),
    professionalId: professionalId || null,
    guestName,
    guestPhone: guestPhone || null,
  };

  db.prepare(
    `INSERT INTO bookings (id, userId, salonId, serviceId, salonName, serviceName, date, dateLabel, time, price, originalPrice, discountAmount, createdAt, professionalId, guestName, guestPhone)
     VALUES (@id, @userId, @salonId, @serviceId, @salonName, @serviceName, @date, @dateLabel, @time, @price, @originalPrice, @discountAmount, @createdAt, @professionalId, @guestName, @guestPhone)`
  ).run(booking);

  res.status(201).json(booking);
});

// --- GET bookings for all of this owner's salons ---
router.get("/bookings", (req, res) => {
  const bookings = db
    .prepare(
      `SELECT b.*, u.name AS userName, u.phone AS userPhone, p.name AS professionalName,
       (SELECT COUNT(*) FROM bookings b2 WHERE b2.userId = b.userId AND b2.salonId = b.salonId AND b.userId != 'guest') AS customerVisitCount
       FROM bookings b
       INNER JOIN salons s ON b.salonId = s.id
       LEFT JOIN users u ON b.userId = u.id
       LEFT JOIN professionals p ON b.professionalId = p.id
       WHERE s.ownerId = ?
       ORDER BY b.createdAt DESC`
    )
    .all(req.userId);

  const withDisplayInfo = bookings.map((b) => ({
    ...b,
    customerName: b.userId === "guest" ? b.guestName : b.userName,
    customerPhone: b.userId === "guest" ? b.guestPhone : b.userPhone,
  }));

  res.json(withDisplayInfo);
});

// --- GET customers who have booked at one of this owner's salons ---
router.get("/salons/:salonId/customers", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const customers = db
    .prepare(
      `SELECT u.id, u.name, u.phone, COUNT(b.id) AS bookingCount
       FROM users u
       INNER JOIN bookings b ON b.userId = u.id
       WHERE b.salonId = ?
       GROUP BY u.id
       ORDER BY u.name`
    )
    .all(salon.id);

  res.json(customers);
});

// --- GET professionals for one of this owner's salons ---
router.get("/salons/:salonId/professionals", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const professionals = db
    .prepare("SELECT * FROM professionals WHERE salonId = ? ORDER BY createdAt DESC")
    .all(salon.id);

  const withServices = professionals.map((pro) => {
    const services = db
      .prepare(
        `SELECT s.* FROM professional_services ps
         INNER JOIN services s ON s.id = ps.serviceId
         WHERE ps.professionalId = ?`
      )
      .all(pro.id);
    return { ...pro, services };
  });

  res.json(withServices);
});

// --- POST add a professional to one of this owner's salons ---
router.post("/salons/:salonId/professionals", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const { name, photoUrl, serviceIds } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Name is required" });
  }

  const professional = {
    id: uuidv4(),
    salonId: salon.id,
    name,
    photoUrl: photoUrl || null,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO professionals (id, salonId, name, photoUrl, createdAt)
     VALUES (@id, @salonId, @name, @photoUrl, @createdAt)`
  ).run(professional);

  if (Array.isArray(serviceIds) && serviceIds.length > 0) {
    const insertLink = db.prepare(
      `INSERT INTO professional_services (id, professionalId, serviceId) VALUES (?, ?, ?)`
    );
    serviceIds.forEach((serviceId) => {
      insertLink.run(uuidv4(), professional.id, serviceId);
    });
  }

  res.status(201).json(professional);
});

// --- DELETE a professional (only if it belongs to one of this owner's salons) ---
router.delete("/professionals/:id", (req, res) => {
  const professional = db.prepare("SELECT * FROM professionals WHERE id = ?").get(req.params.id);
  if (!professional) {
    return res.status(404).json({ error: "Professional not found" });
  }

  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(professional.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(403).json({ error: "Not authorized to delete this professional" });
  }

  db.prepare("DELETE FROM professional_services WHERE professionalId = ?").run(req.params.id);
  db.prepare("DELETE FROM professionals WHERE id = ?").run(req.params.id);
  res.json({ deleted: true });
});

// --- GET promo codes for one of this owner's salons ---
router.get("/salons/:salonId/promo-codes", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const promoCodes = db
    .prepare("SELECT * FROM promo_codes WHERE salonId = ? ORDER BY createdAt DESC")
    .all(salon.id);

  const withRecipients = promoCodes.map((promo) => {
    const recipients = db
      .prepare(
        `SELECT u.id, u.name, u.phone
         FROM promo_code_recipients r
         INNER JOIN users u ON u.id = r.userId
         WHERE r.promoCodeId = ?`
      )
      .all(promo.id);
    return { ...promo, recipients };
  });

  res.json(withRecipients);
});

// --- POST create a promo code for one of this owner's salons ---
router.post("/salons/:salonId/promo-codes", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const { code, discountPercent, expiresAt, userIds } = req.body;
  if (!code || !discountPercent) {
    return res.status(400).json({ error: "Code and discount percent are required" });
  }
  if (discountPercent <= 0 || discountPercent > 100) {
    return res.status(400).json({ error: "Discount percent must be between 1 and 100" });
  }

  const normalizedCode = code.trim().toUpperCase();

  const existing = db
    .prepare("SELECT id FROM promo_codes WHERE salonId = ? AND code = ?")
    .get(salon.id, normalizedCode);
  if (existing) {
    return res.status(409).json({ error: "A promo code with this name already exists for this salon" });
  }

  const promoCode = {
    id: uuidv4(),
    salonId: salon.id,
    code: normalizedCode,
    discountPercent,
    active: 1,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
  };

  db.prepare(
    `INSERT INTO promo_codes (id, salonId, code, discountPercent, active, createdAt, expiresAt)
     VALUES (@id, @salonId, @code, @discountPercent, @active, @createdAt, @expiresAt)`
  ).run(promoCode);

  if (Array.isArray(userIds) && userIds.length > 0) {
    const insertRecipient = db.prepare(
      `INSERT INTO promo_code_recipients (id, promoCodeId, userId) VALUES (?, ?, ?)`
    );
    userIds.forEach((userId) => {
      insertRecipient.run(uuidv4(), promoCode.id, userId);
    });
  }

  res.status(201).json(promoCode);
});

// --- DELETE a promo code (only if it belongs to one of this owner's salons) ---
router.delete("/promo-codes/:id", (req, res) => {
  const promoCode = db.prepare("SELECT * FROM promo_codes WHERE id = ?").get(req.params.id);
  if (!promoCode) {
    return res.status(404).json({ error: "Promo code not found" });
  }

  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(promoCode.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(403).json({ error: "Not authorized to delete this promo code" });
  }

  db.prepare("DELETE FROM promo_code_recipients WHERE promoCodeId = ?").run(req.params.id);
  db.prepare("DELETE FROM promo_codes WHERE id = ?").run(req.params.id);
  res.json({ deleted: true });
});

// --- GET working hours for a salon (all 7 days) ---
router.get("/salons/:salonId/hours", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }
  const hours = db.prepare("SELECT * FROM salon_hours WHERE salonId = ? ORDER BY dayOfWeek").all(req.params.salonId);
  res.json(hours);
});

// --- PUT update working hours for a salon (upsert all 7 days) ---
router.put("/salons/:salonId/hours", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }
  const { hours } = req.body; // array of { dayOfWeek, openTime, closeTime, isClosed }
  if (!Array.isArray(hours)) return res.status(400).json({ error: "hours array is required" });

  const upsert = db.prepare(`
    INSERT INTO salon_hours (id, salonId, dayOfWeek, openTime, closeTime, isClosed)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(salonId, dayOfWeek) DO UPDATE SET openTime=excluded.openTime, closeTime=excluded.closeTime, isClosed=excluded.isClosed
  `);
  const tx = db.transaction(() => {
    for (const h of hours) {
      upsert.run(uuidv4(), req.params.salonId, h.dayOfWeek, h.openTime || null, h.closeTime || null, h.isClosed ? 1 : 0);
    }
  });
  tx();
  const updated = db.prepare("SELECT * FROM salon_hours WHERE salonId = ? ORDER BY dayOfWeek").all(req.params.salonId);
  res.json(updated);
});

// --- GET blocked slots for a salon on a specific date ---
router.get("/salons/:salonId/blocked-slots", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });

  const slots = db.prepare("SELECT * FROM blocked_slots WHERE salonId = ? AND date = ?").all(req.params.salonId, date);
  res.json(slots);
});

// --- POST block a time slot ---
router.post("/salons/:salonId/blocked-slots", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }
  const { date, time } = req.body;
  if (!date || !time) return res.status(400).json({ error: "date and time are required" });

  const existing = db.prepare("SELECT id FROM blocked_slots WHERE salonId = ? AND date = ? AND time = ?").get(req.params.salonId, date, time);
  if (existing) return res.status(409).json({ error: "Slot already blocked" });

  const id = uuidv4();
  db.prepare("INSERT INTO blocked_slots (id, salonId, date, time) VALUES (?, ?, ?, ?)").run(id, req.params.salonId, date, time);
  res.status(201).json({ id, salonId: req.params.salonId, date, time });
});

// --- DELETE unblock a time slot ---
router.delete("/salons/:salonId/blocked-slots", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }
  const { date, time } = req.body;
  if (!date || !time) return res.status(400).json({ error: "date and time are required" });

  db.prepare("DELETE FROM blocked_slots WHERE salonId = ? AND date = ? AND time = ?").run(req.params.salonId, date, time);
  res.json({ unblocked: true });
});

// --- GET dashboard stats for this owner ---
router.get("/stats", (req, res) => {
  const salons = db.prepare("SELECT id FROM salons WHERE ownerId = ?").all(req.userId);
  const salonIds = salons.map((s) => s.id);

  if (salonIds.length === 0) {
    return res.json({ totalBookings: 0, totalRevenue: 0, totalCustomers: 0, topServices: [], recentBookings: [] });
  }

  const placeholders = salonIds.map(() => "?").join(",");

  const totalBookings = db.prepare(
    `SELECT COUNT(*) as count FROM bookings WHERE salonId IN (${placeholders})`
  ).get(...salonIds).count;

  const totalRevenue = db.prepare(
    `SELECT COALESCE(SUM(price), 0) as total FROM bookings WHERE salonId IN (${placeholders})`
  ).get(...salonIds).total;

  const totalCustomers = db.prepare(
    `SELECT COUNT(DISTINCT userId) as count FROM bookings WHERE salonId IN (${placeholders}) AND userId != 'guest'`
  ).get(...salonIds).count;

  const topServices = db.prepare(
    `SELECT serviceName, COUNT(*) as bookingCount, SUM(price) as revenue
     FROM bookings WHERE salonId IN (${placeholders})
     GROUP BY serviceName ORDER BY bookingCount DESC LIMIT 5`
  ).all(...salonIds);

  const recentBookings = db.prepare(
    `SELECT b.salonName, b.serviceName, b.dateLabel, b.time, b.price,
            COALESCE(u.name, b.guestName) as customerName
     FROM bookings b
     LEFT JOIN users u ON b.userId = u.id
     WHERE b.salonId IN (${placeholders})
     ORDER BY b.createdAt DESC LIMIT 5`
  ).all(...salonIds);

  const thisMonth = new Date();
  thisMonth.setDate(1);
  thisMonth.setHours(0, 0, 0, 0);

  const monthlyRevenue = db.prepare(
    `SELECT COALESCE(SUM(price), 0) as total FROM bookings
     WHERE salonId IN (${placeholders}) AND createdAt >= ?`
  ).get(...salonIds, thisMonth.toISOString()).total;

  const monthlyBookings = db.prepare(
    `SELECT COUNT(*) as count FROM bookings
     WHERE salonId IN (${placeholders}) AND createdAt >= ?`
  ).get(...salonIds, thisMonth.toISOString()).count;

  const recentReviews = db.prepare(
    `SELECT r.customerName, r.rating, r.comment, r.date, s.name as salonName
     FROM reviews r
     JOIN salons s ON r.salonId = s.id
     WHERE r.salonId IN (${placeholders})
     ORDER BY r.date DESC LIMIT 10`
  ).all(...salonIds);

  const avgRating = db.prepare(
    `SELECT COALESCE(AVG(rating), 0) as avg, COUNT(*) as count FROM reviews WHERE salonId IN (${placeholders})`
  ).get(...salonIds);

  res.json({ totalBookings, totalRevenue, totalCustomers, topServices, recentBookings, monthlyRevenue, monthlyBookings, recentReviews, avgRating: Math.round(avgRating.avg * 10) / 10, totalReviews: avgRating.count });
});

// --- POST announce a message to all customers of a salon ---
router.post("/salons/:salonId/announce", async (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }
  const { title, message } = req.body;
  if (!title || !message) return res.status(400).json({ error: "title and message are required" });

  // Get unique push tokens of all customers who have booked at this salon
  const customers = db.prepare(
    `SELECT DISTINCT u.pushToken FROM bookings b
     JOIN users u ON u.id = b.userId
     WHERE b.salonId = ? AND u.pushToken IS NOT NULL AND u.pushToken != '' AND b.userId != 'guest'`
  ).all(req.params.salonId);

  let sent = 0;
  for (const c of customers) {
    await sendPushNotification(c.pushToken, `${salon.name}: ${title}`, message);
    sent++;
  }

  res.json({ sent });
});

module.exports = router;