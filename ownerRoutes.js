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

  db.prepare("DELETE FROM services WHERE salonId = ?").run(salon.id);
  db.prepare("DELETE FROM reviews WHERE salonId = ?").run(salon.id);
  db.prepare("DELETE FROM bookings WHERE salonId = ?").run(salon.id);
  db.prepare("DELETE FROM salons WHERE id = ?").run(salon.id);

  res.json({ deleted: true });
});// --- PUT update a salon (only if owned by this user) ---
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
      `SELECT b.* FROM bookings b
       INNER JOIN salons s ON b.salonId = s.id
       WHERE s.ownerId = ?
       ORDER BY b.createdAt DESC`
    )
    .all(req.userId);

  res.json(bookings);
});

module.exports = router;