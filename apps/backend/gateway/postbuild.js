import fs from "node:fs";
import path from "node:path";

const dirs = ["routes", "src", "middleware"];
for (const d of dirs) {
  const s = path.join("dist", "gateway", d);
  const t = path.join("dist", d);
  if (fs.existsSync(s) && !fs.existsSync(t)) {
    try {
      fs.cpSync(s, t, { recursive: true });
    } catch (e) {
      console.warn(`Failed to copy ${s} to ${t}:`, e);
    }
  }
}
