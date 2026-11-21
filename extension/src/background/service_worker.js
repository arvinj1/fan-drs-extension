/**
 * Fan DRS Review - MV3 Service Worker.
 * Install logging and a PING health check. The extension makes no network
 * requests; capture and review run entirely in the YouTube tab.
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
