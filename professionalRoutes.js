const express = require("express");
const db = require("./db");
const { requireAuth, requireProfessional } = require("./authMiddleware");

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
