const db = require("./db");

const MAX_CONTACTS_PER_SALON = 5;

// Attaches a `customerServiceContacts: {id, label, phone, email}[]` array
// (ordered) to each salon in a batched query, avoiding N+1 lookups.
function attachCustomerServiceContacts(salons) {
  if (salons.length === 0) return salons;

  const salonIds = salons.map((s) => s.id);
  const placeholders = salonIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, salonId, label, phone, email FROM salon_customer_service_contacts
       WHERE salonId IN (${placeholders})
       ORDER BY position ASC, createdAt ASC`
    )
    .all(...salonIds);

  const contactsBySalon = {};
  rows.forEach((row) => {
    if (!contactsBySalon[row.salonId]) contactsBySalon[row.salonId] = [];
    contactsBySalon[row.salonId].push({
      id: row.id,
      label: row.label,
      phone: row.phone,
      email: row.email,
    });
  });

  return salons.map((salon) => ({
    ...salon,
    customerServiceContacts: contactsBySalon[salon.id] || [],
  }));
}

module.exports = { attachCustomerServiceContacts, MAX_CONTACTS_PER_SALON };
