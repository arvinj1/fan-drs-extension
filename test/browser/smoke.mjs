#!/usr/bin/env node
/**
 * Browser smoke test: loads the real unpacked extension into Chromium and
 * drives it on a fixture page served at https://www.youtube.com/watch via
 * request routing, so the production manifest is used unchanged.
 *
 *   CHROME_PATH=/path/to/chrome-for-testing npm run smoke
 *
 * Branded Google Chrome ignores --load-extension; use Chrome for Testing or
 * Chromium. Screenshots go to test/browser/out/.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, "../../extension");
const fixtures = path.join(here, "fixtures");
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });

const executablePath = process.env.CHROME_PATH;
if (!executablePath) {
  console.error("Set CHROME_PATH to a Chrome for Testing or Chromium binary.");
  process.exit(2);
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL ${name}\n     ${err.message.split("\n")[0]}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fan-drs-smoke-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "--autoplay-policy=no-user-gesture-required"],
});

// Every request that is not the fixture or the extension itself is recorded.
const unexpectedRequests = [];
await context.route("https://www.youtube.com/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/fixture/clip.webm") return route.fulfill({ path: path.join(fixtures, "clip.webm"), contentType: "video/webm" });
  if (url.pathname === "/watch" || url.pathname === "/") return route.fulfill({ path: path.join(fixtures, "watch.html"), contentType: "text/html" });
  return route.fulfill({ status: 404, body: "" });
});
context.on("request", (req) => {
  const u = req.url();
  if (!u.startsWith("https://www.youtube.com/") && !u.startsWith("chrome-extension://") && !u.startsWith("data:") && !u.startsWith("blob:https://www.youtube.com/")) unexpectedRequests.push(u);
});

const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(`page: ${e.message}`));
page.on("console", (m) => m.type() === "error" && consoleErrors.push(`console: ${m.text()}`));

const panel = () => page.frameLocator("#fan-drs-sidebar");
const text = (sel) => panel().locator(sel).innerText();
const play = (seconds) => page.evaluate(async (s) => {
  const v = document.querySelector("video.html5-main-video");
  await v.play();
  await new Promise((r) => setTimeout(r, s * 1000));
}, seconds);

await page.goto("https://www.youtube.com/watch?v=fixtureA");

await step("button mounts once; handle hidden before first open", async () => {
  await page.waitForSelector("#fan-drs-btn");
  await page.evaluate(() => document.body.appendChild(document.createElement("div"))); // trigger observer
  await page.waitForTimeout(100);
  expect((await page.locator("#fan-drs-btn").count()) === 1, "expected one button");
  expect((await page.locator("#fan-drs-sidebar-host").count()) === 0, "panel should be created lazily");
});

await step("panel opens, connects, and shows live context", async () => {
  await page.click("#fan-drs-btn");
  await panel().locator("#ctxTitle", { hasText: "Fixture: synthetic test pattern" }).waitFor({ timeout: 5000 });
  expect((await page.getAttribute("#fan-drs-btn", "aria-expanded")) === "true", "aria-expanded not updated");
  await play(3);
  const time = await text("#ctxTime");
  expect(/^0:0[2-4] \/ 0:20$/.test(time), `unexpected time text: ${time}`);
});

await step("Analyze returns real frames, coverage and an inconclusive evidence result", async () => {
  await panel().locator("#btnAnalyze").click();
  await panel().locator("#verdictValue", { hasText: "INCONCLUSIVE" }).waitFor({ timeout: 4000 });
  const meter = await text("#meterValue");
  const frames = Number(/· (\d+) frame/.exec(meter)?.[1]);
  expect(frames >= 8, `expected >= 8 frames, got ${meter}`);
  const ticks = await panel().locator("#timelineBar .tick").count();
  expect(ticks === frames, `timeline ticks ${ticks} != frames ${frames}`);
  expect((await text("#windowText")).startsWith("Last 12 seconds: 0:00.00 →"), "window should clamp to zero");
  expect(!/\d+%\s*$/.test(await text("#modePill")), "no confidence percentage");
  await page.screenshot({ path: path.join(outDir, "01-evidence.png") });
});

await step("marks set from fresh playback time; reversed marks are explained", async () => {
  await page.evaluate(() => document.querySelector("video.html5-main-video").pause());
  await page.evaluate(() => (document.querySelector("video.html5-main-video").currentTime = 4));
  await page.waitForTimeout(200);
  await panel().locator("#btnMarkEnd").click();
  await page.evaluate(() => (document.querySelector("video.html5-main-video").currentTime = 6));
  await page.waitForTimeout(200);
  await panel().locator("#btnMarkStart").click();
  await panel().locator("#markStartValue", { hasText: "0:06.00" }).waitFor({ timeout: 2000 });
  expect((await text("#markEndValue")) === "0:04.00", `end mark ${await text("#markEndValue")}`);
  expect((await text("#markStartValue")) === "0:06.00", `start mark ${await text("#markStartValue")}`);
  await panel().locator("#windowText", { hasText: "at or before the start mark" }).waitFor({ timeout: 2000 });
  await panel().locator("#btnAnalyze").click();
  await panel().locator("#statusText", { hasText: "at or before the start mark" }).waitFor({ timeout: 2000 });
  await panel().locator("#btnClearMarks").click();
  expect((await text("#markStartValue")) === "Not set", "marks not cleared");
});

await step("window before capture reports a gap instead of guessing", async () => {
  await panel().locator("#btnReset").click();
  await page.evaluate(() => (document.querySelector("video.html5-main-video").currentTime = 2));
  await page.waitForTimeout(150);
  await panel().locator("#btnMarkStart").click();
  await panel().locator("#markStartValue", { hasText: "0:02.00" }).waitFor({ timeout: 2000 });
  await page.evaluate(() => (document.querySelector("video.html5-main-video").currentTime = 18));
  await page.waitForTimeout(150);
  await panel().locator("#btnMarkEnd").click();
  await panel().locator("#markEndValue", { hasText: "0:18.00" }).waitFor({ timeout: 2000 });
  expect((await text("#windowText")).startsWith("Marked window: 0:02.00 → 0:18.00"), await text("#windowText"));
  await panel().locator("#btnAnalyze").click();
  await panel().locator("#verdictValue", { hasText: /INCONCLUSIVE|NO EVIDENCE/ }).waitFor({ timeout: 3000 }).catch(() => {});
  const why = await text("#whyBullets");
  const status = await text("#statusText");
  expect(/Missing footage/.test(why), `why: ${why} | status: ${status} | window: ${await text("#windowText")}`);
  expect((await panel().locator("#timelineBar .gap").count()) >= 1, "gap not drawn");
});

await step("Reset clears marks, results and timeline", async () => {
  await panel().locator("#btnReset").click();
  expect((await text("#verdictValue")) === "—", "verdict not reset");
  expect((await text("#markEndValue")) === "Not set", "marks not reset");
  expect((await panel().locator("#timelineBar > *").count()) === 0, "timeline not cleared");
});

await step("Reset during an analysis drops the late result", async () => {
  await panel().locator("#btnAnalyze").click();
  await panel().locator("#btnReset").click();
  await page.waitForTimeout(800);
  expect((await text("#verdictValue")) === "—", `late result rendered: ${await text("#verdictValue")}`);
});

await step("page scripts cannot drive the panel or hijack the bridge", async () => {
  await page.evaluate(() => {
    window.postMessage({ __fanDRS: true, type: "CLOSE_REQUEST" }, "*");
    const ch = new MessageChannel();
    document.getElementById("fan-drs-sidebar").contentWindow.postMessage({ fanDRS: "connect", v: 1 }, "*", [ch.port2]);
    ch.port1.postMessage({ v: 1, kind: "event", type: "CONTEXT_CHANGED", payload: { title: "SPOOFED" } });
  });
  await page.waitForTimeout(600);
  expect((await page.getAttribute("#fan-drs-btn", "aria-expanded")) === "true", "page closed the panel");
  expect((await text("#ctxTitle")) !== "SPOOFED", "spoofed context rendered");
});

await step("close stops capture, shows the handle, and returns focus; reopen keeps frames", async () => {
  await panel().locator("#btnClose").click();
  await page.waitForFunction(() => document.getElementById("fan-drs-handle").style.display === "block");
  const focused = await page.evaluate(() => document.activeElement?.id);
  expect(focused === "fan-drs-btn", `focus went to ${focused}`);
  const before = await page.evaluate(() => document.querySelector("video.html5-main-video").currentTime);
  await page.click("#fan-drs-handle");
  await panel().locator("#bufferText", { hasText: "Capturing" }).waitFor({ timeout: 3000 });
  const buffered = Number(/(\d+) frames/.exec(await text("#bufferText"))?.[1]);
  expect(buffered > 0, `frames lost on reopen (t=${before})`);
});

await step("repeated open/close does not leak capture loops", async () => {
  for (let i = 0; i < 6; i++) {
    await panel().locator("#btnClose").click();
    await page.click("#fan-drs-handle");
  }
  await panel().locator("#btnReset").click();
  await play(1.5);
  await panel().locator("#btnAnalyze").click();
  await panel().locator("#verdictValue", { hasText: "INCONCLUSIVE" }).waitFor({ timeout: 3000 });
  // At 250 ms throttling, 1.5 s of playback yields at most ~7 new frames per loop; stacked loops would not dedupe wall-time.
  const meter = await text("#meterValue");
  expect(/· \d+ frame/.test(meter), meter);
});

await step("watch-to-watch navigation clears frames and marks", async () => {
  await panel().locator("#btnMarkStart").click();
  await page.evaluate(() => window.fixtureNavigate("/watch?v=fixtureB"));
  await panel().locator("#statusText", { hasText: "New video" }).waitFor({ timeout: 3000 });
  expect((await text("#markStartValue")) === "Not set", "marks survived navigation");
});

await step("missing player is reported, then recovered when the player appears", async () => {
  await page.evaluate(() => window.fixtureNavigate("/watch?v=fixtureC", { withPlayer: false }));
  await panel().locator("#ctxTime", { hasText: "No player found" }).waitFor({ timeout: 3000 });
  await panel().locator("#btnAnalyze").click();
  await panel().locator("#statusText", { hasText: "No YouTube player" }).waitFor({ timeout: 2000 });
  await page.evaluate(() => window.fixtureNavigate("/watch?v=fixtureC"));
  await panel().locator("#btnAnalyze").click();
  await panel().locator("#statusText", { hasText: "Play the video past the moment" }).waitFor({ timeout: 3000 });
  await panel().locator("#ctxTime", { hasText: "/ 0:20" }).waitFor({ timeout: 4000 });
});

await step("keyboard: tab order reaches Analyze and Enter activates it", async () => {
  await play(1);
  const frame = page.frame({ url: /sidebar\.html/ });
  await frame.focus("#btnReset");
  await page.keyboard.press("Shift+Tab");
  const id = await frame.evaluate(() => document.activeElement.id);
  expect(id === "btnAnalyze", `focus on ${id}`);
  await page.keyboard.press("Enter");
  await panel().locator("#statusText", { hasText: /Collected \d+ frames/ }).waitFor({ timeout: 3000 });
});

await step("narrow viewport: panel fits within 390px", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await page.locator("#fan-drs-sidebar-host").boundingBox();
  expect(box && box.width <= 390 && box.x >= 0, `panel box ${JSON.stringify(box)}`);
  await page.screenshot({ path: path.join(outDir, "02-narrow.png") });
  await page.setViewportSize({ width: 1280, height: 800 });
});

await step("leaving watch removes all injected UI", async () => {
  await page.evaluate(() => window.fixtureNavigate("/", { withPlayer: false }));
  await page.waitForFunction(() => !document.getElementById("fan-drs-btn") && !document.getElementById("fan-drs-sidebar-host") && !document.getElementById("fan-drs-handle"), null, { timeout: 3000 });
});

await step("no network traffic beyond the page and the extension", async () => {
  expect(unexpectedRequests.length === 0, `unexpected: ${unexpectedRequests.join(", ")}`);
});

await step("no page or console errors", async () => {
  const relevant = consoleErrors.filter((e) => !/favicon|404/.test(e));
  expect(relevant.length === 0, relevant.join(" | "));
});

await context.close();
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ chrome: executablePath, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
