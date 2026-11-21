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

// Only the fixture's own URLs are expected; anything else is recorded.
const unexpectedRequests = [];
const FIXTURE_PATHS = new Set(["/", "/watch", "/fixture/clip.webm"]);
await context.route("https://www.youtube.com/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/fixture/clip.webm") return route.fulfill({ path: path.join(fixtures, "clip.webm"), contentType: "video/webm" });
  if (url.pathname === "/watch" || url.pathname === "/") return route.fulfill({ path: path.join(fixtures, "watch.html"), contentType: "text/html" });
  return route.fulfill({ status: 404, body: "" });
});
// A second origin, served without CORS headers, so drawing it taints the canvas.
await context.route("https://media.fixture.example/**", (route) => route.fulfill({ path: path.join(fixtures, "clip.webm"), contentType: "video/webm" }));
context.on("request", (req) => {
  const u = new URL(req.url());
  const expected =
    (u.origin === "https://www.youtube.com" && FIXTURE_PATHS.has(u.pathname)) ||
    u.href === "https://media.fixture.example/clip.webm" ||
    u.protocol === "chrome-extension:" ||
    u.protocol === "data:" ||
    u.protocol === "blob:";
  if (!expected) unexpectedRequests.push(u.href);
});

const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(`page: ${e.message}`));
page.on("console", (m) => m.type() === "error" && consoleErrors.push(`console: ${m.text()}`));

// The panel iframe lives in a closed shadow root, so find it by URL.
const sidebarOf = (p) => {
  const frame = p.frames().find((f) => f.url().includes("/src/sidebar/sidebar.html"));
  if (!frame) throw new Error("sidebar frame not found");
  return frame;
};
const panel = () => sidebarOf(page);
async function waitForSidebar(p) {
  for (let i = 0; i < 50; i++) {
    const f = p.frames().find((x) => x.url().includes("/src/sidebar/sidebar.html"));
    if (f) return f;
    await p.waitForTimeout(100);
  }
  throw new Error("sidebar frame not found");
}
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
  await waitForSidebar(page);
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

// Supersede/cancel ordering is proven in unit tests; here we only check the UI ends clean.
await step("Reset during an analysis leaves a clean panel", async () => {
  await panel().locator("#btnAnalyze").click();
  await panel().locator("#btnReset").click();
  await page.waitForTimeout(800);
  expect((await text("#verdictValue")) === "—", `late result rendered: ${await text("#verdictValue")}`);
});

await step("page scripts can't reach the panel iframe or send commands to the content script", async () => {
  const seen = await page.evaluate(() => {
    window.postMessage({ __fanDRS: true, type: "CLOSE_REQUEST" }, "*");
    const host = document.getElementById("fan-drs-sidebar-host");
    return { iframeInDom: Boolean(document.querySelector("iframe")), shadowRoot: host.shadowRoot };
  });
  await page.waitForTimeout(400);
  expect(!seen.iframeInDom && seen.shadowRoot === null, `page can see the iframe: ${JSON.stringify(seen)}`);
  expect((await page.getAttribute("#fan-drs-btn", "aria-expanded")) === "true", "page closed the panel");
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

// Loop stacking is covered by unit tests; this checks capture still works after churn.
await step("capture keeps working after repeated open/close", async () => {
  for (let i = 0; i < 6; i++) {
    await panel().locator("#btnClose").click();
    await page.click("#fan-drs-handle");
  }
  await panel().locator("#btnReset").click();
  await play(1.5);
  await panel().locator("#btnAnalyze").click();
  await panel().locator("#verdictValue", { hasText: "INCONCLUSIVE" }).waitFor({ timeout: 3000 });
  const frames = Number(/· (\d+) frame/.exec(await text("#meterValue"))?.[1]);
  expect(frames >= 4, `expected fresh frames after churn, got ${frames}`);
});

await step("watch-to-watch navigation clears frames and marks", async () => {
  await panel().locator("#btnMarkStart").click();
  await page.evaluate(() => window.fixtureNavigate("/watch?v=fixtureB"));
  await panel().locator("#statusText", { hasText: "New video" }).waitFor({ timeout: 3000 });
  expect((await text("#markStartValue")) === "Not set", "marks survived navigation");
});

await step("same <video> reused across navigation clears old frames and marks", async () => {
  await play(1);
  await panel().locator("#btnMarkStart").click();
  await panel().locator("#markStartValue", { hasText: /\d:\d\d\.\d\d/ }).waitFor({ timeout: 2000 });
  await page.evaluate(() => (document.querySelector("video.html5-main-video").dataset.reuseMarker = "1"));
  await page.evaluate(() => window.fixtureNavigate("/watch?v=fixtureReuse", { reuse: true }));
  await panel().locator("#statusText", { hasText: "cleared" }).waitFor({ timeout: 3000 });
  expect((await text("#markStartValue")) === "Not set", "marks survived");
  const sameElement = await page.evaluate(() => document.querySelector("video.html5-main-video").dataset.reuseMarker === "1");
  expect(sameElement, "fixture did not reuse the element");
});

await step("a source change on the same URL clears marks set while paused", async () => {
  await page.evaluate(() => document.querySelector("video.html5-main-video").pause());
  await panel().locator("#btnReset").click();
  await panel().locator("#btnMarkStart").click();
  await panel().locator("#markStartValue", { hasText: /\d:\d\d\.\d\d/ }).waitFor({ timeout: 2000 });
  await page.evaluate(() => window.fixtureNavigate(location.pathname + location.search, { reuse: true }));
  await panel().locator("#statusText", { hasText: "source changed" }).waitFor({ timeout: 3000 });
  expect((await text("#markStartValue")) === "Not set", "paused marks survived a source change");
});

await step("missing player is announced once, then recovered when the player appears", async () => {
  await page.evaluate(() => window.fixtureNavigate("/watch?v=fixtureC", { withPlayer: false }));
  await panel().locator("#ctxTime", { hasText: "No player found" }).waitFor({ timeout: 3000 });
  await panel().locator("#statusText", { hasText: "player went away" }).waitFor({ timeout: 2000 });
  // A repeated reset would overwrite this sentinel on the next 500 ms tick.
  await panel().evaluate(() => (document.getElementById("statusText").textContent = "SENTINEL"));
  await page.waitForTimeout(1600);
  expect((await text("#statusText")) === "SENTINEL", `status was rewritten: ${await text("#statusText")}`);
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

await step("a page that spams fake connects before the panel exists can't take it over", async () => {
  const hostile = await context.newPage();
  await hostile.addInitScript(() => {
    // Every child frame, every millisecond, from before the panel is created.
    setInterval(() => {
      for (let i = 0; i < window.frames.length; i++) {
        const ch = new MessageChannel();
        ch.port1.onmessage = (ev) => {
          if (ev.data && ev.data.type === "GET_CONTEXT") ch.port1.postMessage({ v: 1, kind: "response", id: ev.data.id, ok: true, payload: { title: "SPOOFED BY PAGE", hasPlayer: true, currentTime: 1, duration: 20, capture: { running: true, generation: 1, bufferedFrames: 999 } } });
        };
        ch.port1.postMessage({ v: 1, kind: "event", type: "CONTEXT_CHANGED", payload: { title: "SPOOFED BY PAGE", capture: { bufferedFrames: 999 } } });
        try { window.frames[i].postMessage({ fanDRS: "connect", v: 1 }, "*", [ch.port2]); } catch {}
        try { window.frames[i].postMessage({ fanDRS: "connect", v: 1, nonce: "guess" }, "*", [new MessageChannel().port2]); } catch {}
      }
    }, 1);
  });
  await hostile.goto("https://www.youtube.com/watch?v=fixtureH");
  await hostile.waitForSelector("#fan-drs-btn");
  await hostile.click("#fan-drs-btn");
  const frame = await waitForSidebar(hostile);
  await frame.locator("#ctxTitle", { hasText: "Fixture: synthetic test pattern" }).waitFor({ timeout: 5000 });
  await hostile.waitForTimeout(800);
  expect((await frame.locator("#ctxTitle").innerText()) === "Fixture: synthetic test pattern", "title was spoofed");
  expect(!/999/.test(await frame.locator("#bufferText").innerText()), "buffer count was spoofed");
  await hostile.close();
});

await step("blocked capture is shown on first open, even before the panel connects", async () => {
  const p = await context.newPage();
  await p.goto("https://www.youtube.com/watch?v=fixtureX");
  await p.evaluate(() => window.fixtureNavigate("/watch?v=fixtureX", { crossOrigin: true }));
  await p.evaluate(() => document.querySelector("video.html5-main-video").play());
  await p.waitForSelector("#fan-drs-btn");
  await p.click("#fan-drs-btn");
  const frame = await waitForSidebar(p);
  await frame.locator("#bufferText", { hasText: "Blocked" }).waitFor({ timeout: 5000 }).catch(async (err) => {
    const v = await p.evaluate(() => { const el = document.querySelector("video.html5-main-video"); return { rs: el.readyState, paused: el.paused, t: el.currentTime, src: el.src, err: el.error && el.error.code }; });
    throw new Error(`${err.message.split("\n")[0]} | buffer: ${await frame.locator("#bufferText").innerText()} | video: ${JSON.stringify(v)}`);
  });
  await frame.locator("#btnReset").click();
  expect(/Blocked/.test(await frame.locator("#bufferText").innerText()), "Reset hid the capture error");
  await p.close();
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
