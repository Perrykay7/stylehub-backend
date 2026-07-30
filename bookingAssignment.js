const db = require("./db");
const { notify } = require("./notify");
const { isProfessionalUnavailable } = require("./professionalAvailability");

// If nobody claims a "No Preference" booking before it's this close to
// starting, auto-assign the least-busy free professional so the customer
// isn't left without anyone.
const AUTO_ASSIGN_CUTOFF_HOURS = 2;

function findFreeQualifiedProfessionals(salonId, serviceId, date, time, excludeBookingId) {
  const qualifiedProfessionals = db
    .prepare(
      `SELECT p.id FROM professionals p
       INNER JOIN professional_services ps ON ps.professionalId = p.id
       WHERE p.salonId = ? AND ps.serviceId = ?`
    )
    .all(salonId, serviceId);

  return qualifiedProfessionals.filter((p) => {
    const conflict = db
      .prepare(
        "SELECT id FROM bookings WHERE professionalId = ? AND date = ? AND time = ? AND id != ?"
      )
      .get(p.id, date, time, excludeBookingId || "");
    if (conflict) return false;
    return !isProfessionalUnavailable(p.id, date, time);
  });
}

// Assigns the least-busy free professional to a specific unclaimed booking.
// Returns the assigned professional row, or null if nobody was free/available.
function assignBooking(booking) {
  const available = findFreeQualifiedProfessionals(
    booking.salonId,
    booking.serviceId,
    booking.date,
    booking.time,
    booking.id
  );

  if (available.length === 0) return null;

  const counts = available.map((p) => {
    const count = db
      .prepare("SELECT COUNT(*) as count FROM bookings WHERE professionalId = ? AND date = ?")
      .get(p.id, booking.date);
    return { id: p.id, count: count.count };
  });
  counts.sort((a, b) => a.count - b.count);
  const assignedId = counts[0].id;

  const result = db
    .prepare("UPDATE bookings SET professionalId = ? WHERE id = ? AND professionalId IS NULL")
    .run(assignedId, booking.id);

  if (result.changes !== 1) return null;

  return db.prepare("SELECT * FROM professionals WHERE id = ?").get(assignedId);
}

// Finds "No Preference" bookings still unclaimed and within the cutoff
// window of their start time, and auto-assigns each one. Safe to call on
// every read since the app has no persistent background scheduler.
function autoAssignStaleBookings() {
  const stale = db
    .prepare("SELECT * FROM bookings WHERE professionalId IS NULL AND noPreference = 1")
    .all();

  const now = Date.now();

  stale.forEach((booking) => {
    const appointmentTime = new Date(`${booking.date}T${booking.time}:00`).getTime();
    const hoursUntil = (appointmentTime - now) / (1000 * 60 * 60);
    if (hoursUntil > AUTO_ASSIGN_CUTOFF_HOURS) return;

    const professional = assignBooking(booking);
    if (!professional) return;

    notify(
      booking.userId,
      "Professional Assigned ✂️",
      `${professional.name} will handle your ${booking.serviceName} on ${booking.dateLabel} at ${booking.time}`,
      "professional_assigned",
      { bookingId: booking.id }
    );

    if (professional.userId) {
      notify(
        professional.userId,
        "Booking Assigned to You 💈",
        `${booking.serviceName} on ${booking.dateLabel} at ${booking.time}`,
        "new_assignment",
        { bookingId: booking.id }
      );
    }
  });
}

module.exports = { autoAssignStaleBookings, findFreeQualifiedProfessionals };
