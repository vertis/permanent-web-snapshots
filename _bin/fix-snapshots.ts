#!/usr/bin/env bun
/**
 * Normalize SingleFile snapshots to stay under Cloudflare Pages 25 MiB per-file limit.
 * - Extracts embedded data URL images to files under /assets/snapshots/<slug>/
 * - Rewrites <img src="data:..."> to file URLs
 * - Re-encodes raster images to WebP (quality=70) and caps width at 1600px
 * - Leaves GIFs as .gif (to preserve animation) and SVGs as .svg
 *
 * Usage: bun _bin/fix-snapshots.ts [--all] [--threshold 20000000]
 *  - By default, only processes HTML files > 20 MiB (20,000,000 bytes)
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, extname, basename } from "node:path";
let sharpMod: any | null = null;
async function ensureSharp() {
  if (sharpMod !== null) return sharpMod;
  try {
    // Bun sometimes exposes CJS/ESM differently
    const m: any = await import("sharp");
    sharpMod = m?.default ?? m;
  } catch {
    sharpMod = undefined;
  }
  return sharpMod;
}

const ASSET_ROOT = "assets/snapshots";

const args = new Map<string, string | boolean>();
const positional: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.includes("=") ? a.split("=", 2) : [a, "true"];
    args.set(k, v === undefined ? true : v);
  } else {
    positional.push(a);
  }
}

const MAX_WIDTH = Number(args.get("--maxWidth") || 1600);
const QUALITY = Number(args.get("--quality") || 70);

const dataUrlRe = /src=(['"])data:(image\/[a-zA-Z+\-.]+);base64,([^"']+)\1/g;
const srcsetDataRe = /\s+srcset=("|')(?:[^\1]*data:[^\1]*)\1/g; // remove data: srcset attributes

async function main() {
  if (positional.length !== 1) {
    console.error("Usage: bun _bin/fix-snapshots.ts <path/to/snapshot.html> [--maxWidth=1600] [--quality=70]");
    process.exit(2);
  }

  const fullPath = positional[0];
  const st = await stat(fullPath);
  const beforeBytes = st.size;
  const file = basename(fullPath);
  const slug = file.replace(/\.html$/, "");
  const assetDir = join(ASSET_ROOT, slug);
  await mkdir(assetDir, { recursive: true });

  let html = await readFile(fullPath, "utf8");
  const saved: Record<string, string> = {}; // hash->relativePath

  // remove data: srcset attributes to avoid duplicates
  html = html.replace(srcsetDataRe, "");

  let idx = 0;
  html = await replaceAsync(html, dataUrlRe, async (m, quote, mime: string, b64: string) => {
    try {
      const buf = Buffer.from(b64, "base64");
      const sha = createHash("sha1").update(buf).digest("hex").slice(0, 12);
      if (saved[sha]) {
        return `src=${quote}${saved[sha]}${quote}`;
      }

      let outBuf: Buffer = buf;
      let outExt = extFromMime(mime);

      if (mime.startsWith("image/svg")) {
        // keep as-is
      } else if (mime === "image/gif") {
        // keep GIF to preserve animation
      } else {
        const sharp = await ensureSharp();
        if (sharp) {
          try {
            outBuf = await sharp(buf, { failOn: false })
              .resize({ width: MAX_WIDTH, withoutEnlargement: true })
              .webp({ quality: QUALITY })
              .toBuffer();
            outExt = ".webp";
          } catch (e) {
            // fallback: keep original
          }
        } // else: keep original
      }

      const baseName = `img-${String(idx++).padStart(4, "0")}-${sha}${outExt}`;
      const relPath = "/" + join(ASSET_ROOT, slug, baseName).replaceAll("\\", "/");
      const diskPath = join(assetDir, baseName);
      await writeFile(diskPath, outBuf);
      saved[sha] = relPath;
      return `src=${quote}${relPath}${quote}`;
    } catch (err) {
      // On any parse/convert error, leave the original data URL in place
      return m as string;
    }
  });

  await writeFile(fullPath, html, "utf8");
  const after = await stat(fullPath);
  const delta = beforeBytes - after.size;
  console.log(`Processed ${fullPath}: ${fmtBytes(beforeBytes)} -> ${fmtBytes(after.size)} (${fmtDelta(delta)})`);
}

function extFromMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/gif":
      return ".gif";
    default:
      return "";
  }
}

async function replaceAsync(
  str: string,
  regex: RegExp,
  asyncFn: (match: string, ...args: any[]) => Promise<string>
): Promise<string> {
  const matches: { start: number; end: number; text: string; groups: any[] }[] = [];
  let m: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((m = regex.exec(str))) {
    matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], groups: m.slice(1) });
  }
  if (matches.length === 0) return str;
  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of matches) {
    parts.push(str.slice(lastIndex, match.start));
    const repl = await asyncFn(match.text, ...match.groups);
    parts.push(repl);
    lastIndex = match.end;
  }
  parts.push(str.slice(lastIndex));
  return parts.join("");
}

function fmtBytes(n: number): string {
  const kb = 1024;
  const mb = kb * kb;
  if (n >= mb) return `${(n / mb).toFixed(2)} MiB`;
  if (n >= kb) return `${(n / kb).toFixed(2)} KiB`;
  return `${n} B`;
}

function fmtDelta(d: number): string {
  const sign = d >= 0 ? "-" : "+";
  return `${sign}${fmtBytes(Math.abs(d))}`;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
