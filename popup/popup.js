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
  const btnLock = document.getElementById('btn-lock');
  const btnSetLimit = document.getElementById('btn-set-limit');
  const maxBidInput = document.getElementById('max-bid-input');
  const configStatus = document.getElementById('config-status');

  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isTargetPage = tab?.url?.includes('ireps.gov.in');

  if (!isTargetPage) {
    statusDot.className = 'status-dot no-page';
    statusText.textContent = 'Not on target page';
    btnArm.disabled = true;
    btnArm.style.opacity = '0.4';
    if (btnLock) {
      btnLock.disabled = true;
      btnLock.style.opacity = '0.4';
    }
    configStatus.textContent = '🌐 Navigate to the target page first.';
    return;
  }

  // Request status from content script
  function refreshStatus() {
    chrome.tabs.sendMessage(tab.id, { action: 'getStatus' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        statusDot.className = 'status-dot no-page';
        statusText.textContent = 'Extension not loaded on page';
        configStatus.textContent = '🔄 Try refreshing the target page.';
        return;
      }

      currentLockState = response.lockState || 'idle';

      if (btnLock) {
        btnLock.className = 'popup-btn btn-lock';
        btnLock.textContent = '🔒 LOCK BID';
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

  // Auto-refresh every 1 second while popup is open
  const refreshTimer = setInterval(refreshStatus, 1000);

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

  let currentLockState = 'idle';

  const popupAuthModal = document.getElementById('popup-auth-modal');
  const popupAuthInput = document.getElementById('popup-auth-input');
  const popupAuthError = document.getElementById('popup-auth-error');
  const popupAuthSubmit = document.getElementById('popup-auth-submit');
  const popupAuthCancel = document.getElementById('popup-auth-cancel');

  function openAuthModal() {
    if (!popupAuthModal) return;
    popupAuthError.textContent = '';
    popupAuthInput.value = '';
    popupAuthModal.style.display = 'flex';
    popupAuthInput.focus();
  }

  function closeAuthModal() {
    if (!popupAuthModal) return;
    popupAuthModal.style.display = 'none';
    popupAuthError.textContent = '';
    popupAuthInput.value = '';
  }

  function verifyAndLockFromPopup() {
    const code = popupAuthInput.value.trim();
    if (!code || code.length !== 6) {
      popupAuthError.textContent = 'Enter 6 digits';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { action: 'verifyAndLock', code }, (res) => {
      if (chrome.runtime.lastError || !res) {
        popupAuthError.textContent = 'Connection error. Check page.';
        return;
      }
      if (res.ok) {
        closeAuthModal();
        refreshStatus();
      } else {
        popupAuthError.textContent = res.error || 'Invalid authenticator code';
        popupAuthInput.value = '';
        popupAuthInput.focus();
      }
    });
  }

  if (popupAuthSubmit) popupAuthSubmit.addEventListener('click', verifyAndLockFromPopup);
  if (popupAuthCancel) popupAuthCancel.addEventListener('click', closeAuthModal);
  if (popupAuthInput) {
    popupAuthInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifyAndLockFromPopup();
      if (e.key === 'Escape') closeAuthModal();
    });
    popupAuthInput.addEventListener('input', () => {
      if (popupAuthInput.value.length === 6) {
        verifyAndLockFromPopup();
      }
    });
  }

  // Lock button
  if (btnLock) {
    btnLock.addEventListener('click', () => {
      if (currentLockState === 'idle') {
        openAuthModal();
      } else if (currentLockState === 'countdown') {
        chrome.tabs.sendMessage(tab.id, { action: 'cancelLock' }, () => refreshStatus());
      } else if (currentLockState === 'locked') {
        chrome.tabs.sendMessage(tab.id, { action: 'toggleLock' }, () => refreshStatus());
      }
    });
  }

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
