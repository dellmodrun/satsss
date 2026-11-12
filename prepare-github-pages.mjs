import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const extensions = new Set([".html", ".js", ".css"]);

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (extensions.has(path.extname(entry.name))) files.push(target);
  }
  return files;
}

for (const file of await walk(root)) {
  let source = await fs.readFile(file, "utf8");
  source = source
    .replace(/<script[^>]+src="\/(?:~flock\.js|__l5e\/events\.[^"]+)"[^>]*><\/script>/g, "")
    .replace(/(["'`])\/(?!\/|satsss\/)/g, "$1/satsss/")
    .replace(/url\(\/(?!\/|satsss\/)/g, "url(/satsss/");
  await fs.writeFile(file, source);
}

await fs.writeFile(path.join(root, ".nojekyll"), "");
console.log("Prepared static paths for /satsss/ GitHub Pages.");
