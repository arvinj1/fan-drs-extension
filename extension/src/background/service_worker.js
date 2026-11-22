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

// Alt+Shift+R (changeable in chrome://extensions/shortcuts) asks the YouTube tab
// to review the last 12 seconds. Tabs without the content script just ignore it.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "review-moment" || !tab || tab.id === undefined) return;
  chrome.tabs.sendMessage(tab.id, { fanDRS: "review" }).catch(() => {});
});
