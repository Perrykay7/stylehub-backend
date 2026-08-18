const db = require("./db");
const { notify } = require("./notify");

// Must match the cancellation cutoff enforced in DELETE /bookings/:id.
const CANCELLATION_REMINDER_HOURS = 2;

// How long after an appointment's start time to nudge the customer to rate
// their professional, if they haven't already.
const REVIEW_REMINDER_HOURS_AFTER = 3;

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

// Nudges a customer to rate their professional a few hours after their
// appointment started, if they haven't already. Safe to call on every read,
// same as generateCancellationReminders — each booking is only ever
// considered once (whether a nudge went out or was skipped as unnecessary).
function generateReviewReminders() {
  const candidates = db
    .prepare(
      `SELECT b.*, p.name AS professionalName FROM bookings b
       LEFT JOIN professionals p ON b.professionalId = p.id
       WHERE b.reviewReminderSent = 0 AND b.userId != 'guest' AND b.professionalId IS NOT NULL`
    )
    .all();

  const now = Date.now();

  candidates.forEach((booking) => {
    const appointmentTime = new Date(`${booking.date}T${booking.time}:00`).getTime();
    const hoursSince = (now - appointmentTime) / (1000 * 60 * 60);
    if (hoursSince < REVIEW_REMINDER_HOURS_AFTER) return;

    const alreadyRated = db
      .prepare("SELECT id FROM professional_ratings WHERE bookingId = ?")
      .get(booking.id);

    if (!alreadyRated) {
      notify(
        booking.userId,
        "How was your visit? ⭐",
        `Rate ${booking.professionalName || "your professional"} for your ${booking.serviceName} at ${booking.salonName}.`,
        "review_reminder",
        { bookingId: booking.id, professionalId: booking.professionalId }
      );
    }

    db.prepare("UPDATE bookings SET reviewReminderSent = 1 WHERE id = ?").run(booking.id);
  });
}

module.exports = { generateCancellationReminders, generateReviewReminders };
