const db = require("./db");
const { notify } = require("./notify");

// Must match the cancellation cutoff enforced in DELETE /bookings/:id.
const CANCELLATION_REMINDER_HOURS = 2;

// Warns customers once their cancellation window is about to close. Safe to
// call on every read since the app has no persistent background scheduler —
// each booking is only ever reminded once (or skipped once its window has
// already passed without a reminder having gone out).
function generateCancellationReminders() {
  const candidates = db
    .prepare("SELECT * FROM bookings WHERE reminderSent = 0 AND userId != 'guest'")
    .all();

  const now = Date.now();

  candidates.forEach((booking) => {
    const appointmentTime = new Date(`${booking.date}T${booking.time}:00`).getTime();
    const hoursUntil = (appointmentTime - now) / (1000 * 60 * 60);
    if (hoursUntil > CANCELLATION_REMINDER_HOURS) return;

    if (hoursUntil > 0) {
      notify(
        booking.userId,
        "Cancellation window closing soon ⏳",
        `You have about ${CANCELLATION_REMINDER_HOURS} hours left to cancel your ${booking.serviceName} at ${booking.salonName}.`,
        "cancellation_reminder",
        { bookingId: booking.id }
      );
    }

    db.prepare("UPDATE bookings SET reminderSent = 1 WHERE id = ?").run(booking.id);
  });
}

module.exports = { generateCancellationReminders };
