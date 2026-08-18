const db = require("./db");

const MAX_IMAGES_PER_SALON = 6;

// Attaches an `images: {id, url}[]` array (ordered) to each salon in a
// batched query, avoiding N+1 lookups when listing salons.
function attachSalonImages(salons) {
  if (salons.length === 0) return salons;

  const salonIds = salons.map((s) => s.id);
  const placeholders = salonIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, salonId, imageUrl FROM salon_images
       WHERE salonId IN (${placeholders})
       ORDER BY position ASC, createdAt ASC`
    )
    .all(...salonIds);

  const imagesBySalon = {};
  rows.forEach((row) => {
    if (!imagesBySalon[row.salonId]) imagesBySalon[row.salonId] = [];
    imagesBySalon[row.salonId].push({ id: row.id, url: row.imageUrl });
  });

  return salons.map((salon) => ({
    ...salon,
    images: imagesBySalon[salon.id] || [],
  }));
}

module.exports = { attachSalonImages, MAX_IMAGES_PER_SALON };
