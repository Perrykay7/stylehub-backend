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

module.exports = db;