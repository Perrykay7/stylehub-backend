const twilioLib = require("twilio");

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;

const client =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// Local numbers are stored without a country code (e.g. "0552213828").
// Twilio requires E.164 format. Assumes Ghana (+233) for un-prefixed numbers.
function toE164(phone) {
  if (!phone) return null;
  if (phone.startsWith("+")) return phone;
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("233")) return `+${digits}`;
  if (digits.startsWith("0")) return `+233${digits.slice(1)}`;
  return `+233${digits}`;
}

async function sendSms(toPhone, body) {
  if (!client || !TWILIO_PHONE_NUMBER) return;
  const to = toE164(toPhone);
  if (!to) return;
  try {
    await client.messages.create({ body, from: TWILIO_PHONE_NUMBER, to });
  } catch (err) {
    console.error("SMS send failed:", err.message);
  }
}

module.exports = { sendSms };
