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

module.exports = { generateTimeSlots, isProfessionalUnavailable, isProfessionalOffAllDay };
