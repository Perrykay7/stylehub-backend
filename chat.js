const db = require("./db");
const { v4: uuidv4 } = require("uuid");
const { notify } = require("./notify");

const MESSAGE_LIFETIME_MS = 24 * 60 * 60 * 1000;

// Messages older than 24h are deleted so chats stay ephemeral. Called
// opportunistically on every read/write instead of a scheduled job.
function pruneOldMessages() {
  const cutoff = new Date(Date.now() - MESSAGE_LIFETIME_MS).toISOString();
  db.prepare("DELETE FROM messages WHERE createdAt < ?").run(cutoff);
}

// In-memory room registry: `${salonId}:${customerId}` -> Set of { ws, role }
// Lets us know who's actively viewing a conversation so we only push-notify
// the side that isn't currently looking at it.
const rooms = new Map();

function roomKey(salonId, customerId) {
  return `${salonId}:${customerId}`;
}

function joinRoom(salonId, customerId, ws, role) {
  const key = roomKey(salonId, customerId);
  if (!rooms.has(key)) rooms.set(key, new Set());
  const entry = { ws, role };
  rooms.get(key).add(entry);
  return entry;
}

function leaveRoom(salonId, customerId, entry) {
  const key = roomKey(salonId, customerId);
  const set = rooms.get(key);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) rooms.delete(key);
}

function hasRole(salonId, customerId, role) {
  const set = rooms.get(roomKey(salonId, customerId));
  if (!set) return false;
  for (const entry of set) {
    if (entry.role === role) return true;
  }
  return false;
}

function broadcast(salonId, customerId, payload) {
  const set = rooms.get(roomKey(salonId, customerId));
  if (!set) return;
  const json = JSON.stringify(payload);
  set.forEach(({ ws }) => {
    if (ws.readyState === ws.OPEN) ws.send(json);
  });
}

function sendMessage({ salonId, customerId, senderRole, body }) {
  pruneOldMessages();

  const message = {
    id: uuidv4(),
    salonId,
    customerId,
    senderRole,
    body,
    createdAt: new Date().toISOString(),
    readByCustomer: senderRole === "customer" ? 1 : 0,
    readByOwner: senderRole === "owner" ? 1 : 0,
  };

  db.prepare(
    `INSERT INTO messages (id, salonId, customerId, senderRole, body, createdAt, readByCustomer, readByOwner)
     VALUES (@id, @salonId, @customerId, @senderRole, @body, @createdAt, @readByCustomer, @readByOwner)`
  ).run(message);

  broadcast(salonId, customerId, { type: "message", message });

  const recipientRole = senderRole === "customer" ? "owner" : "customer";
  if (!hasRole(salonId, customerId, recipientRole)) {
    const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(salonId);
    if (recipientRole === "owner") {
      if (salon?.ownerId) {
        const customer = db.prepare("SELECT name FROM users WHERE id = ?").get(customerId);
        notify(
          salon.ownerId,
          `New message from ${customer?.name || "a customer"}`,
          body,
          "new_message",
          { salonId, customerId }
        );
      }
    } else {
      notify(customerId, `${salon?.name || "Salon"} sent you a message`, body, "new_message", {
        salonId,
        customerId,
      });
    }
  }

  return message;
}

// Looks up a message and confirms the requester actually sent it, so only
// the original sender can edit/delete it.
function getOwnMessage(messageId, requesterId, requesterRole) {
  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
  if (!message) return null;
  if (message.senderRole !== requesterRole) return null;

  if (requesterRole === "customer") {
    if (message.customerId !== requesterId) return null;
  } else {
    const salon = db.prepare("SELECT ownerId FROM salons WHERE id = ?").get(message.salonId);
    if (!salon || salon.ownerId !== requesterId) return null;
  }

  return message;
}

function editMessage(messageId, requesterId, requesterRole, newBody) {
  const message = getOwnMessage(messageId, requesterId, requesterRole);
  if (!message) return null;

  db.prepare("UPDATE messages SET body = ?, edited = 1 WHERE id = ?").run(newBody, messageId);
  const updated = { ...message, body: newBody, edited: 1 };
  broadcast(message.salonId, message.customerId, { type: "message_edited", message: updated });
  return updated;
}

function deleteMessage(messageId, requesterId, requesterRole) {
  const message = getOwnMessage(messageId, requesterId, requesterRole);
  if (!message) return null;

  db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
  broadcast(message.salonId, message.customerId, {
    type: "message_deleted",
    messageId,
    salonId: message.salonId,
    customerId: message.customerId,
  });
  return message;
}

function initChatServer(server) {
  const { WebSocketServer } = require("ws");
  const jwt = require("jsonwebtoken");
  const { JWT_SECRET } = require("./authMiddleware");

  const wss = new WebSocketServer({ server, path: "/ws/chat" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    let userId, role;
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      userId = payload.userId;
      role = payload.role;
    } catch {
      ws.close(4001, "Unauthorized");
      return;
    }

    if (role !== "owner" && role !== "customer") {
      ws.close(4003, "Chat is only available to customers and salon owners");
      return;
    }

    let joined = null;

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "join" && typeof msg.salonId === "string") {
        let customerId;
        if (role === "owner") {
          const salon = db.prepare("SELECT * FROM salons WHERE id = ?").get(msg.salonId);
          if (!salon || salon.ownerId !== userId || typeof msg.customerId !== "string") return;
          customerId = msg.customerId;
        } else {
          customerId = userId;
        }
        if (joined) leaveRoom(joined.salonId, joined.customerId, joined.entry);
        const entry = joinRoom(msg.salonId, customerId, ws, role);
        joined = { salonId: msg.salonId, customerId, entry };
        return;
      }

      if (msg.type === "message" && joined && typeof msg.body === "string" && msg.body.trim()) {
        sendMessage({
          salonId: joined.salonId,
          customerId: joined.customerId,
          senderRole: role,
          body: msg.body.trim().slice(0, 2000),
        });
      }

      if (msg.type === "edit_message" && typeof msg.messageId === "string" && typeof msg.body === "string" && msg.body.trim()) {
        editMessage(msg.messageId, userId, role, msg.body.trim().slice(0, 2000));
      }

      if (msg.type === "delete_message" && typeof msg.messageId === "string") {
        deleteMessage(msg.messageId, userId, role);
      }
    });

    ws.on("close", () => {
      if (joined) leaveRoom(joined.salonId, joined.customerId, joined.entry);
    });
  });
}

module.exports = { initChatServer, sendMessage, editMessage, deleteMessage, pruneOldMessages };
