#!/usr/bin/env node

/**
 * import-docx-to-json.cjs
 *
 * Converts edited DOCX chapters back into proofing JSON files.
 * Output folder:
 *
 *   output/finalized/<book>/00001.json
 *
 * JSON format:
 *
 * {
 *   "id": "...",
 *   "paragraphs": ["...", "..."]
 * }
 */

const fs = require("fs/promises");
const path = require("path");
const readline = require("readline");
const AdmZip = require("adm-zip");
const mammoth = require("mammoth");
const { XMLParser } = require("fast-xml-parser");
const chalk = require("chalk");

/* ============================================================
   Configuration
============================================================ */

const FINALIZED_ROOT = path.resolve(process.cwd(), "output", "finalized");
const PROOF_ROOT = path.resolve(process.cwd(), "output", "proofing");

// If false, empty Word paragraphs are ignored.
// If true, empty paragraphs are preserved as "" in the JSON.
const KEEP_EMPTY_PARAGRAPHS = false;

/* ============================================================
   Terminal helpers
============================================================ */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (query) => new Promise((resolve) => rl.question(query, resolve));

process.on("SIGINT", () => {
  console.log(chalk.red("\nCancelled."));
  rl.close();
  process.exit(130);
});

const log = {
  info: (msg) => console.log(chalk.cyan(msg)),
  success: (msg) => console.log(chalk.green(msg)),
  warn: (msg) => console.log(chalk.yellow(msg)),
  error: (msg) => console.error(chalk.red(msg)),
  dim: (msg) => console.log(chalk.dim(msg)),
  step: (msg) => console.log(chalk.magenta(msg)),
};

async function confirm(message, defaultValue = false) {
  const suffix = defaultValue ? " (Y/n) " : " (y/N) ";

  while (true) {
    const answer = (await ask(chalk.green(message + suffix))).trim().toLowerCase();

    if (!answer) return defaultValue;

    if (["y", "yes", "آره", "آری", "بله", "بلی"].includes(answer)) return true;
    if (["n", "no", "نه", "خیر"].includes(answer)) return false;

    log.warn("Please answer y or n.");
  }
}

/* ============================================================
   Utilities
============================================================ */

function normalizeDigits(value = "") {
  return String(value)
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

function normalizeSelectionText(value = "") {
  return normalizeDigits(value)
    .replace(/[،؛,;]/g, ",")
    .replace(/\.\.\./g, "-")
    .replace(/\.\./g, "-")
    .replace(/\bto\b/gi, "-")
    .replace(/تا/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const pad5 = (n) => String(n).padStart(5, "0");

function ensureArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function sanitizeFolderName(name = "") {
  return String(name)
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "") || "book";
}

function slugifyId(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "") || "book";
}

function paddedVariants(n) {
  const s = String(n);
  return [
    s,
    s.padStart(2, "0"),
    s.padStart(3, "0"),
    s.padStart(4, "0"),
    s.padStart(5, "0"),
    s.padStart(6, "0"),
  ];
}

function decodeXmlEntities(value = "") {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&amp;/g, "&");
}

async function directoryExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/* ============================================================
   File system walker
============================================================ */

async function walkFiles(dir, options = {}, depth = 0) {
  const extensions = options.extensions || [];
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 5;
  const ignore = options.ignore || [".git", "node_modules", ".DS_Store"];

  const results = [];

  if (depth > maxDepth) return results;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (
      entry.name.startsWith(".") ||
      entry.name.startsWith("~$") ||
      ignore.includes(entry.name)
    ) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const nested = await walkFiles(fullPath, options, depth + 1);
      results.push(...nested);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();

      if (!extensions.length || extensions.includes(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/* ============================================================
   Chapter number parsing from filenames
============================================================ */

function extractNumberFromFileName(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const normalized = normalizeDigits(base);

  const exact = normalized.match(/^(\d+)$/);
  if (exact) return Number(exact[1]);

  const allNumbers = [...normalized.matchAll(/\d+/g)].map((m) => Number(m[0]));
  if (!allNumbers.length) return null;

  // Usually the last number is the chapter number:
  // shepherd_wizard_00009.docx -> 9
  // book1_chapter_00010.docx -> 10
  return allNumbers[allNumbers.length - 1];
}

function docxCandidateScore(filePath, chapterNumber) {
  const base = path.basename(filePath, path.extname(filePath));
  const normalized = normalizeDigits(base).toLowerCase();

  let score = 0;

  const variants = paddedVariants(chapterNumber);

  if (variants.some((v) => normalized === v)) {
    score += 220;
  } else if (variants.some((v) => normalized.includes(v))) {
    score += 70;
  }

  if (/(?:chapter|ch|فصل|قسمت|بخش)/.test(normalized)) {
    score += 30;
  }

  if (/(copy|backup|old|tmp|temp|~)/.test(normalized)) {
    score -= 80;
  }

  const depth = filePath.split(path.sep).length;
  score -= Math.min(depth * 2, 20);

  return score;
}

/* ============================================================
   Chapter selection parsing
============================================================ */

function expandRange(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return [];

  if (end < start) [start, end] = [end, start];

  if (end - start > 20000) {
    throw new Error(`Range ${start}-${end} is too large.`);
  }

  const result = [];
  for (let i = start; i <= end; i++) {
    if (i > 0) result.push(i);
  }

  return result;
}

function parseChapterSelection(rawInput, availableNumbers) {
  const available = [...availableNumbers].sort((a, b) => a - b);
  const normalized = normalizeSelectionText(rawInput);

  if (!normalized) {
    throw new Error("No chapters entered.");
  }

  if (/^(all|\*|همه|تمام|کل|همه‌چیز)$/i.test(normalized)) {
    return available;
  }

  const min = available[0] ?? 1;
  const max = available[available.length - 1] ?? 0;

  const segments = normalized
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const selected = new Set();

  for (const originalSegment of segments) {
    const segment = originalSegment.trim();

    if (/^(all|\*|همه|تمام|کل)$/i.test(segment)) {
      return available;
    }

    const compact = segment.replace(/\s+/g, " ");

    const numbers = [...compact.matchAll(/\d+/g)].map((m) => Number(m[0]));

    if (!numbers.length) {
      log.warn(`Could not parse "${originalSegment}" as chapter number/range.`);
      continue;
    }

    const hasDash = compact.includes("-");

    if (hasDash && numbers.length >= 2) {
      expandRange(numbers[0], numbers[1]).forEach((n) => selected.add(n));
    } else if (hasDash && numbers.length === 1) {
      const n = numbers[0];

      if (/^-\s*\d+$/.test(compact)) {
        expandRange(min, n).forEach((x) => selected.add(x));
      } else if (/^\d+\s*-$/.test(compact)) {
        expandRange(n, max).forEach((x) => selected.add(x));
      } else {
        selected.add(n);
      }
    } else {
      selected.add(numbers[0]);
    }
  }

  const result = [...selected]
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);

  if (!result.length) {
    throw new Error("No valid chapters were parsed.");
  }

  return result;
}

/* ============================================================
   DOCX text extraction
   Primary: mammoth
   Fallback: direct word/document.xml parsing
============================================================ */

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
  cdataPropName: "__cdata",
});

const SKIP_SEARCH_KEYS = new Set([
  "pPr",
  "rPr",
  "sectPr",
  "del",
  "delText",
  "bookmarkStart",
  "bookmarkEnd",
  "proofErr",
  "lastRenderedPageBreak",
  "commentRangeStart",
  "commentRangeEnd",
  "commentReference",
  "footnoteReference",
  "endnoteReference",
  "footnote",
  "endnote",
  "comment",
  "comments",
]);

const SKIP_TEXT_KEYS = new Set([
  "pPr",
  "rPr",
  "sectPr",
  "del",
  "delText",
  "bookmarkStart",
  "bookmarkEnd",
  "proofErr",
  "lastRenderedPageBreak",
  "commentRangeStart",
  "commentRangeEnd",
  "commentReference",
  "footnoteReference",
  "endnoteReference",
]);

function cleanParagraphText(text = "") {
  return String(text)
    .replace(/\r/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function normalizeTextToParagraphs(text = "") {
  const lines = String(text || "")
    .replace(/\r/g, "\n")
    .replace(/ /g, " ")
    .split("\n");

  const result = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed) {
      result.push(trimmed);
    } else if (KEEP_EMPTY_PARAGRAPHS) {
      result.push("");
    }
  }

  return result;
}

async function extractParagraphsWithMammoth(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return normalizeTextToParagraphs(result.value || "");
  } catch (err) {
    log.dim(`Mammoth extraction failed for "${filePath}": ${err.message}`);
    return [];
  }
}

function countLeaf(value) {
  if (value == null) return 1;
  if (Array.isArray(value)) return value.length;
  return 1;
}

function findParagraphs(node, depth = 0) {
  if (!node || depth > 50) return [];

  if (Array.isArray(node)) {
    return node.flatMap((item) => findParagraphs(item, depth + 1));
  }

  if (typeof node !== "object") return [];

  const results = [];

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;

    if (key === "p") {
      results.push(...ensureArray(value));
    } else if (!SKIP_SEARCH_KEYS.has(key)) {
      results.push(...findParagraphs(value, depth + 1));
    }
  }

  return results;
}

function collectParagraphText(node, depth = 0) {
  if (node == null || depth > 50) return "";

  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((item) => collectParagraphText(item, depth + 1)).join("");
  }

  if (typeof node === "object") {
    let out = "";

    if (node["#text"] != null) {
      out += String(node["#text"]);
    }

    if (node["__cdata"] != null) {
      out += String(node["__cdata"]);
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "#text" || key === "__cdata") continue;
      if (key.startsWith("@_")) continue;
      if (SKIP_TEXT_KEYS.has(key)) continue;

      if (key === "tab") {
        out += "\t".repeat(countLeaf(value));
        continue;
      }

      if (key === "br" || key === "cr") {
        out += "\n".repeat(countLeaf(value));
        continue;
      }

      out += collectParagraphText(value, depth + 1);
    }

    return out;
  }

  return "";
}

function extractParagraphsWithXml(zip) {
  try {
    const entry = zip.getEntry("word/document.xml");
    if (!entry) return [];

    const xml = entry.getData().toString("utf8");
    const parsed = xmlParser.parse(xml);

    const rootNode = parsed.document || parsed;
    const searchRoot = rootNode.body || rootNode;

    const paragraphNodes = findParagraphs(searchRoot);

    const paragraphs = [];

    for (const pNode of paragraphNodes) {
      const rawText = collectParagraphText(pNode);
      const text = cleanParagraphText(rawText);

      const parts = normalizeTextToParagraphs(text);

      if (parts.length) {
        paragraphs.push(...parts);
      } else if (KEEP_EMPTY_PARAGRAPHS) {
        paragraphs.push("");
      }
    }

    return paragraphs;
  } catch (err) {
    log.dim(`XML fallback extraction failed: ${err.message}`);
    return [];
  }
}

/* ============================================================
   DOCX metadata id extraction
============================================================ */

function getSimpleText(node) {
  if (node == null) return "";

  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((item) => getSimpleText(item)).join(" ");
  }

  if (typeof node === "object") {
    const parts = [];

    if (node["#text"] != null) {
      parts.push(String(node["#text"]));
    }

    if (node["__cdata"] != null) {
      parts.push(String(node["__cdata"]));
    }

    return parts.join(" ");
  }

  return "";
}

function extractIdFromDocxMetadata(zip) {
  try {
    const entry = zip.getEntry("docProps/core.xml");
    if (!entry) return null;

    const xml = entry.getData().toString("utf8");

    try {
      const parsed = xmlParser.parse(xml);
      const descriptionNode =
        parsed?.coreProperties?.description ??
        parsed?.coreProperties?.["dc:description"] ??
        null;

      const description = getSimpleText(descriptionNode);

      const match = description.match(/Source id:\s*([^\s<>:"']+)/i);
      if (match) return match[1];
    } catch {
      // Fall back to regex below.
    }

    const match = xml.match(
      /<(?:dc:)?description[^>]*>([\s\S]*?)<\/(?:dc:)?description>/i
    );

    if (match) {
      const text = decodeXmlEntities(
        match[1]
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
          .replace(/<[^>]+>/g, "")
      );

      const idMatch = text.match(/Source id:\s*([^\s<>:"']+)/i);
      if (idMatch) return idMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}

function extractIdFromFileName(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const normalized = normalizeDigits(base);

  if (/^\d+$/.test(normalized)) return null;

  // Do not treat generic chapter filenames as ids.
  if (/(?:chapter|ch|فصل|قسمت|بخش)/i.test(normalized)) return null;

  // If it has letters and digits, it may already be the original id.
  if (/\d/.test(normalized) && /\p{L}/u.test(normalized)) {
    const cleaned = normalized
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "");

    if (cleaned) return cleaned;
  }

  return null;
}

/* ============================================================
   Original proof id lookup
============================================================ */

async function getProofBooks() {
  try {
    const entries = await fs.readdir(PROOF_ROOT, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare);
  } catch {
    return [];
  }
}

async function getProofFileMap(targetBook) {
  const map = new Map();

  if (!targetBook) return map;

  const proofDir = path.join(PROOF_ROOT, targetBook);

  const files = await walkFiles(proofDir, {
    extensions: [".json"],
    maxDepth: 3,
  });

  for (const file of files) {
    const chapterNumber = extractNumberFromFileName(file);

    if (!chapterNumber || chapterNumber <= 0) continue;

    if (!map.has(chapterNumber)) {
      map.set(chapterNumber, file);
    }
  }

  return map;
}

async function readIdFromJsonFile(filePath, cache) {
  if (cache.has(filePath)) return cache.get(filePath);

  try {
    let raw = await fs.readFile(filePath, "utf8");

    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }

    const data = JSON.parse(raw);
    const id = data?.id || null;

    cache.set(filePath, id);
    return id;
  } catch {
    cache.set(filePath, null);
    return null;
  }
}

async function resolveId({
  zip,
  filePath,
  chapterNumber,
  targetBook,
  proofFileMap,
  idCache,
}) {
  // 1. DOCX metadata from previous exporter.
  if (zip) {
    const metadataId = extractIdFromDocxMetadata(zip);
    if (metadataId) return metadataId;
  }

  // 2. Original proofing JSON id.
  const proofFile = proofFileMap.get(chapterNumber);
  if (proofFile) {
    const proofId = await readIdFromJsonFile(proofFile, idCache);
    if (proofId) return proofId;
  }

  // 3. Filename itself.
  const fileId = extractIdFromFileName(filePath);
  if (fileId) return fileId;

  // 4. Generated fallback.
  return `${slugifyId(targetBook)}_${pad5(chapterNumber)}`;
}

/* ============================================================
   DOCX chapter map building
============================================================ */

async function buildDocxChapterMap(docxFiles) {
  const map = new Map();
  const unnumbered = [];

  for (const file of docxFiles) {
    const chapterNumber = extractNumberFromFileName(file);

    if (!chapterNumber || chapterNumber <= 0) {
      unnumbered.push(file);
      continue;
    }

    const candidate = {
      number: chapterNumber,
      file,
    };

    if (map.has(chapterNumber)) {
      const old = map.get(chapterNumber);

      const oldScore = docxCandidateScore(old.file, chapterNumber);
      const newScore = docxCandidateScore(file, chapterNumber);

      if (newScore > oldScore) {
        log.warn(
          `Duplicate chapter ${chapterNumber}. Replacing "${path.basename(
            old.file
          )}" with "${path.basename(file)}".`
        );
        map.set(chapterNumber, candidate);
      } else {
        log.warn(
          `Duplicate chapter ${chapterNumber}. Keeping "${path.basename(
            old.file
          )}" and ignoring "${path.basename(file)}".`
        );
      }
    } else {
      map.set(chapterNumber, candidate);
    }
  }

  if (!map.size && unnumbered.length) {
    const sorted = unnumbered.sort((a, b) =>
      new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare(
        path.basename(a),
        path.basename(b)
      )
    );

    sorted.forEach((file, index) => {
      const chapterNumber = index + 1;
      map.set(chapterNumber, { number: chapterNumber, file });
    });

    log.warn(
      "No chapter numbers detected in DOCX filenames. Numbers were assigned by file order."
    );

    return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
  }

  if (unnumbered.length) {
    log.warn(
      `Skipping ${unnumbered.length} DOCX file(s) without recognizable chapter numbers.`
    );
    unnumbered.forEach((file) => log.dim(`  - ${file}`));
  }

  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
}

/* ============================================================
   Prompts
============================================================ */

async function getDefaultSourceDir() {
  const candidates = [
    "edited",
    "input/edited",
    "output/edited",
    "docx",
    "edited-docx",
    "ready",
  ];

  for (const candidate of candidates) {
    const resolved = path.resolve(process.cwd(), candidate);

    if (await directoryExists(resolved)) {
      return candidate;
    }
  }

  return "";
}

async function askForDirectory(message, defaultValue = "") {
  while (true) {
    const suffix = defaultValue ? chalk.dim(` [default: ${defaultValue}]`) : "";

    const answer = (
      await ask(chalk.green(`${message}${suffix}\n> `))
    ).trim();

    const value = answer || defaultValue;

    if (!value) {
      log.error("Please enter a folder path.");
      continue;
    }

    const resolved = path.resolve(process.cwd(), normalizeDigits(value));

    try {
      const stat = await fs.stat(resolved);

      if (!stat.isDirectory()) {
        log.error(`Not a directory: ${resolved}`);
        continue;
      }

      return resolved;
    } catch {
      log.error(`Directory not found: ${resolved}`);
    }
  }
}

function inferBookNameFromPath(sourceDir) {
  const parts = path.resolve(sourceDir).split(path.sep).filter(Boolean);

  const generic = new Set([
    "edited",
    "docx",
    "doc",
    "proofed",
    "final",
    "finalized",
    "output",
    "input",
    "exports",
    "chapters",
    "converted",
    "import",
    "ready",
    "src",
  ]);

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const lower = part.toLowerCase();

    if (!generic.has(lower) && !/^\d+$/.test(part)) {
      return part;
    }
  }

  return "book";
}

async function askTargetBook(inferredBook, proofBooks) {
  while (true) {
    console.log(chalk.yellow("Target book for output/finalized:"));

    if (proofBooks.length) {
      proofBooks.forEach((book, index) => {
        console.log(`  ${chalk.cyan(index + 1)}) ${book}`);
      });
    }

    if (inferredBook) {
      console.log(chalk.dim(`Default/inferred: ${inferredBook}`));
    }

    const answer = (await ask(`${chalk.green("> ")}`)).trim();

    if (!answer) {
      if (inferredBook) {
        const exactProofMatch = proofBooks.find(
          (book) => book.toLowerCase() === inferredBook.toLowerCase()
        );

        if (exactProofMatch) return exactProofMatch;

        return sanitizeFolderName(inferredBook);
      }

      log.error("Please enter or select a book name.");
      continue;
    }

    const numeric = Number(normalizeDigits(answer));

    if (
      Number.isInteger(numeric) &&
      numeric >= 1 &&
      numeric <= proofBooks.length
    ) {
      return proofBooks[numeric - 1];
    }

    const lower = answer.toLowerCase();

    const exact = proofBooks.find((book) => book.toLowerCase() === lower);
    if (exact) return exact;

    const partial = proofBooks.filter((book) =>
      book.toLowerCase().includes(lower)
    );

    if (partial.length === 1) {
      return partial[0];
    }

    if (partial.length > 1) {
      log.warn("Multiple proof books match that name:");
      partial.forEach((book) => console.log(`  - ${book}`));
      log.warn("Please choose one exactly, or type a new custom book name.");
      continue;
    }

    return sanitizeFolderName(answer);
  }
}

/* ============================================================
   Conversion
============================================================ */

async function convertDocxToFinalJson({
  chapterNumber,
  filePath,
  targetBook,
  proofFileMap,
  idCache,
}) {
  let zip = null;

  try {
    zip = new AdmZip(filePath);
  } catch (err) {
    throw new Error(`Cannot open DOCX as ZIP: ${err.message}`);
  }

  let paragraphs = await extractParagraphsWithMammoth(filePath);

  if (!paragraphs.length) {
    paragraphs = extractParagraphsWithXml(zip);
  }

  if (!paragraphs.length) {
    return {
      written: false,
      reason: "No readable paragraphs found.",
    };
  }

  const id = await resolveId({
    zip,
    filePath,
    chapterNumber,
    targetBook,
    proofFileMap,
    idCache,
  });

  const outputDir = path.join(FINALIZED_ROOT, targetBook);
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${pad5(chapterNumber)}.json`);

  const payload = {
    id,
    paragraphs,
  };

  await fs.writeFile(
    outputPath,
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );

  return {
    written: true,
    outputPath,
    id,
    paragraphCount: paragraphs.length,
  };
}

/* ============================================================
   Main
============================================================ */

async function main() {
  console.log(chalk.bold.blue("Edited DOCX -> Final JSON importer"));

  const defaultSource = await getDefaultSourceDir();

  const sourceDir = await askForDirectory(
    "Folder containing edited DOCX files:",
    defaultSource
  );

  const docxFiles = await walkFiles(sourceDir, {
    extensions: [".docx"],
    maxDepth: 6,
  });

  if (!docxFiles.length) {
    throw new Error(`No DOCX files found in: ${sourceDir}`);
  }

  log.info(`Found ${docxFiles.length} DOCX file(s).`);

  const chapterMap = await buildDocxChapterMap(docxFiles);

  if (!chapterMap.size) {
    throw new Error("No DOCX files with recognizable chapter numbers were found.");
  }

  const available = [...chapterMap.keys()];

  log.info(
    `Recognized ${chapterMap.size} chapter(s): ${available[0]} to ${
      available[available.length - 1]
    }.`
  );

  const inferredBook = inferBookNameFromPath(sourceDir);
  const proofBooks = await getProofBooks();

  const targetBook = await askTargetBook(inferredBook, proofBooks);

  log.info(`Target finalized book folder: ${targetBook}`);

  const proofFileMap = await getProofFileMap(targetBook);

  if (proofFileMap.size) {
    log.dim(
      `Found ${proofFileMap.size} original proof JSON file(s) for id lookup.`
    );
  } else {
    log.dim("No original proof JSON files found for id lookup.");
  }

  const chapterInput = await ask(
    chalk.green("Chapters to import (e.g. 1-10, 1,3,5-8, all): ")
  );

  let selectedChapters = parseChapterSelection(chapterInput, available);

  const missing = selectedChapters.filter((n) => !chapterMap.has(n));

  if (missing.length) {
    log.warn(`These selected DOCX chapters were not found: ${missing.join(", ")}`);

    const continueAnyway = await confirm(
      "Continue with the available chapters only?",
      true
    );

    if (!continueAnyway) {
      throw new Error("Aborted because selected DOCX chapters are missing.");
    }

    selectedChapters = selectedChapters.filter((n) => chapterMap.has(n));

    if (!selectedChapters.length) {
      throw new Error("No available chapters left after filtering.");
    }
  }

  const idCache = new Map();

  let written = 0;
  let skipped = 0;
  const failed = [];

  for (const chapterNumber of selectedChapters) {
    const info = chapterMap.get(chapterNumber);

    try {
      log.step(
        `Importing chapter ${chapterNumber}: ${path.relative(
          sourceDir,
          info.file
        )}`
      );

      const result = await convertDocxToFinalJson({
        chapterNumber,
        filePath: info.file,
        targetBook,
        proofFileMap,
        idCache,
      });

      if (result.written) {
        written++;
        log.success(
          ` -> ${path.relative(process.cwd(), result.outputPath)} (${
            result.paragraphCount
          } paragraphs)`
        );
      } else {
        skipped++;
        log.warn(`Skipped chapter ${chapterNumber}: ${result.reason}`);
      }
    } catch (err) {
      failed.push(chapterNumber);
      log.error(`Chapter ${chapterNumber}: ${err.message}`);
    }
  }

  console.log("");
  log.success("Import finished.");
  log.info(`Written JSON files: ${written}`);
  log.info(`Skipped: ${skipped}`);

  if (failed.length) {
    log.warn(`Failed chapters: ${failed.join(", ")}`);
  }

  log.success(`Finalized folder: ${FINALIZED_ROOT}`);
}

main()
  .then(() => rl.close())
  .catch((err) => {
    log.error(err.message);
    rl.close();
    process.exitCode = 1;
  });