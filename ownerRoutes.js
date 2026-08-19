const express = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { requireAuth, requireOwner } = require("./authMiddleware");
const { notify } = require("./notify");
const { autoAssignStaleBookings } = require("./bookingAssignment");
const { sendMessage, editMessage, deleteMessage, pruneOldMessages } = require("./chat");
const { attachImages, MAX_IMAGES_PER_SERVICE } = require("./serviceImages");
const { MAX_IMAGES_PER_PROFESSIONAL } = require("./professionalImages");
const { attachSalonImages, MAX_IMAGES_PER_SALON } = require("./salonImages");
const { attachCustomerServiceContacts, MAX_CONTACTS_PER_SALON } = require("./salonContacts");

const router = express.Router();

// All routes here require login AND owner role
router.use(requireAuth, requireOwner);

// --- GET salons owned by the logged-in owner ---
router.get("/salons", (req, res) => {
  const salons = db
    .prepare("SELECT * FROM salons WHERE ownerId = ?")
    .all(req.userId);

  const withContacts = attachCustomerServiceContacts(salons);
  const withImages = attachSalonImages(withContacts);

  const fullSalons = withImages.map((salon) => {
    const services = attachImages(
      db.prepare("SELECT * FROM services WHERE salonId = ?").all(salon.id)
    );
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
  db.prepare("DELETE FROM favorites WHERE salonId = ?").run(salon.id);
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

function getOwnedSalon(req) {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.id);
  if (!salon || salon.ownerId !== req.userId) return null;
  return salon;
}

// --- GET this salon's customer service contacts ---
router.get("/salons/:id/customer-service", (req, res) => {
  const salon = getOwnedSalon(req);
  if (!salon) return res.status(404).json({ error: "Salon not found" });

  const [withContacts] = attachCustomerServiceContacts([salon]);
  res.json(withContacts.customerServiceContacts);
});

// --- POST add a customer service contact to this salon (max 5) ---
router.post("/salons/:id/customer-service", (req, res) => {
  const salon = getOwnedSalon(req);
  if (!salon) return res.status(404).json({ error: "Salon not found" });

  const label = (req.body.label || "").trim() || null;
  const phone = (req.body.phone || "").trim() || null;
  const email = (req.body.email || "").trim() || null;
  if (!phone && !email) {
    return res.status(400).json({ error: "Enter a phone number or email for this contact" });
  }

  const existing = db
    .prepare("SELECT id FROM salon_customer_service_contacts WHERE salonId = ?")
    .all(req.params.id);
  if (existing.length >= MAX_CONTACTS_PER_SALON) {
    return res.status(400).json({ error: `You can add up to ${MAX_CONTACTS_PER_SALON} contacts per salon` });
  }

  const contact = {
    id: uuidv4(),
    salonId: req.params.id,
    label,
    phone,
    email,
    position: existing.length,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO salon_customer_service_contacts (id, salonId, label, phone, email, position, createdAt)
     VALUES (@id, @salonId, @label, @phone, @email, @position, @createdAt)`
  ).run(contact);

  res.status(201).json({ id: contact.id, label: contact.label, phone: contact.phone, email: contact.email });
});

// --- PUT edit a customer service contact ---
router.put("/salons/:id/customer-service/:contactId", (req, res) => {
  const salon = getOwnedSalon(req);
  if (!salon) return res.status(404).json({ error: "Salon not found" });

  const contact = db
    .prepare("SELECT * FROM salon_customer_service_contacts WHERE id = ? AND salonId = ?")
    .get(req.params.contactId, req.params.id);
  if (!contact) return res.status(404).json({ error: "Contact not found" });

  const label = (req.body.label || "").trim() || null;
  const phone = (req.body.phone || "").trim() || null;
  const email = (req.body.email || "").trim() || null;
  if (!phone && !email) {
    return res.status(400).json({ error: "Enter a phone number or email for this contact" });
  }

  db.prepare(
    `UPDATE salon_customer_service_contacts SET label = ?, phone = ?, email = ? WHERE id = ?`
  ).run(label, phone, email, contact.id);

  res.json({ id: contact.id, label, phone, email });
});

// --- DELETE a customer service contact ---
router.delete("/salons/:id/customer-service/:contactId", (req, res) => {
  const salon = getOwnedSalon(req);
  if (!salon) return res.status(404).json({ error: "Salon not found" });

  db.prepare("DELETE FROM salon_customer_service_contacts WHERE id = ? AND salonId = ?").run(
    req.params.contactId,
    req.params.id
  );
  res.json({ deleted: true });
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

  // Let customers who've favorited this salon know there's something new to book.
  const favoritedBy = db
    .prepare("SELECT userId FROM favorites WHERE salonId = ?")
    .all(salon.id);
  favoritedBy.forEach((f) => {
    notify(
      f.userId,
      "New service added ✨",
      `${salon.name} just added ${name} — GHS ${price}`,
      "new_service",
      { salonId: salon.id, serviceId: service.id }
    );
  });

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
  db.prepare("DELETE FROM service_images WHERE serviceId = ?").run(req.params.id);
  db.prepare("DELETE FROM services WHERE id = ?").run(req.params.id);
  res.json({ deleted: true });
});

function getOwnedService(req) {
  const service = db.prepare("SELECT * FROM services WHERE id = ?").get(req.params.id);
  if (!service) return null;
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(service.salonId);
  if (!salon || salon.ownerId !== req.userId) return null;
  return service;
}

// --- POST add a photo to a service (max 3 per service) ---
router.post("/services/:id/images", (req, res) => {
  const service = getOwnedService(req);
  if (!service) {
    return res.status(404).json({ error: "Service not found" });
  }

  const { imageUrl } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ error: "imageUrl is required" });
  }

  const existing = db
    .prepare("SELECT id FROM service_images WHERE serviceId = ?")
    .all(req.params.id);
  if (existing.length >= MAX_IMAGES_PER_SERVICE) {
    return res.status(400).json({ error: `You can add up to ${MAX_IMAGES_PER_SERVICE} photos per service` });
  }

  const image = {
    id: uuidv4(),
    serviceId: req.params.id,
    imageUrl,
    position: existing.length,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO service_images (id, serviceId, imageUrl, position, createdAt) VALUES (@id, @serviceId, @imageUrl, @position, @createdAt)`
  ).run(image);

  res.status(201).json(image);
});

// --- DELETE a service photo ---
router.delete("/services/:id/images/:imageId", (req, res) => {
  const service = getOwnedService(req);
  if (!service) {
    return res.status(404).json({ error: "Service not found" });
  }

  db.prepare("DELETE FROM service_images WHERE id = ? AND serviceId = ?").run(
    req.params.imageId,
    req.params.id
  );
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
  autoAssignStaleBookings();
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

// --- PATCH mark a past booking as a no-show (or undo that) ---
router.patch("/bookings/:id/no-show", (req, res) => {
  const booking = db
    .prepare(
      `SELECT b.* FROM bookings b
       INNER JOIN salons s ON b.salonId = s.id
       WHERE b.id = ? AND s.ownerId = ?`
    )
    .get(req.params.id, req.userId);
  if (!booking) return res.status(404).json({ error: "Booking not found" });

  const appointmentDateTime = new Date(`${booking.date}T${booking.time}:00`);
  if (appointmentDateTime.getTime() > Date.now()) {
    return res.status(400).json({ error: "Can't mark a future booking as a no-show." });
  }

  const noShow = !!req.body.noShow;
  db.prepare("UPDATE bookings SET status = ? WHERE id = ?").run(
    noShow ? "no_show" : null,
    req.params.id
  );

  res.json({ id: req.params.id, status: noShow ? "no_show" : null });
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
    userId: null,
    claimCode: `CLAIM-${uuidv4().slice(0, 8).toUpperCase()}`,
  };

  db.prepare(
    `INSERT INTO professionals (id, salonId, name, photoUrl, createdAt, userId, claimCode)
     VALUES (@id, @salonId, @name, @photoUrl, @createdAt, @userId, @claimCode)`
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
  db.prepare("DELETE FROM professional_unavailability WHERE professionalId = ?").run(req.params.id);
  db.prepare("DELETE FROM professionals WHERE id = ?").run(req.params.id);
  res.json({ deleted: true });
});

function getOwnedProfessional(req) {
  const professional = db.prepare("SELECT * FROM professionals WHERE id = ?").get(req.params.id);
  if (!professional) return null;
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(professional.salonId);
  if (!salon || salon.ownerId !== req.userId) return null;
  return professional;
}

// --- GET this professional's unavailability blocks for a given date ---
router.get("/professionals/:id/unavailability", (req, res) => {
  const professional = getOwnedProfessional(req);
  if (!professional) {
    return res.status(404).json({ error: "Professional not found" });
  }
  const { date } = req.query;
  const blocks = date
    ? db
        .prepare("SELECT * FROM professional_unavailability WHERE professionalId = ? AND date = ? ORDER BY time ASC")
        .all(req.params.id, date)
    : db
        .prepare("SELECT * FROM professional_unavailability WHERE professionalId = ? ORDER BY date ASC, time ASC")
        .all(req.params.id);
  res.json(blocks);
});

// --- POST mark this professional unavailable for a date (whole day) or a specific time ---
router.post("/professionals/:id/unavailability", (req, res) => {
  const professional = getOwnedProfessional(req);
  if (!professional) {
    return res.status(404).json({ error: "Professional not found" });
  }

  const { date, time } = req.body;
  if (!date) {
    return res.status(400).json({ error: "date is required" });
  }

  const block = {
    id: uuidv4(),
    professionalId: req.params.id,
    date,
    time: time || null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO professional_unavailability (id, professionalId, date, time, createdAt) VALUES (@id, @professionalId, @date, @time, @createdAt)`
  ).run(block);

  res.status(201).json(block);
});

// --- DELETE an unavailability block, restoring that time (or day) ---
router.delete("/professionals/:id/unavailability/:blockId", (req, res) => {
  const professional = getOwnedProfessional(req);
  if (!professional) {
    return res.status(404).json({ error: "Professional not found" });
  }

  db.prepare("DELETE FROM professional_unavailability WHERE id = ? AND professionalId = ?").run(
    req.params.blockId,
    req.params.id
  );
  res.json({ deleted: true });
});

// --- POST add a portfolio photo to a professional (max 3) ---
router.post("/professionals/:id/images", (req, res) => {
  const professional = getOwnedProfessional(req);
  if (!professional) {
    return res.status(404).json({ error: "Professional not found" });
  }

  const { imageUrl } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ error: "imageUrl is required" });
  }

  const existing = db
    .prepare("SELECT id FROM professional_images WHERE professionalId = ?")
    .all(req.params.id);
  if (existing.length >= MAX_IMAGES_PER_PROFESSIONAL) {
    return res.status(400).json({ error: `You can add up to ${MAX_IMAGES_PER_PROFESSIONAL} photos per professional` });
  }

  const image = {
    id: uuidv4(),
    professionalId: req.params.id,
    imageUrl,
    position: existing.length,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO professional_images (id, professionalId, imageUrl, position, createdAt) VALUES (@id, @professionalId, @imageUrl, @position, @createdAt)`
  ).run(image);

  res.status(201).json(image);
});

// --- DELETE a professional's portfolio photo ---
router.delete("/professionals/:id/images/:imageId", (req, res) => {
  const professional = getOwnedProfessional(req);
  if (!professional) {
    return res.status(404).json({ error: "Professional not found" });
  }

  db.prepare("DELETE FROM professional_images WHERE id = ? AND professionalId = ?").run(
    req.params.imageId,
    req.params.id
  );
  res.json({ deleted: true });
});

// --- POST add a photo to a salon's gallery (max 6) ---
router.post("/salons/:id/images", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.id);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const { imageUrl } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ error: "imageUrl is required" });
  }

  const existing = db
    .prepare("SELECT id FROM salon_images WHERE salonId = ?")
    .all(req.params.id);
  if (existing.length >= MAX_IMAGES_PER_SALON) {
    return res.status(400).json({ error: `You can add up to ${MAX_IMAGES_PER_SALON} photos per salon` });
  }

  const image = {
    id: uuidv4(),
    salonId: req.params.id,
    imageUrl,
    position: existing.length,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO salon_images (id, salonId, imageUrl, position, createdAt) VALUES (@id, @salonId, @imageUrl, @position, @createdAt)`
  ).run(image);

  res.status(201).json(image);
});

// --- DELETE a salon's gallery photo ---
router.delete("/salons/:id/images/:imageId", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.id);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  db.prepare("DELETE FROM salon_images WHERE id = ? AND salonId = ?").run(
    req.params.imageId,
    req.params.id
  );
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

// --- POST give a promo discount to specific customers of one of this owner's salons ---
// Codes are generated internally — owners pick customers, not a code, and customers
// never see or type a code; it's auto-applied for them (see GET /salons/:salonId/my-promo).
router.post("/salons/:salonId/promo-codes", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const { discountPercent, expiresAt, userIds } = req.body;
  if (!discountPercent) {
    return res.status(400).json({ error: "Discount percent is required" });
  }
  if (discountPercent <= 0 || discountPercent > 100) {
    return res.status(400).json({ error: "Discount percent must be between 1 and 100" });
  }
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: "Select at least one customer" });
  }

  const promoCode = {
    id: uuidv4(),
    salonId: salon.id,
    code: `PROMO-${uuidv4().slice(0, 8).toUpperCase()}`,
    discountPercent,
    active: 1,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
  };

  db.prepare(
    `INSERT INTO promo_codes (id, salonId, code, discountPercent, active, createdAt, expiresAt)
     VALUES (@id, @salonId, @code, @discountPercent, @active, @createdAt, @expiresAt)`
  ).run(promoCode);

  const insertRecipient = db.prepare(
    `INSERT INTO promo_code_recipients (id, promoCodeId, userId) VALUES (?, ?, ?)`
  );
  userIds.forEach((userId) => {
    insertRecipient.run(uuidv4(), promoCode.id, userId);
  });

  res.status(201).json({ ...promoCode, recipients: userIds });
});

// --- PUT update a promo code's discount/expiry (only if it belongs to one of this owner's salons) ---
router.put("/promo-codes/:id", (req, res) => {
  const promoCode = db.prepare("SELECT * FROM promo_codes WHERE id = ?").get(req.params.id);
  if (!promoCode) {
    return res.status(404).json({ error: "Promo code not found" });
  }

  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(promoCode.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(403).json({ error: "Not authorized to edit this promo code" });
  }

  const { discountPercent, expiresAt } = req.body;
  if (!discountPercent) {
    return res.status(400).json({ error: "Discount percent is required" });
  }
  if (discountPercent <= 0 || discountPercent > 100) {
    return res.status(400).json({ error: "Discount percent must be between 1 and 100" });
  }

  db.prepare("UPDATE promo_codes SET discountPercent = ?, expiresAt = ? WHERE id = ?").run(
    discountPercent,
    expiresAt || null,
    req.params.id
  );

  res.json(db.prepare("SELECT * FROM promo_codes WHERE id = ?").get(req.params.id));
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

// --- GET this salon's loyalty program settings ---
router.get("/salons/:salonId/loyalty", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const settings = db
    .prepare("SELECT * FROM loyalty_settings WHERE salonId = ?")
    .get(req.params.salonId);

  res.json(
    settings || { salonId: req.params.salonId, enabled: 0, visitsRequired: 5, discountPercent: 10 }
  );
});

// --- PUT update this salon's loyalty program settings ---
router.put("/salons/:salonId/loyalty", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const { enabled, visitsRequired, discountPercent } = req.body;
  if (!visitsRequired || visitsRequired < 2) {
    return res.status(400).json({ error: "visitsRequired must be at least 2" });
  }
  // 0 is allowed — a recognition-only program (badges/tiers, no discount).
  if (discountPercent == null || discountPercent < 0 || discountPercent > 100) {
    return res.status(400).json({ error: "discountPercent must be between 0 and 100" });
  }

  db.prepare(
    `INSERT INTO loyalty_settings (salonId, enabled, visitsRequired, discountPercent)
     VALUES (@salonId, @enabled, @visitsRequired, @discountPercent)
     ON CONFLICT(salonId) DO UPDATE SET
       enabled = @enabled, visitsRequired = @visitsRequired, discountPercent = @discountPercent`
  ).run({
    salonId: req.params.salonId,
    enabled: enabled ? 1 : 0,
    visitsRequired,
    discountPercent,
  });

  res.json(db.prepare("SELECT * FROM loyalty_settings WHERE salonId = ?").get(req.params.salonId));
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

// --- GET this salon's upcoming special closure dates (e.g. holidays) ---
router.get("/salons/:salonId/closures", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const closures = db
    .prepare("SELECT * FROM salon_closures WHERE salonId = ? AND date >= ? ORDER BY date ASC")
    .all(req.params.salonId, todayIso);
  res.json(closures);
});

// --- POST mark a whole date as closed, beyond the salon's regular weekly hours ---
router.post("/salons/:salonId/closures", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const { date, reason } = req.body;
  if (!date) return res.status(400).json({ error: "date is required" });

  const existing = db
    .prepare("SELECT id FROM salon_closures WHERE salonId = ? AND date = ?")
    .get(req.params.salonId, date);
  if (existing) return res.status(409).json({ error: "This date is already marked closed" });

  const closure = {
    id: uuidv4(),
    salonId: req.params.salonId,
    date,
    reason: reason?.trim() || null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO salon_closures (id, salonId, date, reason, createdAt) VALUES (@id, @salonId, @date, @reason, @createdAt)`
  ).run(closure);

  res.status(201).json(closure);
});

// --- DELETE reopen a previously-closed date ---
router.delete("/salons/:salonId/closures/:closureId", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  db.prepare("DELETE FROM salon_closures WHERE id = ? AND salonId = ?").run(
    req.params.closureId,
    req.params.salonId
  );
  res.json({ deleted: true });
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

// --- GET per-salon analytics (revenue/volume over time, cancellation & no-show rate,
// per-professional performance, top services) ---
router.get("/salons/:salonId/analytics", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const range = ["week", "month", "all"].includes(req.query.range) ? req.query.range : "month";
  const todayIso = new Date().toISOString().slice(0, 10);
  let sinceIso = "0000-00-00";
  if (range === "week") {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    sinceIso = d.toISOString().slice(0, 10);
  } else if (range === "month") {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    sinceIso = d.toISOString().slice(0, 10);
  }

  const salonId = req.params.salonId;

  const revenueOverTime = db
    .prepare(
      `SELECT date, COUNT(*) as bookingCount, COALESCE(SUM(price), 0) as revenue
       FROM bookings WHERE salonId = ? AND date >= ?
       GROUP BY date ORDER BY date ASC`
    )
    .all(salonId, sinceIso);

  const activeBookingCount = db
    .prepare(`SELECT COUNT(*) as count FROM bookings WHERE salonId = ? AND date >= ?`)
    .get(salonId, sinceIso).count;

  const cancelledCount = db
    .prepare(
      `SELECT COUNT(*) as count FROM booking_events
       WHERE salonId = ? AND eventType = 'cancelled' AND date >= ?`
    )
    .get(salonId, sinceIso).count;

  const totalAttempted = activeBookingCount + cancelledCount;
  const cancellationRate = totalAttempted > 0 ? cancelledCount / totalAttempted : 0;

  const pastBookingsCount = db
    .prepare(
      `SELECT COUNT(*) as count FROM bookings WHERE salonId = ? AND date >= ? AND date < ?`
    )
    .get(salonId, sinceIso, todayIso).count;

  const noShowCount = db
    .prepare(
      `SELECT COUNT(*) as count FROM bookings
       WHERE salonId = ? AND date >= ? AND date < ? AND status = 'no_show'`
    )
    .get(salonId, sinceIso, todayIso).count;

  const noShowRate = pastBookingsCount > 0 ? noShowCount / pastBookingsCount : 0;

  const perProfessional = db
    .prepare(
      `SELECT p.id as professionalId, p.name,
              COUNT(b.id) as bookingCount,
              COALESCE(SUM(b.price), 0) as revenue,
              COALESCE(SUM(b.tipAmount), 0) as tips,
              (SELECT COALESCE(AVG(rating), 0) FROM professional_ratings WHERE professionalId = p.id) as avgRating
       FROM professionals p
       LEFT JOIN bookings b ON b.professionalId = p.id AND b.date >= ?
       WHERE p.salonId = ?
       GROUP BY p.id
       ORDER BY revenue DESC`
    )
    .all(sinceIso, salonId)
    .map((p) => ({ ...p, avgRating: Math.round(p.avgRating * 10) / 10 }));

  const totalTips = db
    .prepare(`SELECT COALESCE(SUM(tipAmount), 0) as total FROM bookings WHERE salonId = ? AND date >= ?`)
    .get(salonId, sinceIso).total;

  const topServices = db
    .prepare(
      `SELECT serviceName, COUNT(*) as bookingCount, COALESCE(SUM(price), 0) as revenue
       FROM bookings WHERE salonId = ? AND date >= ?
       GROUP BY serviceName ORDER BY bookingCount DESC LIMIT 5`
    )
    .all(salonId, sinceIso);

  res.json({
    range,
    revenueOverTime,
    cancellationRate,
    cancelledCount,
    noShowRate,
    noShowCount,
    perProfessional,
    topServices,
    totalTips,
  });
});

// --- GET every conversation across all of this owner's salons ---
router.get("/conversations", (req, res) => {
  const salons = db.prepare("SELECT id, name FROM salons WHERE ownerId = ?").all(req.userId);
  if (salons.length === 0) return res.json([]);

  pruneOldMessages();

  const salonIds = salons.map((s) => s.id);
  const placeholders = salonIds.map(() => "?").join(",");

  const conversations = db
    .prepare(
      `SELECT m.salonId, s.name as salonName, m.customerId, u.name as customerName,
              (SELECT body FROM messages m2 WHERE m2.salonId = m.salonId AND m2.customerId = m.customerId ORDER BY m2.createdAt DESC LIMIT 1) as lastMessage,
              (SELECT createdAt FROM messages m2 WHERE m2.salonId = m.salonId AND m2.customerId = m.customerId ORDER BY m2.createdAt DESC LIMIT 1) as lastMessageAt,
              (SELECT COUNT(*) FROM messages m3 WHERE m3.salonId = m.salonId AND m3.customerId = m.customerId AND m3.senderRole = 'customer' AND m3.readByOwner = 0) as unreadCount
       FROM messages m
       INNER JOIN users u ON u.id = m.customerId
       INNER JOIN salons s ON s.id = m.salonId
       WHERE m.salonId IN (${placeholders})
       GROUP BY m.salonId, m.customerId
       ORDER BY lastMessageAt DESC`
    )
    .all(...salonIds);

  res.json(conversations);
});

// --- GET this salon's chat conversations (one per customer who has messaged) ---
router.get("/salons/:salonId/conversations", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  pruneOldMessages();

  const conversations = db
    .prepare(
      `SELECT m.customerId, u.name as customerName,
              (SELECT body FROM messages m2 WHERE m2.salonId = m.salonId AND m2.customerId = m.customerId ORDER BY m2.createdAt DESC LIMIT 1) as lastMessage,
              (SELECT createdAt FROM messages m2 WHERE m2.salonId = m.salonId AND m2.customerId = m.customerId ORDER BY m2.createdAt DESC LIMIT 1) as lastMessageAt,
              (SELECT COUNT(*) FROM messages m3 WHERE m3.salonId = m.salonId AND m3.customerId = m.customerId AND m3.senderRole = 'customer' AND m3.readByOwner = 0) as unreadCount
       FROM messages m
       INNER JOIN users u ON u.id = m.customerId
       WHERE m.salonId = ?
       GROUP BY m.customerId
       ORDER BY lastMessageAt DESC`
    )
    .all(req.params.salonId);

  res.json(conversations);
});

// --- GET the owner's chat thread with one customer ---
router.get("/salons/:salonId/messages/:customerId", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  pruneOldMessages();

  const messages = db
    .prepare(
      `SELECT * FROM messages WHERE salonId = ? AND customerId = ? ORDER BY createdAt ASC`
    )
    .all(req.params.salonId, req.params.customerId);

  db.prepare(
    `UPDATE messages SET readByOwner = 1
     WHERE salonId = ? AND customerId = ? AND senderRole = 'customer' AND readByOwner = 0`
  ).run(req.params.salonId, req.params.customerId);

  res.json(messages);
});

// --- POST send a chat message to a customer as the salon owner ---
router.post("/salons/:salonId/messages/:customerId", (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }

  const body = (req.body.body || "").trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: "Message cannot be empty" });

  const message = sendMessage({
    salonId: req.params.salonId,
    customerId: req.params.customerId,
    senderRole: "owner",
    body,
  });

  res.status(201).json(message);
});

// --- PATCH edit one of the owner's own chat messages ---
router.patch("/messages/:id", (req, res) => {
  const body = (req.body.body || "").trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: "Message cannot be empty" });

  const updated = editMessage(req.params.id, req.userId, "owner", body);
  if (!updated) return res.status(404).json({ error: "Message not found" });

  res.json(updated);
});

// --- DELETE one of the owner's own chat messages ---
router.delete("/messages/:id", (req, res) => {
  const deleted = deleteMessage(req.params.id, req.userId, "owner");
  if (!deleted) return res.status(404).json({ error: "Message not found" });

  res.json({ deleted: true });
});

// --- POST announce a message to all customers of a salon ---
router.post("/salons/:salonId/announce", async (req, res) => {
  const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(req.params.salonId);
  if (!salon || salon.ownerId !== req.userId) {
    return res.status(404).json({ error: "Salon not found" });
  }
  const { title, message } = req.body;
  if (!title || !message) return res.status(400).json({ error: "title and message are required" });

  // Get every distinct customer who has booked at this salon
  const customers = db.prepare(
    `SELECT DISTINCT u.id AS userId FROM bookings b
     JOIN users u ON u.id = b.userId
     WHERE b.salonId = ? AND b.userId != 'guest'`
  ).all(req.params.salonId);

  customers.forEach((c) => {
    notify(c.userId, `${salon.name}: ${title}`, message, "announcement", { salonId: salon.id });
  });

  res.json({ sent: customers.length });
});

module.exports = router;