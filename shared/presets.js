// Atelier Instruments — MIT License
// JSON preset parse, serialize, and browser storage.

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * @param {string} text
 * @returns {{ name: string, size: number, mood: number, species: number, roughness: number }}
 */
export function parsePreset(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Preset is not valid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Preset must be a JSON object");
  }
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Untitled";
  return {
    name,
    size: clamp01(data.size, 0.5),
    mood: clamp01(data.mood, 0),
    species: clamp01(data.species, 0),
    roughness: clamp01(data.roughness, 0.3),
  };
}

export function serializePreset(preset) {
  const parsed = parsePreset(JSON.stringify(preset ?? {}));
  return JSON.stringify(parsed, null, 2);
}

/**
 * Parse a preset document without forcing one instrument's fields.
 * parsePreset stays shaped for the creature desk.
 * @param {string} text
 */
export function parseLoosePreset(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Preset is not valid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Preset must be a JSON object");
  }
  if (data.performance != null && !Array.isArray(data.performance)) {
    throw new Error("performance must be an array");
  }
  return data;
}

export function serializeLoosePreset(preset) {
  const data = parseLoosePreset(JSON.stringify(preset ?? {}));
  return JSON.stringify(data, null, 2);
}

export function presetFilename(name) {
  const slug = String(name || "preset")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "preset"}.json`;
}

export function downloadJson(preset) {
  if (typeof document === "undefined") return;
  const parsed = JSON.parse(serializePreset(preset));
  const blob = new Blob([serializePreset(parsed)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = presetFilename(parsed.name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function storage() {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function loadStoredPresets(key) {
  const bin = storage();
  if (!bin) return [];
  const raw = bin.getItem(key);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map((entry) => parsePreset(JSON.stringify(entry)));
  } catch {
    return [];
  }
}

export function storePresets(key, presets) {
  const bin = storage();
  if (!bin) return;
  const clean = presets.map((entry) => JSON.parse(serializePreset(entry)));
  bin.setItem(key, JSON.stringify(clean));
}

/** Arbitrary JSON documents. Does not run them through the scalar preset schema. */
export function loadLibrary(key) {
  const bin = storage();
  if (!bin) return [];
  try {
    const data = JSON.parse(bin.getItem(key) || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveLibrary(key, items) {
  const bin = storage();
  if (!bin) return;
  bin.setItem(key, JSON.stringify(Array.isArray(items) ? items : []));
}

export function downloadDocument(data, filename) {
  if (typeof document === "undefined") return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".json") ? filename : `${filename}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** JSON object that is not run through an instrument-specific schema. */
export function readJsonObject(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Preset is not valid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Preset must be a JSON object");
  }
  return data;
}

export function loadJson(key, fallback) {
  const bin = storage();
  if (!bin) return fallback;
  const raw = bin.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function storeJson(key, value) {
  const bin = storage();
  if (!bin) return;
  bin.setItem(key, JSON.stringify(value));
}

export function downloadTextFile(filename, text, mime = "application/json") {
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function pickTextFile(accept = ".json,application/json") {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("No document"));
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) {
        reject(new Error("No file chosen"));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("Could not read file"));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(file);
    });
    input.click();
  });
}
