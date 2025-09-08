#!/usr/bin/env bun
/**
 * Inline-compress SingleFile snapshots to stay under Cloudflare Pages 25 MiB/file limit.
 * - Keeps images INLINE as data URLs (no external files)
 * - Re-encodes raster images to WebP and caps width
 * - Works for <img>, CSS url(), or anywhere data:image;base64 appears
 *
 * Usage: bun _bin/fix-snapshots.ts <path/to/snapshot.html> [--maxWidth=1600] [--quality=70]
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

let sharpMod: any | null = null;
async function ensureSharp() {
  if (sharpMod !== null) return sharpMod;
  try {
    const m: any = await import("sharp");
    sharpMod = m?.default ?? m;
  } catch (e) {
    throw new Error("sharp is required. Install with: bun add sharp");
  }
  return sharpMod;
}

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
const TARGET = args.get("--targetBytes") ? Number(args.get("--targetBytes")) : undefined; // e.g. 25165824 for 24 MiB
const STRIP_FONTS = args.has("--strip-fonts");
const STRIP_SCRIPTS = args.has("--strip-scripts");
const STRIP_STRIPE = args.has("--strip-stripe");
const STRIP_LARGE_STYLES = args.has("--strip-large-styles");
const STYLE_THRESHOLD = args.get("--styleThreshold") ? Number(args.get("--styleThreshold")) : 200_000; // 200 KB
const EXTRACT_IMAGES = args.has("--extract-images");
const GIF_WEBP = args.has("--gif-webp");

const ASSET_ROOT = "assets/snapshots";

// Generic matcher for inline image data URLs across attributes and CSS
// Allow optional parameters before ;base64 (e.g., name=, charset=) and whitespace in payload
const dataImageRe = /data:(image\/[A-Za-z0-9+.\-]+)(?:;[^,]*)?;\s*base64\s*,([A-Za-z0-9+/=\s]+)/gi;

async function main() {
  if (positional.length !== 1) {
    console.error("Usage: bun _bin/fix-snapshots.ts <path/to/snapshot.html> [--maxWidth=1600] [--quality=70]");
    process.exit(2);
  }

  const fullPath = positional[0];
  const st = await stat(fullPath);
  const beforeBytes = st.size;
  const file = basename(fullPath);

  let original = await readFile(fullPath, "utf8");
  // Optional pre-strips for big offenders
  if (STRIP_FONTS) {
    const before = Buffer.byteLength(original, "utf8");
    original = stripEmbeddedFonts(original);
    const after = Buffer.byteLength(original, "utf8");
    console.log(`[strip] fonts: ${fmtBytes(before)} -> ${fmtBytes(after)} (${fmtDelta(before - after)})`);
  }
  if (STRIP_STRIPE) {
    const before = Buffer.byteLength(original, "utf8");
    original = stripStripeIframes(original);
    const after = Buffer.byteLength(original, "utf8");
    console.log(`[strip] stripe iframes: ${fmtBytes(before)} -> ${fmtBytes(after)} (${fmtDelta(before - after)})`);
  }
  if (STRIP_SCRIPTS) {
    const before = Buffer.byteLength(original, "utf8");
    original = stripScripts(original);
    const after = Buffer.byteLength(original, "utf8");
    console.log(`[strip] scripts: ${fmtBytes(before)} -> ${fmtBytes(after)} (${fmtDelta(before - after)})`);
  }
  if (STRIP_LARGE_STYLES) {
    const before = Buffer.byteLength(original, "utf8");
    original = stripLargeStyleBlocks(original, STYLE_THRESHOLD);
    const after = Buffer.byteLength(original, "utf8");
    console.log(`[strip] large <style> blocks (>${STYLE_THRESHOLD} B): ${fmtBytes(before)} -> ${fmtBytes(after)} (${fmtDelta(before - after)})`);
  }
  // Quick diagnostics: show a few data:image occurrences with nearby text
  debugSampleDataImages(original);
  let current = original;
  let pass = 0;
  let q = QUALITY;
  let w = MAX_WIDTH;
  const targetBytes = TARGET ?? beforeBytes; // if no target provided, do one pass
  let lastReplacements = 0;

  if (EXTRACT_IMAGES) {
    const file = basename(fullPath);
    const slug = file.replace(/\.html$/, "");
    const { html: next, extracted } = await extractImagesToAssets(current, slug, QUALITY, MAX_WIDTH);
    current = next;
    console.log(`[extract] images written: ${extracted}`);
  } else while (true) {
    pass++;
    const before = Buffer.byteLength(current, "utf8");
    const { html: next, replacements } = await compressInlineOnce(current, q, w);
    lastReplacements = replacements;
    const after = Buffer.byteLength(next, "utf8");
    const delta = before - after;
    console.log(`pass ${pass}: q=${q} w=${w} matches=${replacements} ${fmtBytes(before)} -> ${fmtBytes(after)} (${fmtDelta(delta)})`);
    current = next;
    if (after <= targetBytes) break;
    if (delta <= 0 || replacements === 0) break;
    if (q > 40) {
      q = Math.max(40, q - 10);
    } else if (w > 1000) {
      w = Math.max(1000, w - 200);
    } else {
      break;
    }
  }

  await writeFile(fullPath, current, "utf8");
  const after = await stat(fullPath);
  const delta = beforeBytes - after.size;
  console.log(`Processed ${fullPath} (last pass replacements: ${lastReplacements}): ${fmtBytes(beforeBytes)} -> ${fmtBytes(after.size)} (${fmtDelta(delta)})`);
}

async function compressInlineOnce(html: string, quality: number, maxWidth: number): Promise<{ html: string; replacements: number }>{
  const sharp = await ensureSharp();
  const cache: Record<string, string> = {};
  let out: string[] = [];
  let i = 0;
  let replaced = 0;

  const lower = html.toLowerCase();
  while (true) {
    const start = lower.indexOf("data:image", i);
    if (start === -1) break;
    out.push(html.slice(i, start));

    // mime: from after 'data:' to next ';'
    const mimeStart = start + 5; // position at 'image'
    const semi = html.indexOf(";", mimeStart);
    if (semi === -1) {
      out.push(html.slice(start));
      i = html.length;
      break;
    }
    const mime = html.slice(start + 5, semi); // 'image/xxx'

    // find comma after 'base64'
    const base64Idx = lower.indexOf("base64", semi + 1);
    if (base64Idx === -1) {
      out.push(html.slice(start, semi + 1));
      i = semi + 1;
      continue;
    }
    const comma = html.indexOf(",", base64Idx);
    if (comma === -1) {
      out.push(html.slice(start));
      i = html.length;
      break;
    }
    const dataStart = comma + 1;
    // consume base64 chars
    let k = dataStart;
    while (k < html.length) {
      const c = html[k];
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '+' || c === '/' || c === '=' || c === '\\n' || c === '\\r' || c === '\\t' || c === ' ') {
        k++;
      } else {
        break;
      }
    }
    const b64raw = html.slice(dataStart, k).replace(/\s+/g, "");
    try {
      const lowerMime = mime.toLowerCase();
      if (lowerMime.startsWith("image/svg")) {
        out.push(html.slice(start, k));
      } else if (lowerMime === "image/gif") {
        const input = Buffer.from(b64raw, "base64");
        const sha = createHash("sha1").update(input).digest("hex").slice(0, 16);
        if (GIF_WEBP) {
          // Convert animated GIF -> animated WebP inline
          let webpB64 = cache[sha];
          if (!webpB64) {
            const webp = await sharp(input, { animated: true, failOn: 'none' })
              .resize({ width: maxWidth, withoutEnlargement: true })
              .webp({ quality })
              .toBuffer();
            webpB64 = webp.toString("base64");
            cache[sha] = webpB64;
          }
          out.push(`data:image/webp;base64,${webpB64}`);
          replaced++;
        } else {
          // Try to reoptimise GIF without format change
          try {
            let gifB64 = cache[sha];
            if (!gifB64) {
              const optim = await sharp(input, { animated: true, failOn: 'none' })
                .gif({ reoptimise: true })
                .toBuffer();
              gifB64 = optim.toString("base64");
              cache[sha] = gifB64;
            }
            out.push(`data:image/gif;base64,${gifB64}`);
            replaced++;
          } catch {
            out.push(html.slice(start, k));
          }
        }
      } else {
        if (replaced < 3) {
          console.log(`[debug] compress candidate @${start} mime=${mime} b64_len=${b64raw.length}`);
        }
        const input = Buffer.from(b64raw, "base64");
        const sha = createHash("sha1").update(input).digest("hex").slice(0, 16);
        let webpB64 = cache[sha];
        if (!webpB64) {
          const webp = await sharp(input, { failOn: 'none' })
            .resize({ width: maxWidth, withoutEnlargement: true })
            .webp({ quality })
            .toBuffer();
          webpB64 = webp.toString("base64");
          cache[sha] = webpB64;
        }
        out.push(`data:image/webp;base64,${webpB64}`);
        replaced++;
      }
    } catch (e) {
      console.log(`[debug] compression failed @${start} mime=${mime}: ${(e as Error).message}`);
      out.push(html.slice(start, k));
    }
    i = k;
  }
  out.push(html.slice(i));
  return { html: out.join(""), replacements: replaced };
}

async function extractImagesToAssets(
  html: string,
  slug: string,
  quality: number,
  maxWidth: number
): Promise<{ html: string; extracted: number }> {
  const sharp = await ensureSharp();
  const cache: Record<string, string> = {}; // sha -> path
  let extracted = 0;
  const assetDir = join(ASSET_ROOT, slug);
  await Bun.$`mkdir -p ${assetDir}`.quiet();

  const out = await replaceAsync(html, dataImageRe, async (m, mime: string, b64: string) => {
    try {
      const buf = Buffer.from(b64.replace(/\s+/g, ""), "base64");
      const sha = createHash("sha1").update(buf).digest("hex").slice(0, 16);
      if (cache[sha]) return `/${cache[sha]}`;

      let outBuf: Buffer = buf;
      let ext = extFromMime(mime);
      const lowerMime = mime.toLowerCase();
      if (lowerMime.startsWith("image/svg")) {
        // keep as-is
      } else if (lowerMime === "image/gif") {
        if (GIF_WEBP) {
          try {
            const webp = await sharp(buf, { animated: true, failOn: 'none' })
              .resize({ width: maxWidth, withoutEnlargement: true })
              .webp({ quality })
              .toBuffer();
            outBuf = webp;
            ext = ".webp";
          } catch {}
        } else {
          try {
            const optim = await sharp(buf, { animated: true, failOn: 'none' })
              .gif({ reoptimise: true })
              .toBuffer();
            outBuf = optim;
            ext = ".gif";
          } catch {}
        }
      } else {
        try {
          const webp = await sharp(buf, { failOn: 'none' })
            .resize({ width: maxWidth, withoutEnlargement: true })
            .webp({ quality })
            .toBuffer();
          outBuf = webp;
          ext = ".webp";
        } catch {}
      }
      const baseName = `img-${String(extracted).padStart(4, "0")}-${sha}${ext}`;
      const diskPath = join(assetDir, baseName);
      await Bun.write(diskPath, outBuf);
      const relPath = join(ASSET_ROOT, slug, baseName).replaceAll('\\\\','/');
      cache[sha] = relPath;
      extracted++;
      return `/${relPath}`;
    } catch {
      return m;
    }
  });
  return { html: out, extracted };
}

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("svg")) return ".svg";
  if (m.includes("gif")) return ".gif";
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  return "";
}

async function replaceAsync(
  str: string,
  regex: RegExp,
  asyncFn: (match: string, ...args: any[]) => Promise<string>
): Promise<string> {
  const matches: { start: number; end: number; text: string; groups: any[] }[] = [];
  let m: RegExpExecArray | null;
  const global = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  while ((m = global.exec(str))) {
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
  process.exit(1);
});

function debugSampleDataImages(s: string) {
  const simple = /data:image/gi;
  let m: RegExpExecArray | null;
  let shown = 0;
  while ((m = simple.exec(s)) && shown < 3) {
    const start = Math.max(0, m.index - 40);
    const end = Math.min(s.length, m.index + 140);
    const snippet = s.slice(start, end).replace(/\n/g, "\\n");
    console.log(`[debug] data:image at ${m.index}: ...${snippet}...`);
    // Try to match our full pattern against a larger window from this point
    const testSlice = s.slice(m.index, Math.min(s.length, m.index + 500));
    const tester = new RegExp(dataImageRe.source, dataImageRe.flags);
    const mm = tester.exec(testSlice);
    if (mm) {
      console.log(`[debug] pattern matched mime='${mm[1]}' b64_prefix='${mm[2].slice(0,16)}'`);
    } else {
      console.log(`[debug] pattern did NOT match within first 500 chars after occurrence`);
    }
    shown++;
  }
  if (shown === 0) {
    console.log("[debug] No 'data:image' substrings found. If images are very large, they may be referenced as files, not data URLs.");
  }
}

// Remove @font-face blocks that embed data: fonts and any url(data:application/*font*)
function stripEmbeddedFonts(s: string): string {
  // Remove entire @font-face {...} blocks that contain data:
  s = s.replace(/@font-face\s*\{[^}]*\}/gsi, (block) => {
    return /data:\s*application\/font|data:\s*font\//i.test(block) ? "" : block;
  });
  // Also remove any url(data:application/font-...)
  s = s.replace(/url\(\s*data:[^)]+\)/gsi, (m) => (/font|woff|otf|ttf/i.test(m) ? "" : m));
  return s;
}

// Remove Stripe metrics iframes and similar trackers by name/src/srcdoc
function stripStripeIframes(s: string): string {
  // Simple heuristic: drop any iframe whose name starts with __privateStripeMetricsController
  s = s.replace(/<iframe\b[^>]*name=["']__privateStripeMetricsController[^>]*>[\s\S]*?<\/iframe>/gi, "");
  // Drop any iframe with src or srcdoc referencing stripe.com
  s = s.replace(/<iframe\b[^>]*?(?:src|srcdoc)=["'][^"']*stripe\.com[^>]*>[\s\S]*?<\/iframe>/gi, "");
  return s;
}

// Remove all <script>...</script> blocks
function stripScripts(s: string): string {
  return s.replace(/<script\b[\s\S]*?<\/script>/gi, "");
}

function stripLargeStyleBlocks(s: string, threshold: number): string {
  return s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (block) => {
    return block.length > threshold ? "" : block;
  });
}
