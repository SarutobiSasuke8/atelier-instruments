// Run node:test on every app test file. Exits 0 when the workshop has no apps yet.
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = path.join(root, "apps");
const files = [];

if (existsSync(appsDir)) {
  for (const app of readdirSync(appsDir, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const testDir = path.join(appsDir, app.name, "test");
    if (!existsSync(testDir)) continue;
    for (const entry of readdirSync(testDir)) {
      if (entry.endsWith(".test.js")) files.push(path.join(testDir, entry));
    }
  }
}

if (files.length === 0) {
  console.log("No app tests found.");
  process.exit(0);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  cwd: root,
});
process.exit(result.status ?? 1);
