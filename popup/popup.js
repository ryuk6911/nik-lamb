/* ═════════════════════════════════════
   Nik-lamb — Popup Script
   Communicates with the content script.
   ═════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const currentBid = document.getElementById('current-bid');
  const nextBid = document.getElementById('next-bid');
  const bidCount = document.getElementById('bid-count');
  const maxLimit = document.getElementById('max-limit');
  const btnArm = document.getElementById('btn-arm');
  const btnDisarm = document.getElementById('btn-disarm');
  const btnSetLimit = document.getElementById('btn-set-limit');
  const maxBidInput = document.getElementById('max-bid-input');
  const configStatus = document.getElementById('config-status');

  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isIrepsPage = tab?.url?.includes('ireps.gov.in');

  if (!isIrepsPage) {
    statusDot.className = 'status-dot no-page';
    statusText.textContent = 'Not on IREPS page';
    btnArm.disabled = true;
    btnArm.style.opacity = '0.4';
    configStatus.textContent = '🌐 Navigate to an IREPS auction page first.';
    return;
  }

  // Request status from content script
  function refreshStatus() {
    chrome.tabs.sendMessage(tab.id, { action: 'getStatus' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        statusDot.className = 'status-dot no-page';
        statusText.textContent = 'Extension not loaded on page';
        configStatus.textContent = '🔄 Try refreshing the IREPS page.';
        return;
      }

      if (response.isArmed) {
        statusDot.className = 'status-dot armed';
        statusText.textContent = 'ARMED — WATCHING';
        btnArm.style.display = 'none';
        btnDisarm.style.display = '';
      } else {
        statusDot.className = 'status-dot disarmed';
        statusText.textContent = 'DISARMED';
        btnArm.style.display = '';
        btnDisarm.style.display = 'none';
      }

      currentBid.textContent = response.currentBid !== null
        ? `₹${response.currentBid.toLocaleString('en-IN')}`
        : '—';
      nextBid.textContent = response.nextBid !== null
        ? `₹${response.nextBid.toLocaleString('en-IN')}`
        : '—';
      bidCount.textContent = response.bidCount || 0;
      maxLimit.textContent = response.maxBidLimit
        ? `₹${response.maxBidLimit.toLocaleString('en-IN')}`
        : '∞';

      if (response.configured) {
        configStatus.textContent = '✅ Selectors configured. Ready to bid.';
      } else {
        configStatus.textContent = '⚠️ Use the overlay on the page to set up selectors.';
      }
    });
  }

  refreshStatus();

  // Auto-refresh every 2 seconds while popup is open
  const refreshTimer = setInterval(refreshStatus, 2000);

  // Arm button
  btnArm.addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, { action: 'arm' }, () => {
      refreshStatus();
    });
  });

  // Disarm button
  btnDisarm.addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, { action: 'disarm' }, () => {
      refreshStatus();
    });
  });

  // Set max limit
  btnSetLimit.addEventListener('click', () => {
    const val = parseFloat(maxBidInput.value);
    chrome.tabs.sendMessage(tab.id, {
      action: 'setMaxLimit',
      value: isNaN(val) || val <= 0 ? null : val
    }, () => {
      refreshStatus();
    });
  });
});
