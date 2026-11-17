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
        if (currentLockState === 'countdown') {
          btnLock.className = 'popup-btn btn-lock is-counting';
          btnLock.textContent = `⏳ CANCEL (${response.lockCountdownRemaining}s)`;
        } else if (currentLockState === 'locked') {
          btnLock.className = 'popup-btn btn-lock is-locked';
          btnLock.textContent = `🔓 UNLOCK (${response.lockDurationRemaining}s)`;
        } else {
          btnLock.className = 'popup-btn btn-lock';
          btnLock.textContent = '🔒 LOCK BID';
        }
      }

      if (currentLockState === 'countdown') {
        statusDot.className = 'status-dot locking';
        statusText.textContent = `LOCKING IN ${response.lockCountdownRemaining}s...`;
      } else if (currentLockState === 'locked') {
        statusDot.className = 'status-dot locked';
        statusText.textContent = `STATIC LOCK (${response.lockDurationRemaining}s)`;
      } else if (response.isArmed) {
        statusDot.className = 'status-dot armed';
        if (response.weAreLeading && response.leadingBidAmount) {
          statusText.textContent = `LEADING (₹${response.leadingBidAmount.toLocaleString('en-IN')}) 🏆`;
        } else {
          statusText.textContent = 'ARMED — WATCHING';
        }
      } else {
        statusDot.className = 'status-dot disarmed';
        statusText.textContent = 'DISARMED';
      }

      if (response.isArmed) {
        btnArm.style.display = 'none';
        btnDisarm.style.display = '';
      } else {
        btnArm.style.display = '';
        btnDisarm.style.display = 'none';
      }

      if (response.weAreLeading && response.leadingBidAmount) {
        currentBid.textContent = `₹${response.leadingBidAmount.toLocaleString('en-IN')} (YOU 🏆)`;
      } else {
        currentBid.textContent = response.currentBid !== null
          ? `₹${response.currentBid.toLocaleString('en-IN')}`
          : '—';
      }
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
  let popupAuthMode = 'lock'; // 'lock' | 'unlock'

  const popupAuthModal = document.getElementById('popup-auth-modal');
  const popupAuthHint = document.getElementById('popup-auth-hint');
  const popupAuthInput = document.getElementById('popup-auth-input');
  const popupAuthError = document.getElementById('popup-auth-error');
  const popupAuthSubmit = document.getElementById('popup-auth-submit');
  const popupAuthCancel = document.getElementById('popup-auth-cancel');

  function openAuthModal(mode = 'lock') {
    if (!popupAuthModal) return;
    popupAuthMode = mode;
    if (popupAuthHint) {
      popupAuthHint.textContent = mode === 'unlock'
        ? 'Enter 6-digit code to UNLOCK BID'
        : 'Enter 6-digit code to LOCK BID';
    }
    if (popupAuthSubmit) {
      popupAuthSubmit.textContent = mode === 'unlock' ? 'Verify & Unlock' : 'Verify & Lock';
    }
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

  function verifyAuthFromPopup() {
    const code = popupAuthInput.value.trim();
    if (!code || code.length !== 6) {
      popupAuthError.textContent = 'Enter 6 digits';
      return;
    }
    const action = popupAuthMode === 'unlock' ? 'verifyAndUnlock' : 'verifyAndLock';
    chrome.tabs.sendMessage(tab.id, { action, code }, (res) => {
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

  if (popupAuthSubmit) popupAuthSubmit.addEventListener('click', verifyAuthFromPopup);
  if (popupAuthCancel) popupAuthCancel.addEventListener('click', closeAuthModal);
  if (popupAuthInput) {
    popupAuthInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifyAuthFromPopup();
      if (e.key === 'Escape') closeAuthModal();
    });
    popupAuthInput.addEventListener('input', () => {
      if (popupAuthInput.value.length === 6) {
        verifyAuthFromPopup();
      }
    });
  }

  // Lock button
  if (btnLock) {
    btnLock.addEventListener('click', () => {
      if (currentLockState === 'idle') {
        openAuthModal('lock');
      } else {
        openAuthModal('unlock');
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
