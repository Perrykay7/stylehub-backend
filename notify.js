const db = require("./db");
const { v4: uuidv4 } = require("uuid");
const { sendPushNotification } = require("./pushHelper");

// Records a notification in the user's in-app history and, if they have a
// push token, also sends it as a push notification.
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

  const user = db.prepare("SELECT pushToken FROM users WHERE id = ?").get(userId);
  if (user?.pushToken) {
    sendPushNotification(user.pushToken, title, body, data);
  }
}

module.exports = { notify };
