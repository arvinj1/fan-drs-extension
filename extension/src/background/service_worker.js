/**
 * Fan DRS Review - MV3 Service Worker (minimal for now)
 * Keeps a place for future opt-in "Accuracy Boost" server calls (with consent).
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log("[FanDRS] Installed");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "PING") {
    sendResponse({ ok: true, from: "service_worker" });
    return true;
  }
  return false;
});
