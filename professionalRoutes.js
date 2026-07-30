const express = require("express");
const db = require("./db");
const { requireAuth, requireProfessional } = require("./authMiddleware");
const { notify } = require("./notify");
const { autoAssignStaleBookings } = require("./bookingAssignment");
const { isProfessionalUnavailable } = require("./professionalAvailability");

const router = express.Router();

// All routes here require login AND professional role
router.use(requireAuth, requireProfessional);

function getMyProfessional(req) {
  return db.prepare("SELECT * FROM professionals WHERE userId = ?").get(req.userId);
}

// --- GET this professional's own profile (name, photo, salon, services) ---
router.get("/profile", (req, res) => {
  const professional = getMyProfessional(req);
  if (!professional) {
    return res.status(404).json({ error: "Professional profile not found" });
  }

  const salon = db.prepare("SELECT id, name FROM salons WHERE id = ?").get(professional.salonId);
  const services = db
    .prepare(
      `SELECT s.* FROM professional_services ps
       INNER JOIN services s ON s.id = ps.serviceId
       WHERE ps.professionalId = ?`
    )
    .all(professional.id);

  res.json({ ...professional, salonName: salon?.name || null, services });
});

// --- GET bookings assigned to this professional (includes "No Preference" auto-assigns) ---
router.get("/bookings", (req, res) => {
  autoAssignStaleBookings();
  const professional = getMyProfessional(req);
  if (!professional) {
    return res.status(404).json({ error: "Professional profile not found" });
  }

  const bookings = db
    .prepare(
      `SELECT b.*, u.name AS userName, u.phone AS userPhone
       FROM bookings b
       LEFT JOIN users u ON b.userId = u.id
       WHERE b.professionalId = ?
       ORDER BY b.date DESC, b.time DESC`
    )
    .all(professional.id);

  const withDisplayInfo = bookings.map((b) => ({
    ...b,
    customerName: b.userId === "guest" ? b.guestName : b.userName,
    customerPhone: b.userId === "guest" ? b.guestPhone : b.userPhone,
  }));

  res.json(withDisplayInfo);
});

// --- GET open "No Preference" bookings this professional qualifies for and is free at ---
router.get("/available-bookings", (req, res) => {
  autoAssignStaleBookings();
  const professional = getMyProfessional(req);
  if (!professional) {
    return res.status(404).json({ error: "Professional profile not found" });
  }

  const serviceIds = db
    .prepare("SELECT serviceId FROM professional_services WHERE professionalId = ?")
    .all(professional.id)
    .map((r) => r.serviceId);

  if (serviceIds.length === 0) return res.json([]);

  const placeholders = serviceIds.map(() => "?").join(",");
  const openBookings = db
    .prepare(
      `SELECT id, salonId, salonName, serviceId, serviceName, date, dateLabel, time, price
       FROM bookings
       WHERE salonId = ? AND professionalId IS NULL AND noPreference = 1 AND serviceId IN (${placeholders})
       ORDER BY date ASC, time ASC`
    )
    .all(professional.salonId, ...serviceIds);

  const available = openBookings.filter((b) => {
    const conflict = db
      .prepare("SELECT id FROM bookings WHERE professionalId = ? AND date = ? AND time = ?")
      .get(professional.id, b.date, b.time);
    return !conflict;
  });

  res.json(available);
});

// --- POST accept/claim an open "No Preference" booking ---
router.post("/available-bookings/:id/accept", (req, res) => {
  const professional = getMyProfessional(req);
  if (!professional) {
    return res.status(404).json({ error: "Professional profile not found" });
  }

  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!booking || booking.salonId !== professional.salonId || !booking.noPreference || booking.professionalId) {
    return res.status(404).json({ error: "This booking is no longer available" });
  }

  const qualified = db
    .prepare("SELECT id FROM professional_services WHERE professionalId = ? AND serviceId = ?")
    .get(professional.id, booking.serviceId);
  if (!qualified) {
    return res.status(400).json({ error: "You don't offer this service" });
  }

  const conflict = db
    .prepare("SELECT id FROM bookings WHERE professionalId = ? AND date = ? AND time = ?")
    .get(professional.id, booking.date, booking.time);
  if (conflict) {
    return res.status(409).json({ error: "You already have a booking at this time" });
  }
  if (isProfessionalUnavailable(professional.id, booking.date, booking.time)) {
    return res.status(409).json({ error: "You're marked unavailable at this time" });
  }

  const result = db
    .prepare("UPDATE bookings SET professionalId = ? WHERE id = ? AND professionalId IS NULL")
    .run(professional.id, booking.id);

  if (result.changes === 0) {
    return res.status(409).json({ error: "This booking was just claimed by another professional" });
  }

  notify(
    booking.userId,
    "Professional Assigned ✂️",
    `${professional.name} will handle your ${booking.serviceName} on ${booking.dateLabel} at ${booking.time}`,
    "professional_assigned",
    { bookingId: booking.id }
  );

  res.json({ ...booking, professionalId: professional.id });
});

// --- GET this professional's ratings/comments — anonymized, no customer identity ---
router.get("/ratings", (req, res) => {
  const professional = getMyProfessional(req);
  if (!professional) {
    return res.status(404).json({ error: "Professional profile not found" });
  }

  const ratings = db
    .prepare(
      `SELECT rating, comment, createdAt FROM professional_ratings
       WHERE professionalId = ? ORDER BY createdAt DESC`
    )
    .all(professional.id);

  const average =
    ratings.length > 0
      ? Math.round((ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length) * 10) / 10
      : 0;

  res.json({ average, count: ratings.length, ratings });
});

module.exports = router;
