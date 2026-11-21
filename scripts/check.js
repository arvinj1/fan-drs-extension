#!/usr/bin/env node
/**
 * Static checks for the extension package:
 *   - every JS file parses
 *   - every file the manifest references exists
 *   - declared icons are the size the manifest claims (PNG header)
 *   - host access stays scoped to www.youtube.com
 * Exits non-zero on the first category with failures, after printing all of them.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const failures = [];
const fail = (msg) => failures.push(msg);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// 1. Syntax
const jsFiles = walk(root).filter((f) => f.endsWith(".js"));
for (const file of jsFiles) {
  try {
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: file });
  } catch (err) {
    fail(`syntax: ${path.relative(root, file)}: ${err.message}`);
  }
}

// 2. Manifest references
const refs = [
  manifest.background?.service_worker,
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  ...(manifest.web_accessible_resources || []).flatMap((w) => w.resources),
].filter(Boolean);
for (const ref of refs) {
  if (!fs.existsSync(path.join(root, ref))) fail(`missing file referenced by manifest: ${ref}`);
}

// 3. Sidebar script references must be exposed with the page
const sidebarHtml = fs.readFileSync(path.join(root, "src/sidebar/sidebar.html"), "utf8");
const war = new Set((manifest.web_accessible_resources || []).flatMap((w) => w.resources));
for (const m of sidebarHtml.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
  const resolved = path.posix.normalize(path.posix.join("src/sidebar", m[1]));
  if (!fs.existsSync(path.join(root, resolved))) fail(`sidebar.html references missing ${resolved}`);
  if (!war.has(resolved)) fail(`sidebar.html loads ${resolved} but it is not in web_accessible_resources`);
}

// 4. Icon dimensions
for (const [size, rel] of Object.entries(manifest.icons || {})) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  const buf = fs.readFileSync(file);
  const isPng = buf.length >= 24 && buf.toString("ascii", 1, 4) === "PNG";
  const w = isPng ? buf.readUInt32BE(16) : 0;
  const h = isPng ? buf.readUInt32BE(20) : 0;
  if (w !== Number(size) || h !== Number(size)) fail(`icon ${rel} is ${w}x${h}, manifest declares ${size}x${size}`);
}

// 5. Permission scope
const hosts = [...(manifest.host_permissions || []), ...(manifest.content_scripts || []).flatMap((c) => c.matches)];
for (const h of hosts) if (h !== "https://www.youtube.com/*") fail(`unexpected host access: ${h}`);
const perms = manifest.permissions || [];
for (const p of perms) if (p !== "storage") fail(`unexpected permission: ${p}`);

const known = process.argv.includes("--allow-known") ? ["icon "] : [];
const blocking = failures.filter((f) => !known.some((k) => f.startsWith(k)));
for (const f of failures) console.log(`${blocking.includes(f) ? "FAIL" : "KNOWN"}  ${f}`);
console.log(`checked ${jsFiles.length} JS files, ${refs.length} manifest references: ${blocking.length} failing, ${failures.length - blocking.length} known`);
process.exit(blocking.length ? 1 : 0);
