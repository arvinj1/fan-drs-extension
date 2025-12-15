# Console Errors Guide

## ✅ Safe to Ignore (Not Your Extension)

### YouTube's Own Errors
These are from YouTube itself, **not your extension**:

```
❌ Uncaught TypeError: 'get' on proxy: property 'assign' is a read-only...
   → YouTube's internal code issue

❌ The resource <URL> was preloaded using link preload but not used...
   → YouTube preloading resources (hundreds of these are normal)

❌ [Violation] Permissions policy violation: unload is not allowed...
   → YouTube's permission policy warnings

❌ Access to fetch at 'https://googleads.g.doubleclick.net/...'
   → CORS blocked ad requests (ad blockers cause this)

❌ Failed to load resource: net::ERR_BLOCKED_BY_CLIENT
   → Ad blocker blocking Google ads

❌ requestStorageAccessFor: Permission denied
   → YouTube trying to access third-party storage

❌ Error handling response: TypeError: Cannot read properties of undefined (reading 'isCheckout')
   → YouTube checkout/payment code errors

❌ Unchecked runtime.lastError: A listener indicated an asynchronous response...
   → Usually from other extensions or YouTube's code
```

## ⚠️ Extension Errors to Fix

### Context Invalidation (FIXED)
```javascript
✅ FIXED: sidebar.js:23 Uncaught (in promise) Error: Extension context invalidated.
```
**Cause:** Reloading extension while sidebar is open
**Fix:** Added try-catch error handling to all chrome.storage calls

### How to Test the Fix
1. **Reload extension** in `chrome://extensions`
2. **Don't close sidebar** on YouTube
3. Try changing mode or selecting bail-off
4. **Expected:** Warning in console instead of error:
   ```
   [Fan DRS] Failed to save mode: Extension context invalidated
   ```

## 🔍 Real Extension Errors to Watch For

Look for errors with **your file names**:
- `sidebar.js` (your code)
- `content_script.js` (your code)
- `bail_detection.js` (your code)
- `policy.js` (your code)

### Example Real Errors:
```javascript
❌ sidebar.js:150 Uncaught ReferenceError: addTimelineEvent is not defined
   → Function called before defined

❌ bail_detection.js:45 Uncaught TypeError: Cannot read properties of null
   → Null check missing

❌ content_script.js:200 TypeError: video.currentTime is not a function
   → Wrong API usage
```

## 📊 Console Filtering

### Chrome DevTools Filters

**Hide YouTube noise:**
```
-preload -"Permissions policy" -CORS -ERR_BLOCKED_BY_CLIENT -isCheckout
```

**Show only Fan DRS:**
```
Fan DRS
```

**Show only real errors:**
```
sidebar.js OR content_script.js OR bail_detection.js OR policy.js
```

## ✅ What Success Looks Like

### Clean Console Output:
```javascript
[Fan DRS] Bail-off detection result: {bailOffTs: 245.3, confidence: 0.78}
[Fan DRS] Auto-detected bail-off at 245.3s (confidence: 0.78)
[Fan DRS] Policy decision: {verdict: "OUT", reason: "High confidence decision"}
[Fan DRS] Timeline marker clicked: {id: "bail_off", ts: 245.3}
[Fan DRS] Seeked to 245.3s
```

### With Extension Reload (After Fix):
```javascript
⚠️ [Fan DRS] Failed to save mode (extension context may be invalidated): Error: Extension context invalidated.
```
**This is EXPECTED** - extension keeps working, just can't save to storage until page refresh.

## 🛠️ Debugging Tips

### 1. Filter Console Noise
Use the filter bar in Chrome DevTools:
- Type `-preload -CORS -ad` to hide common noise
- Type `Fan DRS` to see only your logs

### 2. Check Network Tab
Look for failed requests to your extension files:
```
✅ sidebar.js        200 OK
✅ sidebar.css       200 OK
✅ bail_detection.js 200 OK
❌ some_file.js      404 Not Found  ← Real problem!
```

### 3. Extension Console vs Page Console
- **Page Console** (F12): Shows both YouTube and your content script errors
- **Extension Background**: Right-click extension → "Inspect service worker"
- **Extension Popup**: Right-click extension icon → "Inspect popup"

### 4. Isolate Your Errors
Open console **BEFORE** clicking "Fan DRS Review" button:
1. Clear console (trash icon)
2. Click "Fan DRS Review"
3. Any new errors are from your extension

## 🐛 Common False Alarms

### Not Extension Errors:
1. **Hundreds of "preload" warnings** → YouTube doing prefetch
2. **CORS errors for ads** → Ad blocker working
3. **"isCheckout" errors** → YouTube payment module broken
4. **Polymer/LegacyDataMixin** → YouTube's old framework warnings
5. **Permissions policy** → YouTube's strict CSP

### Actually Extension Errors:
1. **Files with your paths** (`extension/src/...`)
2. **"Fan DRS" in error message**
3. **chrome.runtime.lastError** related to your extension ID
4. **"Extension context invalidated"** (now handled gracefully)

## 📝 Error Reporting Checklist

When reporting extension issues, include:
- ✅ Error message **with file name and line number**
- ✅ Steps to reproduce
- ✅ What you expected vs what happened
- ✅ Screenshot if UI-related
- ❌ Don't include YouTube's preload/CORS/ad errors

## 🎯 Quick Reference

| Error Contains | Is It Your Problem? | Action |
|---|---|---|
| `sidebar.js`, `content_script.js` | ✅ YES | Debug your code |
| `[Fan DRS]` prefix | ✅ YES (but might be warning) | Check severity |
| `preload`, `CORS`, `doubleclick` | ❌ NO | Ignore |
| `isCheckout`, `kevlar`, `Polymer` | ❌ NO | YouTube's issue |
| `Extension context invalidated` | ⚠️ YES (handled) | Refresh page after reload |
| `net::ERR_BLOCKED_BY_CLIENT` | ❌ NO | Ad blocker |

## 🚀 Testing Workflow

1. **Before testing:**
   ```javascript
   // Clear console
   console.clear();
   console.log('[TEST] Starting fresh');
   ```

2. **Test feature:**
   - Click buttons
   - Check for `[Fan DRS]` logs
   - Look for red errors with your file names

3. **After test:**
   ```javascript
   // Check for extension errors only
   // Filter: "sidebar.js OR bail_detection.js"
   ```

## ✨ All Fixed!

The "Extension context invalidated" error is now handled gracefully. Your extension will:
- ✅ Continue working after reload
- ✅ Log warnings instead of throwing errors
- ✅ Gracefully degrade (can't save, but analysis still works)
- ✅ Recover on next page navigation
