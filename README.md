# ⚡ Nik-lamb — Chrome Extension

Monitors IREPS e-auction pages and automatically places the next valid bid when outbid.

---

## 🚀 Installation (For Testers)

> You need **Google Chrome** and a **valid DSC** to log in to IREPS.

### Step 1 — Download

Click the green **"Code"** button on this page → **"Download ZIP"**

Or use this direct link:  
`https://github.com/<OWNER>/<REPO>/archive/refs/heads/main.zip`

### Step 2 — Extract

Unzip the downloaded file. You'll get a folder like `ireps-auto-bidder-main/`.

### Step 3 — Load in Chrome

1. Open Chrome and go to: `chrome://extensions`
2. Turn ON **"Developer mode"** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the **unzipped folder** (`ireps-auto-bidder-main/`)
5. The extension icon (⚡) should appear in your toolbar

### Step 4 — Use on IREPS

1. Go to your IREPS e-auction page and log in with your DSC
2. You'll see a floating **⚡ Auto Bidder** panel on the page
3. Click **⚙️ Setup** to configure:
   - **📊 Current Bid Element** — click it, then click the element on the page that shows the current highest bid
   - **💰 Next Bid Input** — click it, then click the field that shows the next bid amount
   - **🖱️ Bid Button** — click it, then click the actual "Place Bid" button on the page
4. Set your **Max Bid Limit** (₹) — the bot will stop if the next bid exceeds this
5. Click **💾 Save Config**
6. Click **⚡ ARM** to start watching

### How It Works

- When armed, the bot watches for bid changes using 3 methods:
  - **Network interception** — catches bid data from AJAX/fetch responses before the page even renders
  - **DOM observer** — detects when the bid display element changes
  - **Polling** — checks every 30ms as a fallback
- When a bid change is detected, it automatically clicks the bid button
- If a confirmation dialog appears, it clicks OK/Confirm instantly
- Stops automatically if the next bid would exceed your max limit

---

## 🧪 Testing — What to Report

When testing, please note:

### 1. Timing
- How fast does it react when someone else bids? (instant / <1 sec / 1-2 sec?)
- Check the **Activity Log** in the overlay — it shows timestamps with millisecond precision
- Look for `[via network]` vs `[via poll]` vs `[via mutation]` — which one fires first?

### 2. Selector Setup
- Did the element selector (point-and-click) work correctly?
- Did it pick the right elements?
- What are the CSS selectors it generated? (shown in the log as `✅ currentBidDisplay = "..."`)

### 3. Confirmation Dialogs
- After clicking bid, does a confirmation popup appear?
- Does the bot auto-click the confirm button?
- If not, what does the confirm button look like? (screenshot helps)

### 4. Network Intercept
- Look in the Activity Log for `📡 Network intercept` messages
- What URL patterns show up? (this helps us fine-tune the interceptor)

### 5. Any Errors
- Open Chrome DevTools (`F12`) → **Console** tab
- Filter for `[IREPS-Bot]` messages
- Screenshot any red errors

### Quick Screenshot Guide
Take a screenshot of:
1. The overlay panel showing the Activity Log after a few bids
2. The Chrome DevTools console filtered to `IREPS-Bot`
3. The IREPS auction page layout (so we can see element structure)

---

## 🔄 Updating to Latest Version

When changes are made:
1. Come back to this GitHub page
2. Download the ZIP again (same as Step 1)
3. Extract to a **new folder** (or replace the old one)
4. Go to `chrome://extensions`
5. Click the **🔄 reload** button on the extension card
   - Or: Remove the old one and load the new folder

---

## ⚙️ Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Poll Speed | 30ms | How often to check for bid changes (lower = faster, min 20ms) |
| Max Bid Limit | ∞ (no limit) | Bot stops if next bid exceeds this amount |

Config is saved in Chrome's local storage and persists across page reloads.

---

## 📁 File Structure

```
ireps-auto-bidder/
├── manifest.json              # Extension configuration
├── background/
│   └── service-worker.js      # Notifications & keepalive
├── content/
│   ├── interceptor.js         # Network interception (MAIN world)
│   ├── content.js             # Core bidding logic + overlay UI
│   └── overlay.css            # Overlay panel styles
└── popup/
    ├── popup.html             # Toolbar popup
    ├── popup.js               # Popup logic
    └── popup.css              # Popup styles
```

---

## ⚠️ Disclaimer

This tool is for personal productivity use only. Use at your own risk. The developers are not responsible for any consequences of automated bidding on government auction platforms.
