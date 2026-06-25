const express = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { requireAuth, requireOwner } = require("./authMiddleware");

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
  };

  db.prepare(
    `INSERT INTO salons (id, ownerId, name, category, address, distanceKm, rating, reviewCount, imageUrl, openTime, closeTime)
     VALUES (@id, @ownerId, @name, @category, @address, @distanceKm, @rating, @reviewCount, @imageUrl, @openTime, @closeTime)`
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

  db.prepare("DELETE FROM services WHERE salonId = ?").run(salon.id);
  db.prepare("DELETE FROM reviews WHERE salonId = ?").run(salon.id);
  db.prepare("DELETE FROM bookings WHERE salonId = ?").run(salon.id);
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

  const { name, durationMins, price } = req.body;
  if (!name || !durationMins || price == null) {
    return res.status(400).json({ error: "Missing required service fields" });
  }

  const service = {
    id: uuidv4(),
    salonId: salon.id,
    name,
    durationMins,
    price,
  };

  db.prepare(
    `INSERT INTO services (id, salonId, name, durationMins, price) VALUES (@id, @salonId, @name, @durationMins, @price)`
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

  const { name, durationMins, price } = req.body;
  if (!name || !durationMins || price == null) {
    return res.status(400).json({ error: "Missing required service fields" });
  }

  db.prepare(
    "UPDATE services SET name = ?, durationMins = ?, price = ? WHERE id = ?"
  ).run(name, durationMins, price, req.params.id);

  res.json({ ...service, name, durationMins, price });
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

  db.prepare("DELETE FROM services WHERE id = ?").run(req.params.id);
  res.json({ deleted: true });
});

// --- GET bookings for all of this owner's salons ---
router.get("/bookings", (req, res) => {
  const bookings = db
    .prepare(
      `SELECT b.*, u.name AS customerName, u.phone AS customerPhone
       FROM bookings b
       INNER JOIN salons s ON b.salonId = s.id
       INNER JOIN users u ON b.userId = u.id
       WHERE s.ownerId = ?
       ORDER BY b.createdAt DESC`
    )
    .all(req.userId);

  res.json(bookings);
});

// --- GET customers who have booked at one of this owner's salons ---
router.get("/salons/:salonId/customers", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const customers = db
    .prepare(
      `SELECT DISTINCT u.id, u.name, u.phone
       FROM users u
       INNER JOIN bookings b ON b.userId = u.id
       WHERE b.salonId = ?
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
module.exports = router;