const db = require("./db");

const MAX_IMAGES_PER_PROFESSIONAL = 3;

// Attaches an `images: {id, url}[]` array (ordered) to each professional in a
// batched query, avoiding N+1 lookups when listing a salon's professionals.
function attachProfessionalImages(professionals) {
  if (professionals.length === 0) return professionals;

  const professionalIds = professionals.map((p) => p.id);
  const placeholders = professionalIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, professionalId, imageUrl FROM professional_images
       WHERE professionalId IN (${placeholders})
       ORDER BY position ASC, createdAt ASC`
    )
    .all(...professionalIds);

  const imagesByProfessional = {};
  rows.forEach((row) => {
    if (!imagesByProfessional[row.professionalId]) imagesByProfessional[row.professionalId] = [];
    imagesByProfessional[row.professionalId].push({ id: row.id, url: row.imageUrl });
  });

  return professionals.map((professional) => ({
    ...professional,
    images: imagesByProfessional[professional.id] || [],
  }));
}

module.exports = { attachProfessionalImages, MAX_IMAGES_PER_PROFESSIONAL };
