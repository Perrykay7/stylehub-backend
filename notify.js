const db = require("./db");
const { v4: uuidv4 } = require("uuid");
const { sendPushNotification } = require("./pushHelper");
const { sendSms } = require("./smsHelper");

// The only "marketing" style notification today is an owner's broadcast
// announcement to their customers — everything else is appointment-related.
const MARKETING_TYPES = new Set(["announcement"]);

// Records a notification in the user's in-app history, sends it as a push
// notification if they have a token, and sends it by SMS if they've opted
// into text messages for that notification's category.
function notify(userId, title, body, type, data) {
  db.prepare(
    `INSERT INTO notifications (id, userId, title, body, type, data, read, createdAt)
     VALUES (@id, @userId, @title, @body, @type, @data, 0, @createdAt)`
  ).run({
    id: uuidv4(),
    userId,
    title,
    body,
    type,
    data: data ? JSON.stringify(data) : null,
    createdAt: new Date().toISOString(),
  });

  const user = db
    .prepare(
      `SELECT pushToken, phone, smsAppointmentNotifications, smsMarketingNotifications
       FROM users WHERE id = ?`
    )
    .get(userId);
  if (!user) return;

  if (user.pushToken) {
    sendPushNotification(user.pushToken, title, body, data);
  }

  const isMarketing = MARKETING_TYPES.has(type);
  const smsEnabled = isMarketing ? user.smsMarketingNotifications : user.smsAppointmentNotifications;
  if (smsEnabled) {
    sendSms(user.phone, `${title}: ${body}`);
  }
}

module.exports = { notify };
