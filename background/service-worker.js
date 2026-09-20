/* ══════════════════════════════════════════
   Nik-lamb — Service Worker
   Handles notifications and background state.
   ══════════════════════════════════════════ */

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.action === 'notify') {
      await showNotification(message.title, message.body);
      sendResponse({ ok: true });
    }
  })();
  return true;
});

// Show desktop notification
async function showNotification(title, body) {
  // Generate a simple icon as data URL using OffscreenCanvas
  const iconUrl = await getIconDataUrl();

  chrome.notifications.create(`nl-notify-${Date.now()}`, {
    type: 'basic',
    iconUrl,
    title: title || 'Nik-lamb',
    message: body || '',
    priority: 2
  });
}

// Generate icon as data URL (no file dependency)
async function getIconDataUrl() {
  const canvas = new OffscreenCanvas(128, 128);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0a1628';
  ctx.beginPath();
  ctx.roundRect(0, 0, 128, 128, 24);
  ctx.fill();

  // Lightning bolt
  ctx.fillStyle = '#00ff88';
  ctx.font = 'bold 72px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚡', 64, 68);

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

// Keep service worker alive during active bidding by using alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') {
    // Just a heartbeat to prevent SW from dying during active monitoring
    const { isArmed } = await chrome.storage.local.get('isArmed');
    if (!isArmed) {
      await chrome.alarms.clear('keepalive');
    }
  }
});

// When armed state changes, manage the keepalive alarm
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.isArmed) {
    if (changes.isArmed.newValue) {
      await chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
    } else {
      await chrome.alarms.clear('keepalive');
    }
  }
});
