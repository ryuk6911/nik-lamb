# ⚡ Nik-lamb

A lightweight Chrome extension for real-time page monitoring and workflow automation.

---

## Installation

> Requires **Google Chrome**.

### Step 1 — Download

Click the green **"Code"** button → **"Download ZIP"**

### Step 2 — Extract

Unzip the downloaded file.

### Step 3 — Load in Chrome

1. Open Chrome and go to: `chrome://extensions`
2. Turn ON **"Developer mode"** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the unzipped folder
5. The extension icon (⚡) should appear in your toolbar

### Step 4 — Use

1. Navigate to the target page
2. You'll see a floating **⚡ Nik-lamb** panel
3. Click **⚙️ Setup** to configure element selectors (point-and-click)
4. Set your max limit if needed
5. Click **💾 Save Config**
6. Click **⚡ ARM** to start monitoring

---

## Updating

1. Download the ZIP again
2. Extract over the old folder
3. Go to `chrome://extensions` and click the 🔄 reload button

---

## File Structure

```
nik-lamb/
├── manifest.json
├── background/
│   └── service-worker.js
├── content/
│   ├── interceptor.js
│   ├── content.js
│   └── overlay.css
└── popup/
    ├── popup.html
    ├── popup.js
    └── popup.css
```
