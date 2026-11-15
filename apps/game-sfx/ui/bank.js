// Atelier Instruments — MIT License
// JSON banks for game-sfx. Separate from the creature-voice preset map in shared/.

function normalizeItem(item) {
  if (!item || typeof item !== "object") throw new Error("Bad preset");
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (!name) throw new Error("Preset needs a name");
  if (typeof item.category !== "string" || !item.category.trim()) {
    throw new Error("Preset needs a category");
  }
  const seed = Number(item.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error("Preset seed must be an integer");
  }
  const params = {};
  if (item.params && typeof item.params === "object") {
    for (const [key, value] of Object.entries(item.params)) {
      if (!/^[a-z][a-z0-9-]{0,24}$/.test(key)) continue;
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`Bad param ${key}`);
      params[key] = n;
    }
  }
  return { name, category: item.category.trim(), seed, params };
}

export function parseBank(input) {
  let data = input;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error("Preset is not valid JSON");
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Preset bank must be an object");
  }
  if (!Array.isArray(data.items)) {
    if (typeof data.category === "string") {
      const item = normalizeItem(data);
      return { version: 1, name: item.name, items: [item] };
    }
    throw new Error("Preset bank needs items");
  }
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Untitled";
  return { version: 1, name, items: data.items.map(normalizeItem) };
}

export function serializeBank(bank) {
  return JSON.stringify(parseBank(bank), null, 2);
}
