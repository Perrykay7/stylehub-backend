const Database = require("better-sqlite3");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const dbPath = process.env.RENDER
  ? "/data/stylehub.db"
  : path.join(__dirname, "stylehub.db");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

// --- Schema ---
db.exec(`
    
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS salons (
    id TEXT PRIMARY KEY,
    ownerId TEXT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    address TEXT NOT NULL,
    distanceKm REAL NOT NULL,
    rating REAL NOT NULL,
    reviewCount INTEGER NOT NULL,
    imageUrl TEXT NOT NULL,
    openTime TEXT NOT NULL,
    closeTime TEXT NOT NULL,
    FOREIGN KEY (ownerId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    salonId TEXT NOT NULL,
    name TEXT NOT NULL,
    durationMins INTEGER NOT NULL,
    price REAL NOT NULL,
    FOREIGN KEY (salonId) REFERENCES salons(id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    salonId TEXT NOT NULL,
    customerName TEXT NOT NULL,
    rating INTEGER NOT NULL,
    comment TEXT NOT NULL,
    date TEXT NOT NULL,
    FOREIGN KEY (salonId) REFERENCES salons(id)
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    salonId TEXT NOT NULL,
    serviceId TEXT NOT NULL,
    salonName TEXT NOT NULL,
    serviceName TEXT NOT NULL,
    date TEXT NOT NULL,
    dateLabel TEXT NOT NULL,
    time TEXT NOT NULL,
    price REAL NOT NULL,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (salonId) REFERENCES salons(id),
    FOREIGN KEY (serviceId) REFERENCES services(id)
  );
`);
// --- Migration: add promo code support ---
db.exec(`
  CREATE TABLE IF NOT EXISTS promo_codes (
    id TEXT PRIMARY KEY,
    salonId TEXT NOT NULL,
    code TEXT NOT NULL,
    discountPercent REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (salonId) REFERENCES salons(id)
  );
`);

function columnExists(table, column) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some((c) => c.name === column);
}

if (!columnExists("bookings", "originalPrice")) {
  db.exec(`ALTER TABLE bookings ADD COLUMN originalPrice REAL`);
}
if (!columnExists("bookings", "discountAmount")) {
  db.exec(`ALTER TABLE bookings ADD COLUMN discountAmount REAL`);
}
if (!columnExists("promo_codes", "expiresAt")) {
  db.exec(`ALTER TABLE promo_codes ADD COLUMN expiresAt TEXT`);
}

// --- Migration: add password reset support ---
db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    phone TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expiresAt TEXT NOT NULL
  );
`);

// --- Migration: add targeted promo code recipients ---
db.exec(`
  CREATE TABLE IF NOT EXISTS promo_code_recipients (
    id TEXT PRIMARY KEY,
    promoCodeId TEXT NOT NULL,
    userId TEXT NOT NULL,
    FOREIGN KEY (promoCodeId) REFERENCES promo_codes(id),
    FOREIGN KEY (userId) REFERENCES users(id)
  );
`);

// --- Migration: add professionals ---
db.exec(`
  CREATE TABLE IF NOT EXISTS professionals (
    id TEXT PRIMARY KEY,
    salonId TEXT NOT NULL,
    name TEXT NOT NULL,
    photoUrl TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (salonId) REFERENCES salons(id)
  );

  CREATE TABLE IF NOT EXISTS professional_services (
    id TEXT PRIMARY KEY,
    professionalId TEXT NOT NULL,
    serviceId TEXT NOT NULL,
    FOREIGN KEY (professionalId) REFERENCES professionals(id),
    FOREIGN KEY (serviceId) REFERENCES services(id)
  );
`);

// --- Migration: add professional ratings ---
db.exec(`
  CREATE TABLE IF NOT EXISTS professional_ratings (
    id TEXT PRIMARY KEY,
    professionalId TEXT NOT NULL,
    bookingId TEXT NOT NULL,
    userId TEXT NOT NULL,
    rating INTEGER NOT NULL,
    comment TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (professionalId) REFERENCES professionals(id),
    FOREIGN KEY (bookingId) REFERENCES bookings(id),
    FOREIGN KEY (userId) REFERENCES users(id)
  );
`);

// --- Migration: add guest booking support (for owner-created manual bookings) ---
if (!columnExists("bookings", "guestName")) {
  db.exec(`ALTER TABLE bookings ADD COLUMN guestName TEXT`);
}
if (!columnExists("bookings", "guestPhone")) {
  db.exec(`ALTER TABLE bookings ADD COLUMN guestPhone TEXT`);
}

if (!columnExists("bookings", "professionalId")) {
  db.exec(`ALTER TABLE bookings ADD COLUMN professionalId TEXT`);
}

// --- Migration: track whether the customer picked "No Preference" ---
// so the display can say so even though a real professional got auto-assigned.
if (!columnExists("bookings", "noPreference")) {
  db.exec(`ALTER TABLE bookings ADD COLUMN noPreference INTEGER NOT NULL DEFAULT 0`);
}

// --- Migration: track whether the 2-hour cancellation-window reminder was sent ---
if (!columnExists("bookings", "reminderSent")) {
  db.exec(`ALTER TABLE bookings ADD COLUMN reminderSent INTEGER NOT NULL DEFAULT 0`);
}

// --- Migration: in-app notification history ---
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id)
  );
`);

// --- Migration: let owners mark a professional unavailable for a specific
// time slot or a whole day (e.g. time off, personal appointments) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS professional_unavailability (
    id TEXT PRIMARY KEY,
    professionalId TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (professionalId) REFERENCES professionals(id)
  );
`);

// --- Migration: add blocked_slots table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_slots (
    id TEXT PRIMARY KEY,
    salonId TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    FOREIGN KEY (salonId) REFERENCES salons(id)
  );
`);

// --- Migration: add userId to reviews ---
if (!columnExists("reviews", "userId")) {
  db.exec(`ALTER TABLE reviews ADD COLUMN userId TEXT`);
}

// --- Migration: add createdAt to salons ---
if (!columnExists("salons", "createdAt")) {
  db.exec(`ALTER TABLE salons ADD COLUMN createdAt TEXT`);
  db.exec(`UPDATE salons SET createdAt = '2020-01-01T00:00:00.000Z' WHERE createdAt IS NULL`);
}

// --- Migration: add ownerCode column to users ---
if (!columnExists("users", "ownerCode")) {
  db.exec(`ALTER TABLE users ADD COLUMN ownerCode TEXT`);
}

// --- Migration: track which professional referral code a user last verified with ---
if (!columnExists("users", "professionalCode")) {
  db.exec(`ALTER TABLE users ADD COLUMN professionalCode TEXT`);
}

// --- Migration: add push token to users ---
if (!columnExists("users", "pushToken")) {
  db.exec(`ALTER TABLE users ADD COLUMN pushToken TEXT`);
}

// --- Migration: per-channel notification preferences (email intentionally omitted) ---
if (!columnExists("users", "smsAppointmentNotifications")) {
  db.exec(`ALTER TABLE users ADD COLUMN smsAppointmentNotifications INTEGER NOT NULL DEFAULT 1`);
}
if (!columnExists("users", "whatsappAppointmentNotifications")) {
  db.exec(`ALTER TABLE users ADD COLUMN whatsappAppointmentNotifications INTEGER NOT NULL DEFAULT 1`);
}
if (!columnExists("users", "smsMarketingNotifications")) {
  db.exec(`ALTER TABLE users ADD COLUMN smsMarketingNotifications INTEGER NOT NULL DEFAULT 1`);
}
if (!columnExists("users", "whatsappMarketingNotifications")) {
  db.exec(`ALTER TABLE users ADD COLUMN whatsappMarketingNotifications INTEGER NOT NULL DEFAULT 1`);
}

// --- Migration: per-salon loyalty program (every Nth visit earns a discount) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS loyalty_settings (
    salonId TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    visitsRequired INTEGER NOT NULL DEFAULT 5,
    discountPercent REAL NOT NULL DEFAULT 10,
    FOREIGN KEY (salonId) REFERENCES salons(id)
  );

  CREATE TABLE IF NOT EXISTS loyalty_rewards (
    id TEXT PRIMARY KEY,
    salonId TEXT NOT NULL,
    userId TEXT NOT NULL,
    visitCount INTEGER NOT NULL,
    promoCodeId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (salonId) REFERENCES salons(id),
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (promoCodeId) REFERENCES promo_codes(id)
  );
`);

// --- Migration: allow loyalty rewards with no discount (recognition-only,
// e.g. badges/tiers), which have no promo code ---
{
  const loyaltyRewardsCols = db.prepare("PRAGMA table_info(loyalty_rewards)").all();
  const promoCodeIdCol = loyaltyRewardsCols.find((c) => c.name === "promoCodeId");
  if (promoCodeIdCol && promoCodeIdCol.notnull === 1) {
    db.exec(`
      CREATE TABLE loyalty_rewards_new (
        id TEXT PRIMARY KEY,
        salonId TEXT NOT NULL,
        userId TEXT NOT NULL,
        visitCount INTEGER NOT NULL,
        promoCodeId TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (salonId) REFERENCES salons(id),
        FOREIGN KEY (userId) REFERENCES users(id),
        FOREIGN KEY (promoCodeId) REFERENCES promo_codes(id)
      );
      INSERT INTO loyalty_rewards_new SELECT * FROM loyalty_rewards;
      DROP TABLE loyalty_rewards;
      ALTER TABLE loyalty_rewards_new RENAME TO loyalty_rewards;
    `);
  }
}

// --- Migration: waitlist for fully-booked slots ---
db.exec(`
  CREATE TABLE IF NOT EXISTS waitlist_entries (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    salonId TEXT NOT NULL,
    serviceId TEXT NOT NULL,
    professionalId TEXT,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    dateLabel TEXT NOT NULL,
    salonName TEXT NOT NULL,
    serviceName TEXT NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (salonId) REFERENCES salons(id),
    FOREIGN KEY (serviceId) REFERENCES services(id)
  );
`);

// --- Migration: let professionals sign in and claim their roster entry ---
if (!columnExists("professionals", "userId")) {
  db.exec(`ALTER TABLE professionals ADD COLUMN userId TEXT`);
}
if (!columnExists("professionals", "claimCode")) {
  db.exec(`ALTER TABLE professionals ADD COLUMN claimCode TEXT`);
}
// Backfill a claim code for any existing professionals added before this migration
const professionalsMissingClaimCode = db
  .prepare("SELECT id FROM professionals WHERE claimCode IS NULL AND userId IS NULL")
  .all();
if (professionalsMissingClaimCode.length > 0) {
  const setClaimCode = db.prepare("UPDATE professionals SET claimCode = ? WHERE id = ?");
  professionalsMissingClaimCode.forEach((p) => {
    setClaimCode.run(uuidv4().slice(0, 8).toUpperCase(), p.id);
  });
}

// --- Migration: add category to services ---
if (!columnExists("services", "category")) {
  db.exec(`ALTER TABLE services ADD COLUMN category TEXT`);
}

// --- Migration: add service photos (owners can add up to 3 per service) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS service_images (
    id TEXT PRIMARY KEY,
    serviceId TEXT NOT NULL,
    imageUrl TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (serviceId) REFERENCES services(id)
  );
`);

// --- Migration: add favorites ---
db.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    salonId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    UNIQUE(userId, salonId),
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (salonId) REFERENCES salons(id)
  );
`);

// --- Migration: per-day working hours ---
db.exec(`
  CREATE TABLE IF NOT EXISTS salon_hours (
    id TEXT PRIMARY KEY,
    salonId TEXT NOT NULL,
    dayOfWeek INTEGER NOT NULL,
    openTime TEXT,
    closeTime TEXT,
    isClosed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (salonId) REFERENCES salons(id),
    UNIQUE(salonId, dayOfWeek)
  );
`);

// --- Settings table for runtime-configurable values ---
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Seed the invite code from env if not already in DB
const existingCode = db.prepare("SELECT value FROM settings WHERE key = 'owner_invite_code'").get();
if (!existingCode) {
  const initialCode = process.env.OWNER_INVITE_CODE || "";
  db.prepare("INSERT INTO settings (key, value) VALUES ('owner_invite_code', ?)").run(initialCode);
}

const existingProfessionalCode = db
  .prepare("SELECT value FROM settings WHERE key = 'professional_invite_code'")
  .get();
if (!existingProfessionalCode) {
  const initialProfessionalCode = process.env.PROFESSIONAL_INVITE_CODE || "";
  db.prepare("INSERT INTO settings (key, value) VALUES ('professional_invite_code', ?)").run(
    initialProfessionalCode
  );
}

// --- Ensure a placeholder "guest" user exists for manual/walk-in bookings ---
const guestUser = db.prepare("SELECT id FROM users WHERE id = ?").get("guest");
if (!guestUser) {
  db.prepare(
    `INSERT INTO users (id, name, phone, passwordHash, role, createdAt)
     VALUES ('guest', 'Walk-in Guest', '0000000000', 'no-login', 'customer', ?)`
  ).run(new Date().toISOString());
}

// --- Seed data (only runs if salons table is empty) ---
const salonCount = db.prepare("SELECT COUNT(*) as count FROM salons").get();

if (salonCount.count === 0) {
  console.log("Seeding database with mock salon data...");

  const insertSalon = db.prepare(`
    INSERT INTO salons (id, ownerId, name, category, address, distanceKm, rating, reviewCount, imageUrl, openTime, closeTime)
    VALUES (@id, @ownerId, @name, @category, @address, @distanceKm, @rating, @reviewCount, @imageUrl, @openTime, @closeTime)
  `);
  const insertService = db.prepare(`
    INSERT INTO services (id, salonId, name, durationMins, price)
    VALUES (@id, @salonId, @name, @durationMins, @price)
  `);
  const insertReview = db.prepare(`
    INSERT INTO reviews (id, salonId, customerName, rating, comment, date)
    VALUES (@id, @salonId, @customerName, @rating, @comment, @date)
  `);

  const seedSalons = [
    {
      id: "1",
      ownerId: null,
      name: "Glow Studio Accra",
      category: "Hair Salon",
      address: "12 Oxford Street, Osu, Accra",
      distanceKm: 1.2,
      rating: 4.8,
      reviewCount: 132,
      imageUrl: "https://images.unsplash.com/photo-1560066984-138dadb4c035?w=800",
      openTime: "09:00",
      closeTime: "19:00",
      services: [
        { name: "Haircut & Style", durationMins: 45, price: 80 },
        { name: "Braids (Box Braids)", durationMins: 180, price: 250 },
        { name: "Wash & Blow Dry", durationMins: 30, price: 50 },
      ],
      reviews: [
        { customerName: "Akosua M.", rating: 5, comment: "Best braiding service in Accra, very neat work.", date: "2026-06-10" },
        { customerName: "Yaw B.", rating: 4, comment: "Great haircut, friendly staff. Slightly long wait.", date: "2026-06-02" },
      ],
    },
    {
      id: "2",
      ownerId: null,
      name: "Serenity Spa & Wellness",
      category: "Spa",
      address: "45 Ring Road Central, Accra",
      distanceKm: 2.7,
      rating: 4.9,
      reviewCount: 87,
      imageUrl: "https://images.unsplash.com/photo-1540555700478-4be289fbecef?w=800",
      openTime: "10:00",
      closeTime: "20:00",
      services: [
        { name: "Full Body Massage", durationMins: 60, price: 200 },
        { name: "Facial Treatment", durationMins: 50, price: 150 },
        { name: "Hot Stone Therapy", durationMins: 75, price: 280 },
      ],
      reviews: [
        { customerName: "Linda K.", rating: 5, comment: "So relaxing, the hot stone massage was amazing.", date: "2026-06-15" },
      ],
    },
    {
      id: "3",
      ownerId: null,
      name: "Nailed It Studio",
      category: "Nail Studio",
      address: "8 Spintex Road, Accra",
      distanceKm: 3.5,
      rating: 4.6,
      reviewCount: 64,
      imageUrl: "https://images.unsplash.com/photo-1604654894610-df63bc536371?w=800",
      openTime: "09:30",
      closeTime: "18:30",
      services: [
        { name: "Gel Manicure", durationMins: 40, price: 90 },
        { name: "Pedicure", durationMins: 45, price: 100 },
        { name: "Nail Art (Custom)", durationMins: 60, price: 130 },
      ],
      reviews: [
        { customerName: "Esi A.", rating: 5, comment: "Loved my nail art, very detailed and clean.", date: "2026-06-18" },
        { customerName: "Joana T.", rating: 4, comment: "Good service, slightly pricey but worth it.", date: "2026-05-28" },
      ],
    },
  ];

  const seedAll = db.transaction(() => {
    for (const salon of seedSalons) {
      insertSalon.run({
        id: salon.id,
        ownerId: salon.ownerId,
        name: salon.name,
        category: salon.category,
        address: salon.address,
        distanceKm: salon.distanceKm,
        rating: salon.rating,
        reviewCount: salon.reviewCount,
        imageUrl: salon.imageUrl,
        openTime: salon.openTime,
        closeTime: salon.closeTime,
      });

      for (const service of salon.services) {
        insertService.run({
          id: uuidv4(),
          salonId: salon.id,
          name: service.name,
          durationMins: service.durationMins,
          price: service.price,
        });
      }

      for (const review of salon.reviews) {
        insertReview.run({
          id: uuidv4(),
          salonId: salon.id,
          customerName: review.customerName,
          rating: review.rating,
          comment: review.comment,
          date: review.date,
        });
      }
    }
  });

  seedAll();
  console.log("Seeding complete.");
}

// --- One-time cleanup: remove the original placeholder demo salons (ids 1, 2, 3)
// and everything tied to them, now that real salons have been added. ---
const seedSalonsRemoved = db
  .prepare("SELECT value FROM settings WHERE key = 'seed_salons_removed'")
  .get();

if (!seedSalonsRemoved) {
  const removeSalon = db.transaction((salonId) => {
    const professionalIds = db
      .prepare("SELECT id FROM professionals WHERE salonId = ?")
      .all(salonId)
      .map((r) => r.id);
    const serviceIds = db
      .prepare("SELECT id FROM services WHERE salonId = ?")
      .all(salonId)
      .map((r) => r.id);

    if (professionalIds.length > 0) {
      const placeholders = professionalIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM professional_ratings WHERE professionalId IN (${placeholders})`).run(
        ...professionalIds
      );
      db.prepare(`DELETE FROM professional_services WHERE professionalId IN (${placeholders})`).run(
        ...professionalIds
      );
    }
    if (serviceIds.length > 0) {
      // Also clear by serviceId directly, in case a professional from another
      // salon was ever assigned to one of this salon's services.
      const placeholders = serviceIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM professional_services WHERE serviceId IN (${placeholders})`).run(
        ...serviceIds
      );
    }
    if (professionalIds.length > 0) {
      const placeholders = professionalIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM professionals WHERE id IN (${placeholders})`).run(...professionalIds);
    }

    const promoIds = db
      .prepare("SELECT id FROM promo_codes WHERE salonId = ?")
      .all(salonId)
      .map((r) => r.id);
    if (promoIds.length > 0) {
      const placeholders = promoIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM promo_code_recipients WHERE promoCodeId IN (${placeholders})`).run(
        ...promoIds
      );
      db.prepare(`DELETE FROM promo_codes WHERE id IN (${placeholders})`).run(...promoIds);
    }

    // Also clear bookings by serviceId directly, in case any booking's
    // salonId ever drifted out of sync with its serviceId's actual salon.
    if (serviceIds.length > 0) {
      const placeholders = serviceIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM bookings WHERE serviceId IN (${placeholders})`).run(...serviceIds);
    }
    db.prepare("DELETE FROM bookings WHERE salonId = ?").run(salonId);
    db.prepare("DELETE FROM reviews WHERE salonId = ?").run(salonId);
    db.prepare("DELETE FROM favorites WHERE salonId = ?").run(salonId);
    db.prepare("DELETE FROM blocked_slots WHERE salonId = ?").run(salonId);
    db.prepare("DELETE FROM salon_hours WHERE salonId = ?").run(salonId);
    db.prepare("DELETE FROM services WHERE salonId = ?").run(salonId);
    db.prepare("DELETE FROM salons WHERE id = ?").run(salonId);
  });

  ["1", "2", "3"].forEach((salonId) => {
    const exists = db.prepare("SELECT id FROM salons WHERE id = ?").get(salonId);
    if (exists) removeSalon(salonId);
  });

  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('seed_salons_removed', '1')"
  ).run();
}

// --- Migration: booking cancellation log + no-show tracking (for owner analytics) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS booking_events (
    id TEXT PRIMARY KEY,
    bookingId TEXT NOT NULL,
    salonId TEXT NOT NULL,
    serviceId TEXT NOT NULL,
    professionalId TEXT,
    price REAL NOT NULL,
    date TEXT NOT NULL,
    eventType TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
`);
if (!columnExists("bookings", "status")) {
  db.exec(`ALTER TABLE bookings ADD COLUMN status TEXT`);
}

// --- Migration: chat between a customer and a salon ---
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    salonId TEXT NOT NULL,
    customerId TEXT NOT NULL,
    senderRole TEXT NOT NULL,
    body TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    readByCustomer INTEGER NOT NULL DEFAULT 0,
    readByOwner INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (salonId) REFERENCES salons(id),
    FOREIGN KEY (customerId) REFERENCES users(id)
  );
`);

// --- Migration: professional portfolio photos (owners can add up to 3 per professional) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS professional_images (
    id TEXT PRIMARY KEY,
    professionalId TEXT NOT NULL,
    imageUrl TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (professionalId) REFERENCES professionals(id)
  );
`);

if (!columnExists("messages", "edited")) {
  db.exec(`ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0`);
}

// --- Migration: per-salon customer service contact (owner-editable) ---
// Superseded by the salon_customer_service_contacts table below (a salon can
// have multiple contacts), but left in place since these columns may still
// hold data from the earlier single-contact version.
if (!columnExists("salons", "customerServicePhone")) {
  db.exec(`ALTER TABLE salons ADD COLUMN customerServicePhone TEXT`);
}
if (!columnExists("salons", "customerServiceEmail")) {
  db.exec(`ALTER TABLE salons ADD COLUMN customerServiceEmail TEXT`);
}

// --- Migration: multiple customer service contacts per salon ---
db.exec(`
  CREATE TABLE IF NOT EXISTS salon_customer_service_contacts (
    id TEXT PRIMARY KEY,
    salonId TEXT NOT NULL,
    label TEXT,
    phone TEXT,
    email TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (salonId) REFERENCES salons(id)
  );
`);

// --- Migration: optional email on signup ---
if (!columnExists("users", "email")) {
  db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
}

// --- Migration: optional tip for a specifically-selected professional ---
if (!columnExists("bookings", "tipAmount")) {
  db.exec(`ALTER TABLE bookings ADD COLUMN tipAmount REAL NOT NULL DEFAULT 0`);
}

// --- Migration: salon photo gallery (owners can add up to 6 photos per salon) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS salon_images (
    id TEXT PRIMARY KEY,
    salonId TEXT NOT NULL,
    imageUrl TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (salonId) REFERENCES salons(id)
  );
`);

// --- Migration: optional customer notes/special requests on a booking ---
if (!columnExists("bookings", "notes")) {
  db.exec(`ALTER TABLE bookings ADD COLUMN notes TEXT`);
}

// --- Migration: track whether a post-visit review reminder was already sent ---
if (!columnExists("bookings", "reviewReminderSent")) {
  db.exec(`ALTER TABLE bookings ADD COLUMN reviewReminderSent INTEGER NOT NULL DEFAULT 0`);
}

// --- Migration: one-off special closure dates (e.g. holidays), on top of
// the salon's regular weekly hours ---
db.exec(`
  CREATE TABLE IF NOT EXISTS salon_closures (
    id TEXT PRIMARY KEY,
    salonId TEXT NOT NULL,
    date TEXT NOT NULL,
    reason TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (salonId) REFERENCES salons(id),
    UNIQUE (salonId, date)
  );
`);

// --- Migration: exact salon location (owner-captured GPS coordinates),
// separate from and independent of the free-text address ---
if (!columnExists("salons", "latitude")) {
  db.exec(`ALTER TABLE salons ADD COLUMN latitude REAL`);
}
if (!columnExists("salons", "longitude")) {
  db.exec(`ALTER TABLE salons ADD COLUMN longitude REAL`);
}

// --- Migration: optional reason a customer gives when cancelling a booking ---
if (!columnExists("booking_events", "reason")) {
  db.exec(`ALTER TABLE booking_events ADD COLUMN reason TEXT`);
}

// --- Migration: optional daily break window (e.g. lunch), per day of week ---
if (!columnExists("salon_hours", "breakStart")) {
  db.exec(`ALTER TABLE salon_hours ADD COLUMN breakStart TEXT`);
}
if (!columnExists("salon_hours", "breakEnd")) {
  db.exec(`ALTER TABLE salon_hours ADD COLUMN breakEnd TEXT`);
}

// --- Migration: in-app support tickets ("Report an Issue") ---
db.exec(`
  CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    userName TEXT NOT NULL,
    userPhone TEXT,
    userRole TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    createdAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id)
  );
`);

module.exports = db;