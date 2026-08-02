const db = require("./db");
const { v4: uuidv4 } = require("uuid");
const { notify } = require("./notify");

const REWARD_VALID_DAYS = 90;

// Checks whether this booking just pushed the customer over a loyalty
// milestone at this salon, and if so, issues a one-time promo code reward
// (recipient-restricted to them) and notifies them. Reuses the existing
// promo code system, so it auto-applies at their next booking with no new
// customer-facing UI needed.
function checkLoyaltyMilestone(salonId, userId, salonName) {
  if (userId === "guest") return;

  const settings = db.prepare("SELECT * FROM loyalty_settings WHERE salonId = ?").get(salonId);
  if (!settings || !settings.enabled) return;

  const { count } = db
    .prepare("SELECT COUNT(*) as count FROM bookings WHERE salonId = ? AND userId = ?")
    .get(salonId, userId);

  if (count === 0 || count % settings.visitsRequired !== 0) return;

  const alreadyRewarded = db
    .prepare("SELECT id FROM loyalty_rewards WHERE salonId = ? AND userId = ? AND visitCount = ?")
    .get(salonId, userId, count);
  if (alreadyRewarded) return;

  const promoCode = {
    id: uuidv4(),
    salonId,
    code: `LOYALTY-${uuidv4().slice(0, 8).toUpperCase()}`,
    discountPercent: settings.discountPercent,
    active: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + REWARD_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
  db.prepare(
    `INSERT INTO promo_codes (id, salonId, code, discountPercent, active, createdAt, expiresAt)
     VALUES (@id, @salonId, @code, @discountPercent, @active, @createdAt, @expiresAt)`
  ).run(promoCode);

  db.prepare(
    "INSERT INTO promo_code_recipients (id, promoCodeId, userId) VALUES (?, ?, ?)"
  ).run(uuidv4(), promoCode.id, userId);

  db.prepare(
    `INSERT INTO loyalty_rewards (id, salonId, userId, visitCount, promoCodeId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuidv4(), salonId, userId, count, promoCode.id, new Date().toISOString());

  notify(
    userId,
    "🎉 Loyalty Reward Earned!",
    `You've earned ${settings.discountPercent}% off your next visit to ${salonName} — it'll apply automatically at checkout.`,
    "loyalty_reward",
    { salonId, promoCodeId: promoCode.id }
  );
}

module.exports = { checkLoyaltyMilestone };
