const fs = require("fs");
const path = require("path");

const sourceDir = path.resolve(__dirname, "..", "main.js");
const buildDir = path.resolve(__dirname, "..");
const targetDir = path.resolve(__dirname, "..", "..", "tps-calendar-weekly-bases");

if (!fs.existsSync(targetDir)) {
  throw new Error(`Target directory not found: ${targetDir}`);
}

const assets = ["main.js", "styles.css", "manifest.json"];
for (const asset of assets) {
  const source = path.join(buildDir, asset);
  const destination = path.join(targetDir, asset);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing build asset: ${source}`);
  }
  fs.copyFileSync(source, destination);
}
console.log("Deployed weekly build to", targetDir);
