// catalog.js — runtime Product → BPR Category map, managed by the admin "Products" section.
// It is seeded from the `products` table on boot (and refreshed when products change), so that
// admin-added products categorize correctly. compute.js consults this BEFORE its built-in
// mapping, falling back to the built-in logic when a product isn't in the table. Kept dependency
// -free on purpose (compute.js imports it; introducing other imports here risks a cycle).
let categoryByProduct = new Map();

export function setCatalog(pairs) {
  categoryByProduct = new Map(
    (pairs || [])
      .filter(([name]) => String(name || '').trim())
      .map(([name, cat]) => [String(name).trim().toLowerCase(), String(cat || '').trim()]));
}

export function categoryFor(name) {
  return categoryByProduct.get(String(name || '').trim().toLowerCase()) || '';
}
