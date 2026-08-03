const db = require("./db");
const { notify } = require("./notify");
const { isProfessionalUnavailable, isSlotFullyBooked } = require("./professionalAvailability");

// Call this whenever a booking is cancelled (or a slot otherwise frees up),
// so anyone waiting for that exact salon/service/date/time can be notified.
// `freedProfessionalId` is the professional whose booking was just removed,
// if any (null for a no-professionals-configured salon).
function checkWaitlistOnFreedSlot(salonId, serviceId, date, time, freedProfessionalId) {
  const entries = db
    .prepare(
      `SELECT * FROM waitlist_entries
       WHERE salonId = ? AND serviceId = ? AND date = ? AND time = ? AND notified = 0`
    )
    .all(salonId, serviceId, date, time);

  if (entries.length === 0) return;

  entries.forEach((entry) => {
    let isOpenForThem;

    if (entry.professionalId) {
      if (entry.professionalId === freedProfessionalId) {
        isOpenForThem = true;
      } else {
        const busy = db
          .prepare("SELECT id FROM bookings WHERE professionalId = ? AND date = ? AND time = ?")
          .get(entry.professionalId, date, time);
        isOpenForThem = !busy && !isProfessionalUnavailable(entry.professionalId, date, time);
      }
    } else {
      isOpenForThem = !isSlotFullyBooked(salonId, serviceId, date, time);
    }

    if (!isOpenForThem) return;

    db.prepare("UPDATE waitlist_entries SET notified = 1 WHERE id = ?").run(entry.id);

    notify(
      entry.userId,
      "A spot opened up! 🎉",
      `${entry.serviceName} at ${entry.salonName} on ${entry.dateLabel} at ${entry.time} is now available — book it before it's gone.`,
      "waitlist_opening",
      { salonId, serviceId, date, time }
    );
  });
}

module.exports = { checkWaitlistOnFreedSlot };
