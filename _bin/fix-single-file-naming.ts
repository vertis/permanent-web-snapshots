/**
 * Fix SingleFile snapshot filenames retrospectively.
 *
 * New name:  https__host_path_-YYYY-MM-DDTHH_MM_SS_mmmZ.html
 * Source URL priority: canonical > og:url > twitter:url > <!-- saved from url=... -->
 *
 * Usage:
 *   bun _bin/fix-single-file-naming.ts ./snapshots             # dry-run
 *   bun _bin/fix-single-file-naming.ts ./snapshots --apply     # rename for real
 *   bun _bin/fix-single-file-naming.ts ./snapshots --quiet
 *
 * Notes:
 * - Recurses directories.
 * - Handles collisions by appending -2, -3, ...
 * - Keeps original extension (.html, .zip.html, .u.zip.html, .zip).
 */

import { promises as fs } from "fs";
import * as path from "path";

type Flags = {
  apply: boolean;
  quiet: boolean;
  preferCanonical: boolean;
};

const INVALID_FILENAME_CHARS = /[~+\\?%*\:|"<>\x00-\x1F/]/g; // we never put '/' into names anyway
const FULLWIDTH_TO_ASCII: Record<string, string> = {
  "～": "~",
  "＋": "+",
  "？": "?",
  "％": "%",
  "＊": "*",
  "：": ":", // often appears in old names; we map to ':' then later to '_'
  "｜": "|",
  "＂": '"',
  "＜": "<",
  "＞": ">",
  "＼": "\\",
  "／": "/",
};

const HTML_EXT_RE = /\.(?:u\.zip\.html|zip\.html|html|zip)$/i;
const DATETIME_IN_NAME_RE =
  /-(\d{4}-\d{2}-\d{2}T[\d：_]{2}[\d：_]{1}[\d：_]{2}[\d：_]{1}[\d：_]{2}(?:[._]\d{3})?Z)(?:\.[^.]+)?$/;

async function main() {
  const { dir, flags } = parseArgs(process.argv.slice(2));
  if (!dir) {
    console.error(
      "Usage: ts-node fix-singlefile-names.ts <directory> [--apply] [--quiet]"
    );
    process.exit(1);
  }
  const abs = path.resolve(dir);
  await processDir(abs, flags);
}

function parseArgs(args: string[]) {
  let dir = "";
  const flags: Flags = { apply: false, quiet: false, preferCanonical: true };
  for (const a of args) {
    if (a === "--apply") flags.apply = true;
    else if (a === "--quiet") flags.quiet = true;
    else if (a === "--no-canonical") flags.preferCanonical = false;
    else if (!dir) dir = a;
  }
  return { dir, flags };
}

async function processDir(root: string, flags: Flags) {
  for await (const file of walk(root)) {
    if (!HTML_EXT_RE.test(file)) continue;
    try {
      await maybeFixFile(file, flags);
    } catch (err: any) {
      if (!flags.quiet) console.error(`ERR  ${file}: ${err?.message || err}`);
    }
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

async function maybeFixFile(filepath: string, flags: Flags) {
  const originalBase = path.basename(filepath);
  const originalDir = path.dirname(filepath);

  const html = await fs.readFile(filepath, "utf8");

  // 1) Pick the best URL
  const urlStr = extractBestUrl(html, flags.preferCanonical);
  // If we truly can't find any, lightly normalize the existing base name and bail.
  if (!urlStr) {
    const normalized = normalizeWeirdPunctToAscii(originalBase);
    if (normalized !== originalBase) {
      const newPath = await dedupeAndMaybeRename(
        originalDir,
        originalBase,
        normalized,
        flags
      );
      if (!flags.quiet)
        logChange(filepath, path.join(originalDir, newPath), flags.apply);
    }
    return;
  }

  // 2) Flatten URL to desired base
  const flatUrlBase = flattenUrl(urlStr);

  // 3) Carry over or synthesize the datetime suffix
  const dtSuffix = extractOrMakeDatetimeSuffix(originalBase, filepath);

  // 4) Preserve the original extension (including zip.html / u.zip.html)
  const extMatch = originalBase.match(HTML_EXT_RE);
  const ext = extMatch ? extMatch[0] : ".html";

  // 5) New base name
  const newBase = sanitizeFilename(`${flatUrlBase}-${dtSuffix}${ext}`);

  if (newBase === originalBase) return;

  const finalName = await dedupeAndMaybeRename(
    originalDir,
    originalBase,
    newBase,
    flags
  );
  if (!flags.quiet)
    logChange(filepath, path.join(originalDir, finalName), flags.apply);
}

function extractBestUrl(html: string, preferCanonical: boolean): string | null {
  // try canonical
  const canonical = findCanonical(html);
  const og = findMetaUrl(html, /property=["']og:url["']/i);
  const tw = findMetaUrl(html, /name=["']twitter:url["']/i);
  const savedFrom = findSavedFromUrl(html);
  const candidates = preferCanonical
    ? [canonical, og, tw, savedFrom]
    : [og, tw, canonical, savedFrom];

  for (const c of candidates) {
    const cleaned = c && absolutizeAndValidateUrl(c);
    if (cleaned) return cleaned;
  }
  return null;
}

function findCanonical(html: string): string | null {
  // Generic <link ... rel="canonical" ... href="...">
  const re =
    /<link[^>]*\brel=["'][^"']*\bcanonical\b[^"']*["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i;
  const m = html.match(re);
  return m?.[1] || null;
}

function findMetaUrl(html: string, attrRe: RegExp): string | null {
  // <meta property="og:url" content="..."> | <meta name="twitter:url" content="...">
  const re = new RegExp(
    `<meta[^>]*(?:${attrRe.source})[^>]*\\bcontent=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const m = html.match(re);
  return m?.[1] || null;
}

function findSavedFromUrl(html: string): string | null {
  // <!-- saved from url=(...)http(s)://... -->
  const re = /saved from url=\([^)]*\)\s*(https?:\/\/[^\s"'<>]+)/i;
  const m = html.match(re);
  return m?.[1] || null;
}

function absolutizeAndValidateUrl(input: string): string | null {
  try {
    // Normalize full-width garbage before parsing
    input = normalizeWeirdPunctToAscii(input).trim();
    // strip surrounding quotes if any
    input = input.replace(/^['"]|['"]$/g, "");
    // ignore mailto:, medium:// etc.
    if (!/^https?:\/\//i.test(input)) return null;
    const u = new URL(input);
    // discard query/hash to keep names stable
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

function flattenUrl(urlStr: string): string {
  const u = new URL(urlStr);
  const protocol = u.protocol.replace(":", ""); // https
  const host = u.hostname.toLowerCase(); // ignore port in filenames for stability
  let pathname = u.pathname || "/";
  // Keep trailing slash significance: turn '/' into '', but preserve trailing slash with '_'
  const endedWithSlash = pathname.endsWith("/") && pathname !== "/";
  pathname = pathname.replace(/^\//, "").replace(/\//g, "_");
  if (endedWithSlash) pathname += "_";

  const base = `${protocol}__${host}${pathname ? "_" + pathname : ""}`;
  return base;
}

function extractOrMakeDatetimeSuffix(
  originalBase: string,
  filepath: string
): string {
  const m = originalBase.match(DATETIME_IN_NAME_RE);
  if (m?.[1]) {
    // normalize full-width punctuation & convert ':' and '.' to '_'
    return normalizeDatetimeForName(m[1]);
  }
  // fallback to file mtime
  return toDatetimeIsoForName(new Date());
}

function normalizeDatetimeForName(dt: string): string {
  dt = normalizeWeirdPunctToAscii(dt);
  // 2025-09-07T14:50:55.735Z  ->  2025-09-07T14_50_55_735Z
  return dt.replace(/:/g, "_").replace(/\./g, "_");
}

function toDatetimeIsoForName(d: Date): string {
  const iso = d.toISOString(); // 2025-09-07T14:50:55.735Z
  return iso.replace(/:/g, "_").replace(/\./g, "_");
}

function normalizeWeirdPunctToAscii(s: string): string {
  return s.replace(/[\uFF00-\uFFFF]/g, (ch) => FULLWIDTH_TO_ASCII[ch] ?? ch);
}

function sanitizeFilename(name: string): string {
  // First map full-width to ASCII, then replace invalids with '_'
  name = normalizeWeirdPunctToAscii(name);
  name = name.replace(INVALID_FILENAME_CHARS, "_");
  // collapse multiple underscores
  name = name.replace(/_{2,}/g, "_");
  // avoid leading/trailing underscores weirdness
  name = name
    .replace(/^_+/, "")
    .replace(/_+(\.(?:html|zip(?:\.html)?|u\.zip\.html))$/i, "_$1");
  return name;
}

async function dedupeAndMaybeRename(
  dir: string,
  oldBase: string,
  newBaseDesired: string,
  flags: Flags
): Promise<string> {
  let candidate = newBaseDesired;
  let n = 2;
  while (true) {
    const destPath = path.join(dir, candidate);
    if (candidate === oldBase) return candidate;
    const exists = await existsFile(destPath);
    if (!exists) {
      if (flags.apply) {
        await fs.rename(path.join(dir, oldBase), destPath);
      }
      return candidate;
    }
    const { name, ext } = splitNameExt(newBaseDesired);
    candidate = `${name}-${n}${ext}`;
    n++;
  }
}

function splitNameExt(base: string): { name: string; ext: string } {
  const m = base.match(HTML_EXT_RE);
  if (m) {
    const idx = base.lastIndexOf(m[0]);
    return { name: base.slice(0, idx), ext: m[0] };
  }
  const li = base.lastIndexOf(".");
  if (li === -1) return { name: base, ext: "" };
  return { name: base.slice(0, li), ext: base.slice(li) };
}

async function existsFile(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function logChange(fromPath: string, toPath: string, applied: boolean) {
  const from = path.basename(fromPath);
  const to = path.basename(toPath);
  const tag = applied ? "RENAME" : "DRYRUN";
  console.log(`${tag}  ${from}  ->  ${to}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
