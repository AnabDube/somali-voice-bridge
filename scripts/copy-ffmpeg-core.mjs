// Copies the ffmpeg.wasm core (single-threaded ESM build) into public/ffmpeg so
// the app serves it from its own origin instead of a third-party CDN.
//
// The files are ~31 MB, so they are not committed (see .gitignore); this runs on
// `npm install` (postinstall) and before `dev` / `build`, so Vercel and local
// checkouts always have them.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "@ffmpeg", "core", "dist", "esm");
const target = join(root, "public", "ffmpeg");

if (!existsSync(source)) {
  console.warn("[copy-ffmpeg-core] @ffmpeg/core is not installed yet; skipping.");
  process.exit(0);
}

mkdirSync(target, { recursive: true });
for (const file of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  const from = join(source, file);
  const to = join(target, file);
  if (!existsSync(to) || statSync(to).size !== statSync(from).size) {
    copyFileSync(from, to);
    console.log(`[copy-ffmpeg-core] copied ${file}`);
  }
}
