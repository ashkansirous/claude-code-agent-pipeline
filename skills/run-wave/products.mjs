// The product names a plan's headings may use, shared by count-unverified.mjs and remaining-slices.mjs.
// Each product has a long name (the store name) and a short one; either may head a section.
export const PRODUCT_NAMES = {
  'Read The Stupid Text': ['Read The Stupid Text', 'RTST'],
  'Dino Reader': ['Dino Reader', 'Dino'],
  'Shared': ['Shared'],
};

const ALL_NAMES = Object.values(PRODUCT_NAMES).flat();
const LOOKUP = new Map(
  Object.entries(PRODUCT_NAMES).flatMap(([long, names]) => names.map((n) => [n.toLowerCase(), long])),
);

// The long product name for a heading text ("RTST" gives "Read The Stupid Text"), or null when it is no product.
export function canonicalProduct(text) {
  return LOOKUP.get(String(text).trim().toLowerCase()) ?? null;
}

// A regex source matching any known product name, longest first so "Dino Reader" wins over "Dino".
export const PRODUCT_PATTERN = ALL_NAMES
  .sort((a, b) => b.length - a.length)
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
