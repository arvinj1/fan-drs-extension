#!/usr/bin/env node
/**
 * Browser smoke test: loads the real unpacked extension into Chromium and
 * drives it on fixture pages served at https://www.youtube.com/watch via
 * request routing, so the production manifest is used unchanged.
 *
 *   CHROME_PATH=/path/to/chrome-for-testing npm run smoke
 *
 * Branded Google Chrome ignores --load-extension; use Chrome for Testing or
 * Chromium. Screenshots and results.json go to test/browser/out/.
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
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://www.youtube.com" });

// Only the fixture's own URLs are expected; anything else is recorded.
const unexpectedRequests = [];
const CLIPS = { "/fixture/clip.webm": "clip.webm", "/fixture/stumping.webm": "stumping.webm" };
await context.route("https://www.youtube.com/**", (route) => {
  const url = new URL(route.request().url());
  if (CLIPS[url.pathname]) return route.fulfill({ path: path.join(fixtures, CLIPS[url.pathname]), contentType: "video/webm" });
  if (url.pathname === "/watch" || url.pathname === "/") return route.fulfill({ path: path.join(fixtures, "watch.html"), contentType: "text/html" });
  return route.fulfill({ status: 404, body: "" });
});
// A second origin, served without CORS headers, so drawing it taints the canvas.
await context.route("https://media.fixture.example/**", (route) => route.fulfill({ path: path.join(fixtures, "clip.webm"), contentType: "video/webm" }));
context.on("request", (req) => {
  const u = new URL(req.url());
  const expected =
    (u.origin === "https://www.youtube.com" && (u.pathname === "/" || u.pathname === "/watch" || CLIPS[u.pathname])) ||
    u.href === "https://media.fixture.example/clip.webm" ||
    u.protocol === "chrome-extension:" ||
    u.protocol === "data:" ||
    u.protocol === "blob:";
  if (!expected) unexpectedRequests.push(u.href);
});

const consoleErrors = [];
function watchErrors(p) {
  p.on("pageerror", (e) => consoleErrors.push(`page: ${e.message}`));
  p.on("console", (m) => m.type() === "error" && consoleErrors.push(`console: ${m.text()}`));
}

const page = await context.newPage();
watchErrors(page);

async function waitForCard(p) {
  for (let i = 0; i < 50; i++) {
    const f = p.frames().find((x) => x.url().includes("/src/sidebar/sidebar.html"));
    if (f) return f;
    await p.waitForTimeout(100);
  }
  throw new Error("card frame not found");
}
// The card iframe lives in a closed shadow root, so find it by URL.
const card = () => {
  const f = page.frames().find((x) => x.url().includes("/src/sidebar/sidebar.html"));
  if (!f) throw new Error("card frame not found");
  return f;
};
const text = (sel) => card().locator(sel).innerText();
const chip = () => page.locator("#fan-drs-btn").innerText();
const video = (fn, arg) => page.evaluate(fn, arg);
const play = (seconds) =>
  video(async (s) => {
    const v = document.querySelector("video.html5-main-video");
    await v.play();
    await new Promise((r) => setTimeout(r, s * 1000));
  }, seconds);
const seekTo = (t) => video((x) => (document.querySelector("video.html5-main-video").currentTime = x), t);
const waitVerdict = (re, timeout = 6000) => card().locator("#verdict", { hasText: re }).waitFor({ timeout });
const bracketTimes = async () => {
  const m = /bails on at (\d+):(\d+\.\d+), a bail off at (\d+):(\d+\.\d+) \((\d+) ms apart\)/.exec(await text("#bracketText"));
  return m ? { on: +m[1] * 60 + +m[2], off: +m[3] * 60 + +m[4], gap: +m[5] } : null;
};

// ---------------------------------------------------------------------------
// Capture policy and chip
// ---------------------------------------------------------------------------

await page.goto("https://www.youtube.com/watch?v=pattern1");

await step("non-cricket video: chip says DRS off and nothing is captured", async () => {
  await page.waitForSelector("#fan-drs-btn");
  await play(1.5);
  await page.locator("#fan-drs-btn", { hasText: "DRS off" }).waitFor({ timeout: 3000 });
  expect((await page.locator("#fan-drs-btn").count()) === 1, "expected one chip");
});

await step("chip on a non-cricket video turns capture on and opens the card honestly", async () => {
  await page.click("#fan-drs-btn");
  await waitForCard(page);
  await card().locator("#capturePill", { hasText: "on for this video" }).waitFor({ timeout: 4000 });
  await waitVerdict("NO FRAMES");
  expect(/replay the moment/i.test(await text("#openItems")), await text("#openItems"));
  await page.locator("#fan-drs-btn", { hasText: "DRS ready" }).waitFor({ timeout: 3000 });
});

await step("capture keeps running with the card closed", async () => {
  await card().locator("#btnClose").click();
  await page.waitForFunction(() => document.activeElement?.id === "fan-drs-btn", null, { timeout: 3000 }).catch(async () => {
    throw new Error(`focus on ${await page.evaluate(() => `${document.activeElement?.tagName}#${document.activeElement?.id} expanded=${document.getElementById("fan-drs-btn")?.getAttribute("aria-expanded")}`)}`);
  });
  await play(1.5);
  await page.locator("#fan-drs-btn", { hasText: "DRS ready" }).waitFor();
});

await step("remembering a channel applies to its other videos", async () => {
  await page.click("#fan-drs-btn");
  await card().locator("#rememberChannel").check();
  await card().locator("#rememberLabel", { hasText: "Fixture channel" }).waitFor();
  await page.evaluate(() => window.fixtureNavigate("/watch?v=pattern2"));
  await page.locator("#fan-drs-btn", { hasText: "DRS ready" }).waitFor({ timeout: 4000 });
  await card().locator("#capturePill", { hasText: "on for this channel" }).waitFor({ timeout: 4000 });
  await card().locator("#rememberChannel").uncheck();
  await card().locator("#capturePill", { hasText: "not detected as cricket" }).waitFor({ timeout: 4000 });
  await card().locator("#btnClose").click();
});

// ---------------------------------------------------------------------------
// Review on the synthetic stumping
// ---------------------------------------------------------------------------

await step("cricket video: capture starts by itself", async () => {
  await page.evaluate(() => window.fixtureNavigate("/watch?v=stump1", { fx: "stumping" }));
  await page.locator("#fan-drs-btn", { hasText: "DRS ready" }).waitFor({ timeout: 4000 });
  await seekTo(0);
  await play(8.6);
  await video(() => document.querySelector("video.html5-main-video").pause());
});

await step("chip review detects the bail-off interval at the scripted 6.0 s", async () => {
  await page.click("#fan-drs-btn");
  await card().locator("#windowLabel", { hasText: "from the DRS button" }).waitFor({ timeout: 4000 });
  await waitVerdict("INCONCLUSIVE");
  const b = await bracketTimes();
  expect(b, `no bracket: ${await text("#bracketText")}`);
  expect(b.on < 6.0 && b.off >= 6.0 && b.off - b.on <= 0.4, `bracket ${JSON.stringify(b)}`);
  const bt = await text("#bracketText");
  expect(/^Candidate, detected automatically/.test(bt) && !/%/.test(bt), bt);
  expect(await card().locator("#btnConfirmBracket").isVisible(), "no way to confirm the candidate");
  await page.screenshot({ path: path.join(outDir, "01-review.png") });
});

await step("crease is found near the painted line; the hint says not behind", async () => {
  expect(/Detected/.test(await text("#creaseText")), await text("#creaseText"));
  const x = await card().evaluate(() => {
    const l = document.querySelector("#stageOverlay line");
    return l ? (+l.getAttribute("x1") + +l.getAttribute("x2")) / 2 : null;
  });
  expect(x !== null && Math.abs(x - 281.5) <= 4, `crease x ${x}`);
  expect(/not behind/.test(await text("#hintText")), await text("#hintText"));
});

// The beta never decides: whatever the viewer confirms, the finding stays
// inconclusive and says what is and isn't established.
await step("an unconfirmed candidate supports nothing; the finding never says OUT", async () => {
  await card().locator('input[value="not-behind"]').check();
  await waitVerdict("INCONCLUSIVE");
  expect(/hasn’t been confirmed/.test(await text("#openItems")), await text("#openItems"));
  expect(!/bail/.test(await text("#observations")), `candidate reported as a wicket break: ${await text("#observations")}`);
  await card().locator("#btnConfirmBracket").click();
  await card().locator("#bracketText", { hasText: "Confirmed by you" }).waitFor({ timeout: 2000 });
  expect(await card().locator("#btnConfirmBracket").isHidden(), "confirm button still shown");
  for (const value of ["not-behind", "behind", "cant-see", "not-behind"]) {
    await card().locator(`input[value="${value}"]`).check();
    await waitVerdict("INCONCLUSIVE");
    expect(!/^(NOT )?OUT$/.test(await text("#verdict")), `verdict decided: ${await text("#verdict")}`);
  }
  const obs = await text("#observations");
  expect(/You confirmed the bails on at/.test(obs) && /neither bat nor body/.test(obs) && /haven’t checked/.test(obs), obs);
  const ne = await text("#notEstablished");
  expect(/attempting a run/.test(ne) && /ms between the two frames/.test(ne) && /legal/.test(ne), ne);
  await page.screenshot({ path: path.join(outDir, "02-finding.png") });
});

await step("copy evidence produces a packet that matches the card", async () => {
  await card().locator("#btnCopy").click();
  await card().locator("#statusText", { hasText: /Evidence copied|Copying was blocked/ }).waitFor({ timeout: 3000 });
  const raw = (await text("#statusText")).includes("copied") ? await page.evaluate(() => navigator.clipboard.readText()) : await card().locator("#packetFallback").inputValue();
  const p = JSON.parse(raw);
  expect(p.schema === "fan-drs.evidence/1", p.schema);
  expect(p.video.id === "stump1" && p.video.title.includes("stumping"), JSON.stringify(p.video));
  expect(p.finding.call === "INCONCLUSIVE" && !("verdict" in p), JSON.stringify(p.finding));
  expect(p.finding.notEstablished.some((x) => /attempting a run/.test(x)), JSON.stringify(p.finding.notEstablished));
  expect(p.grounded.value === "not-behind" && p.grounded.source === "viewer", JSON.stringify(p.grounded));
  expect(p.bracket.lastOn.t < 6 && p.bracket.firstOff.t >= 6 && p.bracket.source === "detector" && p.bracket.confirmed === true, JSON.stringify(p.bracket));
  expect(Math.abs((p.crease.line.x1 + p.crease.line.x2) / 2 - 281.5 / 480) < 0.01, JSON.stringify(p.crease));
  expect(!raw.includes("base64"), "packet contains image data");
});

await step("the viewer can override the bracket and set the crease with two clicks", async () => {
  await card().locator("#strip").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  expect((await card().locator('input[value="not-behind"]:checked').count()) === 1, "precondition: a grounding answer is in place");
  await card().locator("#btnSetOff").click();
  expect(/^Marked by you/.test(await text("#bracketText")), await text("#bracketText"));
  // The answer was about the old frames, so it must not carry over.
  expect((await card().locator('input[name="grounded"]:checked').count()) === 0, "grounding answer survived a bracket edit");
  expect(!/You judged/.test(await text("#observations")), `stale grounding observation: ${await text("#observations")}`);
  await card().locator("#btnSetCrease").click();
  const box = await card().locator("#stageImg").boundingBox();
  const sx = box.width / 480;
  await card().locator("#stageBox").click({ position: { x: 300 * sx, y: 80 * sx } });
  await card().locator("#stageBox").click({ position: { x: 300 * sx, y: 250 * sx } });
  await card().locator("#creaseText", { hasText: "Set by you" }).waitFor({ timeout: 2000 });
  const x = await card().evaluate(() => {
    const l = document.querySelector("#stageOverlay line");
    return (+l.getAttribute("x1") + +l.getAttribute("x2")) / 2;
  });
  expect(Math.abs(x - 300) <= 3, `viewer crease x ${x}`);
});

await step("replay gesture: seek back and pause opens a fresh review", async () => {
  await card().locator("#btnClose").click();
  await seekTo(9);
  await play(0.8);
  await seekTo(6.4);
  await play(0.6);
  await video(() => document.querySelector("video.html5-main-video").pause());
  await card().locator("#windowLabel", { hasText: "from your replay pause" }).waitFor({ timeout: 4000 });
  await waitVerdict(/^INCONCLUSIVE$/);
  // Paused at ~7 s, but the window runs to where the viewer seeked back from (~9.8 s), so 6.0 s is covered.
  const label = await text("#windowLabel");
  const t1 = Number(/→ 0:(\d+\.\d+)/.exec(label)?.[1]);
  expect(t1 > 9, `window should extend to the seek origin: ${label}`);
  const b = await bracketTimes();
  expect(b && b.on < 6 && b.off >= 6, `bail-off not found from a replay pause: ${await text("#bracketText")}`);
});

await step("the replay gesture doesn't replace a review that's open", async () => {
  const before = await text("#windowLabel");
  await seekTo(9);
  await play(0.6);
  await seekTo(5);
  await play(0.4);
  await video(() => document.querySelector("video.html5-main-video").pause());
  await page.waitForTimeout(800);
  expect((await text("#windowLabel")) === before, `open review was replaced: ${await text("#windowLabel")}`);
});

await step("a plain pause does not open anything", async () => {
  await card().locator("#btnClose").click();
  await play(1);
  await video(() => document.querySelector("video.html5-main-video").pause());
  await page.waitForTimeout(600);
  expect((await page.getAttribute("#fan-drs-btn", "aria-expanded")) === "false", "card opened on a plain pause");
});

// Chrome commands can't be pressed in headless Chrome, so this sends the
// message the service worker's onCommand handler sends. The handler itself is
// four lines and is checked by hand in the live test.
await step("the content script reviews on the shortcut's message", async () => {
  const [sw] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent("serviceworker")];
  await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) await chrome.tabs.sendMessage(t.id, { fanDRS: "review" }).catch(() => {});
  });
  await card().locator("#windowLabel", { hasText: "keyboard shortcut" }).waitFor({ timeout: 4000 });
});

await step("keyboard: strip arrows move the selection, Escape closes", async () => {
  await waitVerdict("INCONCLUSIVE");
  await card().locator("#strip").focus();
  await page.keyboard.press("End");
  const last = await text("#stageCaption");
  await page.keyboard.press("ArrowLeft");
  expect((await text("#stageCaption")) !== last, "arrow did not move");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("fan-drs-btn").getAttribute("aria-expanded") === "false");
});

await step("a review that finishes after navigation never shows the old video's result", async () => {
  await page.click("#fan-drs-btn");
  await waitVerdict(/INCONCLUSIVE|NO FRAMES/);
  // Slow decoding in the card so the navigation lands mid-review.
  await card().evaluate(() => {
    const original = window.createImageBitmap;
    window.createImageBitmap = async (...args) => {
      await new Promise((r) => setTimeout(r, 400));
      return original(...args);
    };
  });
  await card().locator("#btnReviewAgain").click();
  await page.waitForTimeout(200);
  await page.evaluate(() => window.fixtureNavigate("/watch?v=pattern9"));
  await card().locator("#statusText", { hasText: "New video" }).waitFor({ timeout: 4000 });
  await page.waitForTimeout(1500); // longer than the slowed decode
  expect(await card().locator("#reviewView").isHidden(), `stale review rendered: ${await text("#windowLabel")} / ${await text("#verdict")}`);
  expect(/New video/.test(await text("#statusText")), `status overwritten: ${await text("#statusText")}`);
});

await step("back-to-back reviews: the newer one wins", async () => {
  await page.evaluate(() => window.fixtureNavigate("/watch?v=stump5", { fx: "stumping" }));
  await seekTo(0);
  await play(8.6);
  await video(() => document.querySelector("video.html5-main-video").pause());
  await page.click("#fan-drs-btn");
  const [sw] = context.serviceWorkers();
  await sw.evaluate(async () => {
    for (const t of await chrome.tabs.query({})) await chrome.tabs.sendMessage(t.id, { fanDRS: "review" }).catch(() => {});
  });
  await card().locator("#windowLabel", { hasText: "keyboard shortcut" }).waitFor({ timeout: 4000 });
  await waitVerdict(/^INCONCLUSIVE$/, 8000);
  await page.waitForTimeout(1500);
  expect(/keyboard shortcut/.test(await text("#windowLabel")), `older review replaced the newer one: ${await text("#windowLabel")}`);
  await card().locator("#btnCopy").click();
  await card().locator("#statusText", { hasText: /Evidence copied|Copying was blocked/ }).waitFor({ timeout: 3000 });
  const raw = (await text("#statusText")).includes("copied") ? await page.evaluate(() => navigator.clipboard.readText()) : await card().locator("#packetFallback").inputValue();
  const p = JSON.parse(raw);
  expect(p.video.id === "stump5" && p.window.trigger === "shortcut", `packet: ${JSON.stringify(p.video)} ${p.window.trigger}`);
});

await step("narrow viewport: card fits within 390px", async () => {
  await page.click("#fan-drs-btn");
  await waitVerdict(/INCONCLUSIVE|NO FRAMES/);
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await page.evaluate(() => {
    const host = [...document.documentElement.children].find((el) => el.getAttribute("aria-label") === "Fan DRS Review");
    const r = host.getBoundingClientRect();
    return { x: r.x, width: r.width };
  });
  expect(box.width <= 390 && box.x >= 0, `card box ${JSON.stringify(box)}`);
  await page.screenshot({ path: path.join(outDir, "03-narrow.png") });
  await page.setViewportSize({ width: 1280, height: 800 });
});

// ---------------------------------------------------------------------------
// Lifecycle and security (carried from A1)
// ---------------------------------------------------------------------------

await step("watch-to-watch navigation clears the review", async () => {
  await page.evaluate(() => window.fixtureNavigate("/watch?v=stump2", { fx: "stumping" }));
  await card().locator("#statusText", { hasText: "New video" }).waitFor({ timeout: 3000 });
  expect(await card().locator("#reviewView").isHidden(), "review still shown");
});

await step("same <video> reused across navigation clears the review", async () => {
  await play(1);
  await page.click("#fan-drs-btn");
  await waitVerdict(/INCONCLUSIVE|NO FRAMES/);
  await page.evaluate(() => (document.querySelector("video.html5-main-video").dataset.reuseMarker = "1"));
  await page.evaluate(() => window.fixtureNavigate("/watch?v=stump3", { reuse: true, fx: "stumping" }));
  await card().locator("#statusText", { hasText: "cleared" }).waitFor({ timeout: 3000 });
  expect(await page.evaluate(() => document.querySelector("video.html5-main-video").dataset.reuseMarker === "1"), "fixture did not reuse the element");
});

await step("missing player is announced once", async () => {
  await page.evaluate(() => window.fixtureNavigate("/watch?v=noplayer", { withPlayer: false }));
  await card().locator("#capturePill", { hasText: "No player found" }).waitFor({ timeout: 3000 });
  await card().locator("#statusText", { hasText: "player went away" }).waitFor({ timeout: 2000 });
  await card().evaluate(() => (document.getElementById("statusText").textContent = "SENTINEL"));
  await page.waitForTimeout(1600);
  expect((await text("#statusText")) === "SENTINEL", `status was rewritten: ${await text("#statusText")}`);
});

await step("page scripts can't reach the card iframe or send commands to the content script", async () => {
  const seen = await page.evaluate(() => {
    window.postMessage({ __fanDRS: true, type: "CLOSE_REQUEST" }, "*");
    const host = [...document.documentElement.children].find((el) => el.getAttribute("aria-label") === "Fan DRS Review");
    return { iframeInDom: Boolean(document.querySelector("iframe")), shadowRoot: host.shadowRoot, frames: window.length };
  });
  expect(!seen.iframeInDom && seen.shadowRoot === null && seen.frames === 0, `page can see the iframe: ${JSON.stringify(seen)}`);
});

await step("a page that spams fake connects before the card exists can't take it over", async () => {
  const hostile = await context.newPage();
  watchErrors(hostile);
  await hostile.addInitScript(() => {
    setInterval(() => {
      for (let i = 0; i < window.frames.length; i++) {
        const ch = new MessageChannel();
        ch.port1.postMessage({ v: 1, kind: "event", type: "CONTEXT_CHANGED", payload: { title: "SPOOFED BY PAGE", hasPlayer: true, capture: { on: true, reason: "CRICKET", bufferedFrames: 999 } } });
        try { window.frames[i].postMessage({ fanDRS: "connect", v: 1 }, "*", [ch.port2]); } catch {}
        try { window.frames[i].postMessage({ fanDRS: "connect", v: 1, nonce: "guess" }, "*", [new MessageChannel().port2]); } catch {}
      }
    }, 1);
  });
  await hostile.goto("https://www.youtube.com/watch?v=stumpH&fx=stumping");
  await hostile.waitForSelector("#fan-drs-btn");
  await hostile.click("#fan-drs-btn");
  const frame = await waitForCard(hostile);
  await frame.locator("#capturePill", { hasText: "Capturing" }).waitFor({ timeout: 5000 });
  await hostile.waitForTimeout(800);
  expect(!/999/.test(await frame.locator("#capturePill").innerText()), "capture state was spoofed");
  await hostile.close();
});

await step("blocked capture is shown, even when it happens before the card connects", async () => {
  const p = await context.newPage();
  watchErrors(p);
  await p.goto("https://www.youtube.com/watch?v=xo1");
  await p.evaluate(() => window.fixtureNavigate("/watch?v=xo1", { crossOrigin: true, fx: "stumping" }));
  await p.evaluate(() => document.querySelector("video.html5-main-video").play());
  await p.waitForSelector("#fan-drs-btn");
  await p.waitForTimeout(1200);
  await p.click("#fan-drs-btn");
  const frame = await waitForCard(p);
  await frame.locator("#capturePill", { hasText: "Blocked" }).waitFor({ timeout: 5000 }).catch(async (err) => {
    const v = await p.evaluate(() => { const el = document.querySelector("video.html5-main-video"); return { rs: el.readyState, paused: el.paused, t: el.currentTime, err: el.error && el.error.code, w: el.videoWidth }; });
    throw new Error(`${err.message.split("\n")[0]} | pill: ${await frame.locator("#capturePill").innerText()} | video: ${JSON.stringify(v)}`);
  });
  await p.close();
});

await step("leaving watch removes all injected UI", async () => {
  await page.evaluate(() => window.fixtureNavigate("/", { withPlayer: false }));
  await page.waitForFunction(() => !document.getElementById("fan-drs-btn") && ![...document.documentElement.children].some((el) => el.getAttribute("aria-label") === "Fan DRS Review" || el.textContent === "DRS"), null, { timeout: 3000 });
});

await step("no network traffic beyond the page and the extension", async () => {
  expect(unexpectedRequests.length === 0, `unexpected: ${unexpectedRequests.join(", ")}`);
});

await step("no page or console errors", async () => {
  const relevant = consoleErrors.filter((e) => !/favicon|404|SecurityError|tainted/.test(e));
  expect(relevant.length === 0, relevant.join(" | "));
});

await context.close();
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ chrome: executablePath, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
