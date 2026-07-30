const db = require("./db");

const MAX_IMAGES_PER_SERVICE = 3;

// Attaches an `images: {id, url}[]` array (ordered) to each service in a
// batched query, avoiding N+1 lookups when listing a salon's services.
function attachImages(services) {
  if (services.length === 0) return services;

  const serviceIds = services.map((s) => s.id);
  const placeholders = serviceIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, serviceId, imageUrl FROM service_images
       WHERE serviceId IN (${placeholders})
       ORDER BY position ASC, createdAt ASC`
    )
    .all(...serviceIds);

  const imagesByService = {};
  rows.forEach((row) => {
    if (!imagesByService[row.serviceId]) imagesByService[row.serviceId] = [];
    imagesByService[row.serviceId].push({ id: row.id, url: row.imageUrl });
  });

  return services.map((service) => ({
    ...service,
    images: imagesByService[service.id] || [],
  }));
}

module.exports = { attachImages, MAX_IMAGES_PER_SERVICE };
