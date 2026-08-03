const db = require("./db");

function generateTimeSlots(openTime, closeTime) {
  const [openH] = openTime.split(":").map(Number);
  const [closeH] = closeTime.split(":").map(Number);
  const slots = [];
  for (let h = openH; h < closeH; h++) {
    slots.push(`${String(h).padStart(2, "0")}:00`);
    slots.push(`${String(h).padStart(2, "0")}:30`);
  }
  return slots;
}

// True if the owner has blocked this professional for this exact date/time,
// either directly or via a whole-day block (time IS NULL).
function isProfessionalUnavailable(professionalId, date, time) {
  const row = db
    .prepare(
      `SELECT id FROM professional_unavailability
       WHERE professionalId = ? AND date = ? AND (time IS NULL OR time = ?)`
    )
    .get(professionalId, date, time);
  return !!row;
}

// True if the owner has blocked this professional for the entire day.
function isProfessionalOffAllDay(professionalId, date) {
  const row = db
    .prepare(
      "SELECT id FROM professional_unavailability WHERE professionalId = ? AND date = ? AND time IS NULL"
    )
    .get(professionalId, date);
  return !!row;
}

// True if every professional qualified for this service is either booked or
// marked unavailable at this exact date/time (i.e. a customer picking "No
// Preference" would have nobody free). Falls back to a simple one-booking-
// per-slot check if the salon has no professionals configured at all.
function isSlotFullyBooked(salonId, serviceId, date, time) {
  const pros = db
    .prepare(
      `SELECT p.id FROM professionals p
       INNER JOIN professional_services ps ON ps.professionalId = p.id
       WHERE p.salonId = ? AND ps.serviceId = ?`
    )
    .all(salonId, serviceId);

  if (pros.length === 0) {
    const conflict = db
      .prepare("SELECT id FROM bookings WHERE salonId = ? AND date = ? AND time = ?")
      .get(salonId, date, time);
    return !!conflict;
  }

  return pros.every((p) => {
    const booked = db
      .prepare("SELECT id FROM bookings WHERE professionalId = ? AND date = ? AND time = ?")
      .get(p.id, date, time);
    return !!booked || isProfessionalUnavailable(p.id, date, time);
  });
}

module.exports = {
  generateTimeSlots,
  isProfessionalUnavailable,
  isProfessionalOffAllDay,
  isSlotFullyBooked,
};
