/* ============================================================
   Nik-lamb — Content Script
   Content script for Nik-lamb.
   ============================================================ */

(function () {
  'use strict';

  // Prevent double injection
  if (window.__NL_LOADED__) return;
  window.__NL_LOADED__ = true;

  // ── State ──
  let isArmed = false;
  let maxBidLimit = Infinity;
  let maxJumpLimit = Infinity;  // Max allowed jump between consecutive bids
  let lastKnownNextBid = null;  // Track the NEXT bid input value (our trigger)
  let bidCount = 0;
  let observer = null;
  let confirmObserver = null;
  let pollInterval = null;
  let selectorConfig = null;
  let isSelectingMode = false;
  let selectingField = null;
  let highlightedEl = null;
  let logs = [];
  let lastNetworkBidTimestamp = 0;
  let lastActTimestamp = 0;  // Prevent double-acting within a short window

  // ── Static Lock State (5s delay -> 15s freeze) ──
  let lockState = 'idle'; // 'idle' | 'countdown' | 'locked'
  let isLocked = false;
  let lockDelay = 5;          // seconds before lock engages (default: 5)
  let lockDuration = 15;      // seconds lock remains active (default: 15)
  let lockCountdownRemaining = 0;
  let lockDurationRemaining = 0;
  let lockCountdownTimer = null;
  let lockDurationTimer = null;
  let lockShield = null;
  const originalDisabledElements = new Map();
  const blockedEvents = [
    'click', 'dblclick', 'mousedown', 'mouseup',
    'pointerdown', 'pointerup', 'touchstart', 'touchend',
    'keydown', 'keypress', 'keyup',
    'submit', 'input', 'change', 'contextmenu'
  ];

  // ── Google Authenticator (TOTP) State ──
  let totpSecret = 'SKP63DSLYZ4MH6DY4FM5WNQJW2RLK5NK';

  // ── Default selector hints (user will configure these) ──
  const DEFAULT_SELECTORS = {
    currentBidDisplay: '', // Element showing the current highest bid (display only)
    nextBidInput: '',      // Input showing next valid bid amount (OUR TRIGGER)
    bidAmountInput: '',    // Input where the actual bid amount must be entered
    bidButton: '',         // The submit/place bid button
  };

  // ── Logging ──
  function log(msg, type = 'info') {
    const entry = {
      time: new Date().toLocaleTimeString('en-IN', { hour12: false, fractionalSecondDigits: 3 }),
      msg,
      type
    };
    logs.push(entry);
    if (logs.length > 200) logs.shift();
    updateOverlayLog(entry);
    console.log(`[NL][${entry.time}] ${msg}`);
  }

  // ── Core: Extract numeric value from text ──
  function extractNumber(text) {
    if (!text) return null;
    // Remove currency symbols, commas, spaces
    const cleaned = text.toString().replace(/[₹$,\s]/g, '').trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  // ── Core: Get element by selector safely ──
  function getEl(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  // ── Core: Read next bid amount (the value IREPS pre-fills — THIS IS OUR TRIGGER) ──
  function readNextBidAmount() {
    if (!selectorConfig?.nextBidInput) return null;
    const el = getEl(selectorConfig.nextBidInput);
    if (!el) {
      return null;
    }
    // This is typically an input field — read .value
    const text = el.value || el.textContent || '';
    return extractNumber(text);
  }

  // ── Core: Read current bid from page (for DISPLAY only, not detection) ──
  function readCurrentBidForDisplay() {
    if (!selectorConfig?.currentBidDisplay) return null;
    const el = getEl(selectorConfig.currentBidDisplay);
    if (!el) return null;
    const text = el.value || el.textContent || '';
    return extractNumber(text);
  }

  // ── Core: Fill the bid amount input field ──
  function fillBidAmount(value) {
    if (isLocked) {
      log('🔒 Bid fill blocked — static lock is active', 'warn');
      return false;
    }
    if (!selectorConfig?.bidAmountInput) {
      log('⚠️ No bid amount input configured — skipping fill', 'warn');
      return false;
    }
    const el = getEl(selectorConfig.bidAmountInput);
    if (!el) {
      log(`❌ Bid amount input not found: ${selectorConfig.bidAmountInput}`, 'error');
      return false;
    }

    // Set the value
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }

    // Dispatch events so the page's validation recognizes the new value
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

    log(`📝 Filled bid amount: ₹${value} → ${selectorConfig.bidAmountInput}`, 'info');
    return true;
  }

  // ── Core: Click the submit button ──
  function clickBidButton() {
    if (isLocked) {
      log('🔒 Bid submit click blocked — static lock is active', 'warn');
      return false;
    }
    if (!selectorConfig?.bidButton) return false;
    const btn = getEl(selectorConfig.bidButton);
    if (!btn) {
      log('❌ Submit button not found!', 'error');
      return false;
    }
    if (btn.disabled) {
      log('⚠️ Submit button is disabled, skipping', 'warn');
      return false;
    }
    btn.click();
    return true;
  }

  // ── Core: The detection logic ──
  // Watches #calculatedMinBidRate — when it changes, someone just bid.
  // The new value IS the next valid bid — just click submit.
  function checkAndBid(source = 'poll') {
    if (!isArmed || isLocked) return;

    const nextBid = readNextBidAmount();
    if (nextBid === null) return;

    // Detect if the next bid value changed
    if (lastKnownNextBid !== null && nextBid !== lastKnownNextBid) {
      const now = Date.now();

      // Prevent double-acting (e.g., if both network + poll detect same change)
      if (now - lastActTimestamp < 500) {
        lastKnownNextBid = nextBid;
        return;
      }
      lastActTimestamp = now;

      log(`🔔 CHANGE DETECTED! Next bid: ₹${lastKnownNextBid} → ₹${nextBid} [via ${source}]`, 'alert');

      // Check if next bid exceeds our max limit
      if (nextBid > maxBidLimit) {
        log(`🛑 Next bid ₹${nextBid} exceeds max limit ₹${maxBidLimit}. STOPPING.`, 'warn');
        setArmed(false);
        updateOverlayStatus();
        return;
      }

      // Check for suspicious spike (bait protection)
      const jump = nextBid - lastKnownNextBid;
      if (maxJumpLimit !== Infinity && jump > maxJumpLimit) {
        log(`🚨 SPIKE BLOCKED! Jump ₹${lastKnownNextBid} → ₹${nextBid} (Δ₹${jump.toFixed(2)}) exceeds max jump ₹${maxJumpLimit}. PAUSED.`, 'warn');
        setArmed(false);
        updateOverlayStatus();
        return;
      }

      // ACT NOW!
      log(`⚡ ACTING! Submitting ₹${nextBid}`, 'bid');

      // Step 1: Fill the bid amount into the actual input field
      const filled = fillBidAmount(nextBid);

      // Step 2: Click submit
      const clicked = clickBidButton();
      if (clicked) {
        bidCount++;
        log(`✅ Entry #${bidCount} placed! (₹${nextBid})${filled ? '' : ' ⚠️ amount field not filled'}`, 'success');
        // Confirmation dialog handled by confirmObserver
      } else {
        log(`❌ Click failed! Selector: ${selectorConfig?.bidButton}`, 'error');
      }
    }

    lastKnownNextBid = nextBid;
    updateOverlayCurrentBid(readCurrentBidForDisplay(), nextBid);
  }

  // ── Network Intercept: Listen for bid data from MAIN world interceptor ──
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'nl-intercept') return;
    if (!isArmed || isLocked) return;

    const payload = event.data.payload;
    const now = Date.now();

    // Debounce: skip if we just processed a network event <15ms ago
    if (now - lastNetworkBidTimestamp < 15) return;
    lastNetworkBidTimestamp = now;

    // Only log when there's actually new data (reduces noise)
    if (payload.isNewData) {
      const tag = payload.priority === 'high' ? '🔴' : '📡';
      log(`${tag} Network [${payload.source}]: ${payload.url?.substring(payload.url.lastIndexOf('/') + 1, payload.url.lastIndexOf('/') + 50)}`, 'info');

      // If DWR parsing found bid values, log them for debugging
      if (payload.dwrValues && payload.dwrValues.length > 0) {
        log(`   └─ DWR values detected: [${payload.dwrValues.join(', ')}]`, 'info');
      }
    }

    // High priority (known DWR endpoints) → check immediately, no rAF delay
    if (payload.priority === 'high') {
      checkAndBid('network');
    } else {
      // Low priority → use rAF to check on next render frame
      requestAnimationFrame(() => {
        checkAndBid('network');
      });
    }
  });

  // ── Handle confirmation popups/modals ──
  function handleConfirmationDialog() {
    if (!isArmed || isLocked) return;
    // Look for common confirmation buttons in modal dialogs
    const confirmSelectors = [
      'button[type="submit"]',
      '.modal .btn-primary',
      '.modal .btn-success',
      'button:contains("OK")',
      'button:contains("Yes")',
      'button:contains("Confirm")',
      '.swal2-confirm',
      '.bootbox-accept',
      'input[type="button"][value="OK"]',
      'input[type="button"][value="Yes"]',
      'input[type="button"][value="Confirm"]',
      'input[type="submit"][value="OK"]',
      'input[type="submit"][value="Yes"]',
      'input[type="submit"][value="Confirm"]'
    ];

    for (const sel of confirmSelectors) {
      try {
        const btn = document.querySelector(sel);
        if (btn && isVisible(btn)) {
          log(`🔘 Clicking confirmation: ${sel}`, 'info');
          btn.click();
          return;
        }
      } catch { /* :contains isn't standard, ignore */ }
    }

    // Also check for text content matching
    const allBtns = document.querySelectorAll('button, input[type="button"], input[type="submit"]');
    for (const btn of allBtns) {
      const text = (btn.value || btn.textContent || '').trim().toLowerCase();
      if ((text === 'ok' || text === 'yes' || text === 'confirm' || text === 'submit') && isVisible(btn)) {
        log(`🔘 Clicking confirmation button: "${text}"`, 'info');
        btn.click();
        return;
      }
    }
  }

  function isVisible(el) {
    return el.offsetParent !== null || el.style.display !== 'none';
  }

  // ── MutationObserver: Watch the NEXT BID INPUT for changes ──
  function startObserver() {
    if (observer) observer.disconnect();

    // Target the next bid input element — this is what changes when someone bids
    let target = null;
    if (selectorConfig?.nextBidInput) {
      target = getEl(selectorConfig.nextBidInput);
    }

    observer = new MutationObserver((mutations) => {
      if (!isArmed) return;
      checkAndBid('mutation');
    });

    if (target) {
      // Watch the input element for attribute changes (value, etc.)
      observer.observe(target, {
        attributes: true,
        attributeFilter: ['value'],
        childList: true,
        characterData: true,
        subtree: true
      });

      // Also watch the PARENT for child replacement (DWR might replace the element)
      if (target.parentElement) {
        const parentObserver = new MutationObserver(() => {
          if (!isArmed) return;
          checkAndBid('parent-mutation');
        });
        parentObserver.observe(target.parentElement, {
          childList: true,
          subtree: true,
          characterData: true
        });
      }

      // Direct event listeners on the input (catches programmatic changes)
      target.addEventListener('input', () => { if (isArmed) checkAndBid('input-event'); });
      target.addEventListener('change', () => { if (isArmed) checkAndBid('change-event'); });

      log(`👁️ Observer watching: ${selectorConfig.nextBidInput} (next bid input)`, 'info');
    } else {
      // Fallback: observe entire body
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['value']
      });
      log('👁️ Observer watching: full body (next bid input not found)', 'info');
    }
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // ── Confirmation Dialog Observer: instant click on modal appearance ──
  function startConfirmObserver() {
    if (confirmObserver) confirmObserver.disconnect();

    confirmObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          // Check if the added node IS or CONTAINS a confirm button
          handleConfirmationInNode(node);
        }
      }
    });

    confirmObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function stopConfirmObserver() {
    if (confirmObserver) {
      confirmObserver.disconnect();
      confirmObserver = null;
    }
  }

  // ── Check a newly-added DOM node for confirmation buttons ──
  function handleConfirmationInNode(node) {
    // Only react if we're armed and just placed a bid (and not locked)
    if (!isArmed || isLocked || bidCount === 0) return;

    const checkEl = (el) => {
      if (!el || !el.matches) return;
      const text = (el.value || el.textContent || '').trim().toLowerCase();
      const isConfirmButton = (
        el.matches('button, input[type="button"], input[type="submit"]') &&
        (text === 'ok' || text === 'yes' || text === 'confirm' || text === 'submit')
      );
      const isModalPrimary = el.matches('.modal .btn-primary, .modal .btn-success, .swal2-confirm, .bootbox-accept');

      if ((isConfirmButton || isModalPrimary) && isVisible(el)) {
        log(`🔘 Auto-confirming dialog: "${text}"`, 'info');
        el.click();
      }
    };

    // Check the node itself
    checkEl(node);

    // Check all buttons inside the node
    if (node.querySelectorAll) {
      node.querySelectorAll('button, input[type="button"], input[type="submit"]').forEach(checkEl);
    }
  }

  // ── Polling fallback (for AJAX-updated content MutationObserver might miss) ──
  function startPolling(intervalMs = 30) {
    stopPolling();
    pollInterval = setInterval(() => {
      if (!isArmed) return;
      checkAndBid('poll');
    }, intervalMs);
    log(`🔄 Polling started (${intervalMs}ms interval)`, 'info');
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  // ── Armed state management ──
  function setArmed(armed) {
    isArmed = armed;
    if (armed) {
      lastKnownNextBid = readNextBidAmount();
      const displayBid = readCurrentBidForDisplay();
      log(`🟢 ARMED! Watching next bid input for changes.`, 'success');
      log(`   Current next bid: ₹${lastKnownNextBid || 'unknown'} | Display: ₹${displayBid || 'unknown'}`, 'info');
      startObserver();
      startConfirmObserver();
      const pollSpeed = parseInt(document.getElementById('ireps-bot-poll-input')?.value) || 30;
      startPolling(pollSpeed);
    } else {
      log('🔴 DISARMED. Monitoring stopped.', 'warn');
      stopObserver();
      stopConfirmObserver();
      stopPolling();
    }
    updateOverlayStatus();
    chrome.storage.local.set({ isArmed: armed });
  }

  // ═══════════════════════════════════════════════════
  //  GOOGLE AUTHENTICATOR (RFC 6238 TOTP Engine)
  // ═══════════════════════════════════════════════════

  function sha1(bytes) {
    function rotl(n, s) { return (n << s) | (n >>> (32 - s)); }
    const len = bytes.length;
    const bitLen = len * 8;
    const wordCount = ((len + 8) >> 6) + 1;
    const words = new Uint32Array(wordCount * 16);
    for (let i = 0; i < len; i++) {
      words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    }
    words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
    words[words.length - 1] = bitLen & 0xffffffff;
    words[words.length - 2] = Math.floor(bitLen / 0x100000000);

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Uint32Array(80);

    for (let i = 0; i < words.length; i += 16) {
      for (let j = 0; j < 16; j++) w[j] = words[i + j];
      for (let j = 16; j < 80; j++) w[j] = rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);

      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let j = 0; j < 80; j++) {
        let f, k;
        if (j < 20) { f = (b & c) | ((~b) & d); k = 0x5a827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        const temp = (rotl(a, 5) + f + e + k + w[j]) | 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = temp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    const result = new Uint8Array(20);
    const hs = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 5; i++) {
      result[i * 4] = (hs[i] >>> 24) & 0xff;
      result[i * 4 + 1] = (hs[i] >>> 16) & 0xff;
      result[i * 4 + 2] = (hs[i] >>> 8) & 0xff;
      result[i * 4 + 3] = hs[i] & 0xff;
    }
    return result;
  }

  function hmacSha1(key, message) {
    let k = new Uint8Array(key);
    if (k.length > 64) k = sha1(k);
    const paddedKey = new Uint8Array(64);
    paddedKey.set(k);
    const iPad = new Uint8Array(64);
    const oPad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      iPad[i] = paddedKey[i] ^ 0x36;
      oPad[i] = paddedKey[i] ^ 0x5c;
    }
    const innerMsg = new Uint8Array(64 + message.length);
    innerMsg.set(iPad);
    innerMsg.set(message, 64);
    const innerHash = sha1(innerMsg);

    const outerMsg = new Uint8Array(64 + 20);
    outerMsg.set(oPad);
    outerMsg.set(innerHash, 64);
    return sha1(outerMsg);
  }

  function base32ToBytes(b32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = String(b32 || '').toUpperCase().replace(/[=\s-]/g, '');
    let bits = 0, val = 0;
    const bytes = [];
    for (let i = 0; i < clean.length; i++) {
      const idx = alphabet.indexOf(clean[i]);
      if (idx === -1) continue;
      val = (val << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bytes.push((val >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return new Uint8Array(bytes);
  }

  function computeTotp(secret, timeSec = Date.now() / 1000) {
    const keyBytes = base32ToBytes(secret);
    if (keyBytes.length === 0) return '';
    const counter = Math.floor(timeSec / 30);
    const counterBytes = new Uint8Array(8);
    let tmp = counter;
    for (let i = 7; i >= 0; i--) {
      counterBytes[i] = tmp & 0xff;
      tmp = Math.floor(tmp / 256);
    }
    const hmac = hmacSha1(keyBytes, counterBytes);
    const offset = hmac[19] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24) |
                 ((hmac[offset + 1] & 0xff) << 16) |
                 ((hmac[offset + 2] & 0xff) << 8) |
                 (hmac[offset + 3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
  }

  function verifyTotp(inputCode, secret) {
    const clean = String(inputCode || '').replace(/\D/g, '').trim();
    if (clean.length !== 6) return false;
    const now = Date.now() / 1000;
    for (const delta of [-30, 0, 30]) {
      if (clean === computeTotp(secret, now + delta)) {
        return true;
      }
    }
    return false;
  }

  function generateRandomBase32Secret(length = 32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let result = '';
    const randomVals = new Uint8Array(length);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(randomVals);
      for (let i = 0; i < length; i++) {
        result += alphabet[randomVals[i] % alphabet.length];
      }
    } else {
      for (let i = 0; i < length; i++) {
        result += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
    }
    return result;
  }

  function formatSecretDisplay(secret) {
    return String(secret || '').replace(/(.{4})/g, '$1 ').trim();
  }

  // ── Authentication Modal on Page ──
  function openAuthModalOnPage() {
    let modal = document.getElementById('ireps-bot-auth-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'ireps-bot-auth-modal';
      modal.innerHTML = `
        <div id="ireps-bot-auth-card">
          <div class="ireps-bot-auth-icon">🔐</div>
          <h3 class="ireps-bot-auth-heading">Google Authenticator</h3>
          <p class="ireps-bot-auth-subtext">Enter the 6-digit code to initiate LOCK BID</p>
          <input type="text" id="ireps-bot-auth-code-input" maxlength="6" inputmode="numeric" pattern="[0-9]*" placeholder="••••••" autocomplete="off" />
          <div id="ireps-bot-auth-error-msg" class="ireps-bot-auth-error"></div>
          <div class="ireps-bot-auth-modal-btns">
            <button id="ireps-bot-auth-verify-btn" class="ireps-bot-btn ireps-bot-btn-arm" type="button">⚡ Verify & Lock</button>
            <button id="ireps-bot-auth-cancel-btn" class="ireps-bot-btn ireps-bot-btn-disarm" type="button">Cancel</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const input = modal.querySelector('#ireps-bot-auth-code-input');
      const errorMsg = modal.querySelector('#ireps-bot-auth-error-msg');
      const verifyBtn = modal.querySelector('#ireps-bot-auth-verify-btn');
      const cancelBtn = modal.querySelector('#ireps-bot-auth-cancel-btn');

      const doVerify = () => {
        const code = input.value.trim();
        if (code.length !== 6) {
          errorMsg.textContent = 'Please enter all 6 digits';
          return;
        }
        if (verifyTotp(code, totpSecret)) {
          closeAuthModalOnPage();
          log('🔐 Authenticator verified! Starting lock sequence...', 'success');
          startLockSequence();
        } else {
          errorMsg.textContent = '❌ Invalid Authenticator Code';
          input.value = '';
          input.focus();
          log('❌ Invalid authenticator code entered', 'warn');
        }
      };

      verifyBtn.addEventListener('click', doVerify);
      cancelBtn.addEventListener('click', closeAuthModalOnPage);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doVerify();
        if (e.key === 'Escape') closeAuthModalOnPage();
      });
      input.addEventListener('input', () => {
        if (input.value.length === 6) doVerify();
      });
    }

    modal.style.display = 'flex';
    const input = modal.querySelector('#ireps-bot-auth-code-input');
    const errorMsg = modal.querySelector('#ireps-bot-auth-error-msg');
    if (errorMsg) errorMsg.textContent = '';
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 60);
    }
  }

  function closeAuthModalOnPage() {
    const modal = document.getElementById('ireps-bot-auth-modal');
    if (modal) modal.style.display = 'none';
  }

  function renderSetupQrCode() {
    const qrContainer = document.getElementById('ireps-bot-qrcode');
    const secretDisplay = document.getElementById('ireps-bot-secret-display');
    if (secretDisplay) secretDisplay.textContent = formatSecretDisplay(totpSecret);
    if (!qrContainer) return;
    qrContainer.innerHTML = '';
    const uri = `otpauth://totp/Nik-lamb:bidder?secret=${totpSecret}&issuer=Nik-lamb&algorithm=SHA1&digits=6&period=30`;
    if (typeof QRCode !== 'undefined') {
      try {
        new QRCode(qrContainer, {
          text: uri,
          width: 130,
          height: 130,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      } catch (e) {
        console.error('[NL] QR code render error:', e);
      }
    }
  }

  // ═══════════════════════════════════════════════════
  //  STATIC BID LOCK SYSTEM (5s delay -> 15s freeze)
  // ═══════════════════════════════════════════════════

  function blockPageInteraction(e) {
    if (!isLocked) return;
    // Allow interactions inside our bot overlay
    if (overlay && overlay.contains(e.target)) return;
    // Allow clicking the Emergency Unlock button on shield
    if (e.target && (e.target.id === 'ireps-bot-lock-emergency-btn' || e.target.closest?.('#ireps-bot-lock-emergency-btn'))) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return false;
  }

  function startLockSequence() {
    if (lockState !== 'idle') return;

    closeAuthModalOnPage();
    lockState = 'countdown';
    lockCountdownRemaining = lockDelay;
    log('⏳ LOCK INITIATED: Preparing static bid lock...', 'warn');
    updateOverlayStatus();

    if (lockCountdownTimer) clearInterval(lockCountdownTimer);
    lockCountdownTimer = setInterval(() => {
      lockCountdownRemaining--;
      if (lockCountdownRemaining <= 0) {
        clearInterval(lockCountdownTimer);
        lockCountdownTimer = null;
        engageStaticLock();
      }
    }, 1000);
  }

  function cancelLockSequence(reason = 'User cancelled') {
    if (lockCountdownTimer) {
      clearInterval(lockCountdownTimer);
      lockCountdownTimer = null;
    }
    if (lockState === 'locked') {
      releaseStaticLock(reason);
      return;
    }
    lockState = 'idle';
    lockCountdownRemaining = 0;
    log(`⏹️ Lock cancelled: ${reason}`, 'info');
    updateOverlayStatus();
  }

  function engageStaticLock() {
    lockState = 'locked';
    isLocked = true;
    lockDurationRemaining = lockDuration;

    // Inform MAIN world network interceptor
    window.postMessage({ type: 'nl-set-lock', isLocked: true }, '*');

    // Disable all page buttons and inputs (except inside our overlay)
    originalDisabledElements.clear();
    try {
      const pageElements = document.querySelectorAll('button, input, select, textarea');
      pageElements.forEach(el => {
        if (overlay && overlay.contains(el)) return;
        originalDisabledElements.set(el, el.disabled);
        el.disabled = true;
      });
    } catch (err) {
      console.error('[NL] Error disabling page elements:', err);
    }

    // Register capturing event blockers on window & document
    for (const evt of blockedEvents) {
      window.addEventListener(evt, blockPageInteraction, { capture: true, passive: false });
      document.addEventListener(evt, blockPageInteraction, { capture: true, passive: false });
    }

    // Create full-viewport visual freeze shield (no countdown timer on frontend)
    createLockShield();

    log(`🔒 STATIC LOCK ENGAGED! Page is static for ${lockDuration}s. All bids blocked.`, 'alert');
    updateOverlayStatus();

    // Duration timer (runs in background without displaying countdown)
    if (lockDurationTimer) clearInterval(lockDurationTimer);
    lockDurationTimer = setInterval(() => {
      lockDurationRemaining--;
      if (lockDurationRemaining <= 0) {
        clearInterval(lockDurationTimer);
        lockDurationTimer = null;
        releaseStaticLock('Timer finished');
      }
    }, 1000);
  }

  function releaseStaticLock(reason = 'Timer finished') {
    if (lockDurationTimer) {
      clearInterval(lockDurationTimer);
      lockDurationTimer = null;
    }
    if (lockCountdownTimer) {
      clearInterval(lockCountdownTimer);
      lockCountdownTimer = null;
    }

    isLocked = false;
    lockState = 'idle';
    lockCountdownRemaining = 0;
    lockDurationRemaining = 0;

    // Remove visual freeze shield
    removeLockShield();

    // Remove capturing event blockers
    for (const evt of blockedEvents) {
      window.removeEventListener(evt, blockPageInteraction, { capture: true, passive: false });
      document.removeEventListener(evt, blockPageInteraction, { capture: true, passive: false });
    }

    // Restore original disabled state
    originalDisabledElements.forEach((prevDisabled, el) => {
      try {
        if (el && el.isConnected) {
          el.disabled = prevDisabled;
        }
      } catch {}
    });
    originalDisabledElements.clear();

    // Inform MAIN world network interceptor
    window.postMessage({ type: 'nl-set-lock', isLocked: false }, '*');

    // Synchronize next bid reading so stale jumps are ignored
    lastKnownNextBid = readNextBidAmount();

    log(`🔓 STATIC LOCK RELEASED (${reason}). Bidding resumed.`, 'success');
    updateOverlayStatus();
  }

  function createLockShield() {
    removeLockShield();

    lockShield = document.createElement('div');
    lockShield.id = 'ireps-bot-lock-shield';
    document.body.appendChild(lockShield);
  }

  function removeLockShield() {
    if (lockShield) {
      lockShield.remove();
      lockShield = null;
    }
    const existing = document.getElementById('ireps-bot-lock-shield');
    if (existing) existing.remove();
  }

  // ═══════════════════════════════════════════════════
  //  OVERLAY UI — floating control panel on the page
  // ═══════════════════════════════════════════════════

  let overlay = null;
  let logContainer = null;

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'ireps-bot-overlay';
    overlay.innerHTML = `
      <div class="ireps-bot-header">
        <span class="ireps-bot-logo">⚡</span>
        <span class="ireps-bot-title">Nik-lamb</span>
        <button id="ireps-bot-minimize" class="ireps-bot-btn-icon" title="Minimize">─</button>
      </div>
      <div class="ireps-bot-body" id="ireps-bot-body">
        <div class="ireps-bot-status" id="ireps-bot-status">
          <span class="ireps-bot-dot" id="ireps-bot-dot"></span>
          <span id="ireps-bot-status-text">DISARMED</span>
        </div>
        <div class="ireps-bot-info">
          <div class="ireps-bot-info-row">
            <span>Current Bid:</span>
            <span id="ireps-bot-current-bid">—</span>
          </div>
          <div class="ireps-bot-info-row">
            <span>Next Bid:</span>
            <span id="ireps-bot-next-bid">—</span>
          </div>
          <div class="ireps-bot-info-row">
            <span>Bids Placed:</span>
            <span id="ireps-bot-bid-count">0</span>
          </div>
          <div class="ireps-bot-info-row">
            <span>Max Limit:</span>
            <span id="ireps-bot-max-limit">∞</span>
          </div>
        </div>
        <div class="ireps-bot-controls">
          <button id="ireps-bot-arm" class="ireps-bot-btn ireps-bot-btn-arm">⚡ ARM</button>
          <button id="ireps-bot-disarm" class="ireps-bot-btn ireps-bot-btn-disarm" style="display:none;">🛑 DISARM</button>
          <button id="ireps-bot-lock" class="ireps-bot-btn ireps-bot-btn-lock">🔒 LOCK BID</button>
          <button id="ireps-bot-setup" class="ireps-bot-btn ireps-bot-btn-setup">⚙️ Setup</button>
        </div>
        <div class="ireps-bot-setup-panel" id="ireps-bot-setup-panel" style="display:none;">
          <p class="ireps-bot-setup-hint">Click a button below, then click the element on the page.</p>
          <div class="ireps-bot-selector-row">
            <button data-field="currentBidDisplay" class="ireps-bot-sel-btn">📊 Current Bid (display)</button>
            <span class="ireps-bot-sel-status" id="sel-status-currentBidDisplay">❌</span>
          </div>
          <div class="ireps-bot-selector-row">
            <button data-field="nextBidInput" class="ireps-bot-sel-btn">🔔 Next Bid Value (trigger)</button>
            <span class="ireps-bot-sel-status" id="sel-status-nextBidInput">❌</span>
          </div>
          <div class="ireps-bot-selector-row">
            <button data-field="bidAmountInput" class="ireps-bot-sel-btn">✏️ Bid Amount Input (fill)</button>
            <span class="ireps-bot-sel-status" id="sel-status-bidAmountInput">❌</span>
          </div>
          <div class="ireps-bot-selector-row">
            <button data-field="bidButton" class="ireps-bot-sel-btn">🖱️ Submit Button</button>
            <span class="ireps-bot-sel-status" id="sel-status-bidButton">❌</span>
          </div>
          <div class="ireps-bot-input-row">
            <label for="ireps-bot-max-input">Max Bid Limit (₹):</label>
            <input type="number" id="ireps-bot-max-input" placeholder="No limit" />
          </div>
          <div class="ireps-bot-input-row">
            <label for="ireps-bot-max-jump-input">Max Jump Limit (₹):</label>
            <input type="number" id="ireps-bot-max-jump-input" placeholder="No limit" />
          </div>
          <div class="ireps-bot-input-row">
            <label for="ireps-bot-lock-delay-input">Lock Delay (s):</label>
            <input type="number" id="ireps-bot-lock-delay-input" value="5" min="1" max="60" />
          </div>
          <div class="ireps-bot-input-row">
            <label for="ireps-bot-lock-duration-input">Lock Duration (s):</label>
            <input type="number" id="ireps-bot-lock-duration-input" value="15" min="5" max="60" />
          </div>
          <div class="ireps-bot-input-row">
            <label for="ireps-bot-poll-input">Poll Speed (ms):</label>
            <input type="number" id="ireps-bot-poll-input" value="30" min="20" max="2000" />
          </div>

          <!-- Google Authenticator 2FA Setup -->
          <div class="ireps-bot-auth-setup-section">
            <div class="ireps-bot-auth-setup-title">🔐 Google Authenticator (2FA)</div>
            <p class="ireps-bot-setup-hint">Scan with Google Authenticator or enter key:</p>
            <div class="ireps-bot-qr-wrapper">
              <div id="ireps-bot-qrcode" class="ireps-bot-qrcode"></div>
            </div>
            <div class="ireps-bot-secret-box">
              <span id="ireps-bot-secret-display" class="ireps-bot-secret-text"></span>
              <button id="ireps-bot-copy-secret-btn" class="ireps-bot-btn-mini" type="button">📋 Copy</button>
            </div>
            <div class="ireps-bot-auth-test-row">
              <input type="text" id="ireps-bot-test-code-input" maxlength="6" placeholder="Test 6-digit code" />
              <button id="ireps-bot-test-code-btn" class="ireps-bot-btn-mini" type="button">Check</button>
            </div>
            <div id="ireps-bot-test-code-result" class="ireps-bot-auth-test-result"></div>
            <div class="ireps-bot-auth-btn-row">
              <button id="ireps-bot-gen-secret-btn" class="ireps-bot-btn-mini" type="button">🔄 New Secret</button>
            </div>
          </div>

          <button id="ireps-bot-save-config" class="ireps-bot-btn ireps-bot-btn-save">💾 Save Config</button>
        </div>
        <div class="ireps-bot-log" id="ireps-bot-log">
          <div class="ireps-bot-log-header">Activity Log</div>
          <div class="ireps-bot-log-entries" id="ireps-bot-log-entries"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Make overlay draggable
    makeDraggable(overlay, overlay.querySelector('.ireps-bot-header'));

    // Wire up buttons
    overlay.querySelector('#ireps-bot-minimize').addEventListener('click', toggleMinimize);
    overlay.querySelector('#ireps-bot-arm').addEventListener('click', () => setArmed(true));
    overlay.querySelector('#ireps-bot-disarm').addEventListener('click', () => setArmed(false));
    overlay.querySelector('#ireps-bot-lock').addEventListener('click', () => {
      if (lockState === 'idle') {
        openAuthModalOnPage();
      } else if (lockState === 'countdown') {
        cancelLockSequence('Cancelled by user');
      } else if (lockState === 'locked') {
        releaseStaticLock('Emergency unlocked by user');
      }
    });

    // 2FA Setup button listeners
    const copySecretBtn = overlay.querySelector('#ireps-bot-copy-secret-btn');
    if (copySecretBtn) {
      copySecretBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(totpSecret).then(() => {
          copySecretBtn.textContent = '✅ Copied!';
          setTimeout(() => { copySecretBtn.textContent = '📋 Copy'; }, 2000);
        });
      });
    }

    const testCodeBtn = overlay.querySelector('#ireps-bot-test-code-btn');
    const testCodeInput = overlay.querySelector('#ireps-bot-test-code-input');
    const testCodeResult = overlay.querySelector('#ireps-bot-test-code-result');
    if (testCodeBtn && testCodeInput && testCodeResult) {
      testCodeBtn.addEventListener('click', () => {
        const val = testCodeInput.value.trim();
        if (val.length !== 6) {
          testCodeResult.textContent = '⚠️ Enter 6 digits';
          testCodeResult.className = 'ireps-bot-auth-test-result test-warn';
          return;
        }
        if (verifyTotp(val, totpSecret)) {
          testCodeResult.textContent = '✅ Valid Code! Phone is synced.';
          testCodeResult.className = 'ireps-bot-auth-test-result test-success';
        } else {
          testCodeResult.textContent = '❌ Invalid Code. Check phone clock/app.';
          testCodeResult.className = 'ireps-bot-auth-test-result test-error';
        }
      });
    }

    const genSecretBtn = overlay.querySelector('#ireps-bot-gen-secret-btn');
    if (genSecretBtn) {
      genSecretBtn.addEventListener('click', () => {
        totpSecret = generateRandomBase32Secret(32);
        renderSetupQrCode();
        saveConfig();
        log('🔄 Generated new Google Authenticator secret key', 'info');
      });
    }
    overlay.querySelector('#ireps-bot-setup').addEventListener('click', toggleSetupPanel);
    overlay.querySelector('#ireps-bot-save-config').addEventListener('click', saveConfig);

    // Max bid input
    overlay.querySelector('#ireps-bot-max-input').addEventListener('change', (e) => {
      const val = parseFloat(e.target.value);
      maxBidLimit = isNaN(val) || val <= 0 ? Infinity : val;
    });

    // Setup selector buttons
    overlay.querySelectorAll('.ireps-bot-sel-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        startSelectingElement(btn.dataset.field);
      });
    });

    logContainer = overlay.querySelector('#ireps-bot-log-entries');
  }

  function toggleMinimize() {
    const body = overlay.querySelector('#ireps-bot-body');
    const btn = overlay.querySelector('#ireps-bot-minimize');
    if (body.style.display === 'none') {
      body.style.display = '';
      btn.textContent = '─';
    } else {
      body.style.display = 'none';
      btn.textContent = '□';
    }
  }

  function toggleSetupPanel() {
    const panel = overlay.querySelector('#ireps-bot-setup-panel');
    const isShowing = panel.style.display !== 'none';
    panel.style.display = isShowing ? 'none' : 'block';
    if (!isShowing) {
      renderSetupQrCode();
    }
  }

  function updateOverlayStatus() {
    const dot = document.getElementById('ireps-bot-dot');
    const text = document.getElementById('ireps-bot-status-text');
    const armBtn = document.getElementById('ireps-bot-arm');
    const disarmBtn = document.getElementById('ireps-bot-disarm');
    const lockBtn = document.getElementById('ireps-bot-lock');

    if (!dot || !text) return;

    if (isArmed) {
      dot.className = 'ireps-bot-dot ireps-bot-dot-armed';
      text.textContent = 'ARMED — WATCHING';
      if (armBtn) armBtn.style.display = 'none';
      if (disarmBtn) disarmBtn.style.display = '';
    } else {
      dot.className = 'ireps-bot-dot ireps-bot-dot-disarmed';
      text.textContent = 'DISARMED';
      if (armBtn) armBtn.style.display = '';
      if (disarmBtn) disarmBtn.style.display = 'none';
    }

    if (lockBtn) {
      lockBtn.className = 'ireps-bot-btn ireps-bot-btn-lock';
      lockBtn.textContent = '🔒 LOCK BID';
    }

    const limitEl = document.getElementById('ireps-bot-max-limit');
    if (limitEl) limitEl.textContent = maxBidLimit === Infinity ? '∞' : `₹${maxBidLimit.toLocaleString('en-IN')}`;
  }

  function updateOverlayCurrentBid(current, next) {
    const curEl = document.getElementById('ireps-bot-current-bid');
    const nextEl = document.getElementById('ireps-bot-next-bid');
    const countEl = document.getElementById('ireps-bot-bid-count');
    if (curEl) curEl.textContent = current !== null ? `₹${current.toLocaleString('en-IN')}` : '—';
    if (nextEl) nextEl.textContent = next !== null ? `₹${next.toLocaleString('en-IN')}` : '—';
    if (countEl) countEl.textContent = bidCount;
  }

  function updateOverlayLog(entry) {
    if (!logContainer) return;
    const div = document.createElement('div');
    div.className = `ireps-bot-log-entry ireps-bot-log-${entry.type}`;
    div.textContent = `[${entry.time}] ${entry.msg}`;
    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  // ── Draggable ──
  function makeDraggable(element, handle) {
    let offsetX = 0, offsetY = 0, isDragging = false;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      offsetX = e.clientX - element.getBoundingClientRect().left;
      offsetY = e.clientY - element.getBoundingClientRect().top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      element.style.left = (e.clientX - offsetX) + 'px';
      element.style.top = (e.clientY - offsetY) + 'px';
      element.style.right = 'auto';
      element.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  // ═══════════════════════════════════════════════
  //  ELEMENT SELECTOR MODE (point-and-click setup)
  // ═══════════════════════════════════════════════

  function startSelectingElement(field) {
    isSelectingMode = true;
    selectingField = field;
    document.body.style.cursor = 'crosshair';
    log(`🎯 Click on the "${field}" element on the page...`, 'info');

    // Add highlight on hover
    document.addEventListener('mouseover', onHoverHighlight, true);
    document.addEventListener('mouseout', onHoverUnhighlight, true);
    document.addEventListener('click', onSelectElement, true);
  }

  function onHoverHighlight(e) {
    if (!isSelectingMode) return;
    if (overlay && overlay.contains(e.target)) return;

    if (highlightedEl) highlightedEl.style.outline = '';
    highlightedEl = e.target;
    highlightedEl.style.outline = '3px solid #00ff88';
  }

  function onHoverUnhighlight(e) {
    if (highlightedEl) highlightedEl.style.outline = '';
  }

  function onSelectElement(e) {
    if (!isSelectingMode) return;
    if (overlay && overlay.contains(e.target)) return;

    e.preventDefault();
    e.stopPropagation();

    const target = e.target;
    const selector = generateSelector(target);

    if (!selectorConfig) selectorConfig = { ...DEFAULT_SELECTORS };
    selectorConfig[selectingField] = selector;

    log(`✅ ${selectingField} = "${selector}"`, 'success');

    // Update status icon
    const statusEl = document.getElementById(`sel-status-${selectingField}`);
    if (statusEl) statusEl.textContent = '✅';

    // Cleanup
    if (highlightedEl) highlightedEl.style.outline = '';
    document.body.style.cursor = '';
    document.removeEventListener('mouseover', onHoverHighlight, true);
    document.removeEventListener('mouseout', onHoverUnhighlight, true);
    document.removeEventListener('click', onSelectElement, true);
    isSelectingMode = false;
    selectingField = null;
  }

  // ── Generate a CSS selector for an element ──
  function generateSelector(el) {
    // Prefer ID
    if (el.id) return `#${CSS.escape(el.id)}`;

    // Try name attribute (common in form elements)
    if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;

    // Build a path using nth-child
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).filter(c => c.length > 0 && !c.startsWith('ireps-bot'));
        if (classes.length > 0) {
          selector += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  // ── Save config to chrome.storage ──
  function saveConfig() {
    const maxInput = document.getElementById('ireps-bot-max-input');
    const maxJumpInput = document.getElementById('ireps-bot-max-jump-input');
    const pollInput = document.getElementById('ireps-bot-poll-input');
    const delayInput = document.getElementById('ireps-bot-lock-delay-input');
    const durationInput = document.getElementById('ireps-bot-lock-duration-input');

    const val = parseFloat(maxInput.value);
    maxBidLimit = isNaN(val) || val <= 0 ? Infinity : val;

    const jumpVal = parseFloat(maxJumpInput?.value);
    maxJumpLimit = isNaN(jumpVal) || jumpVal <= 0 ? Infinity : jumpVal;

    const delayVal = parseInt(delayInput?.value);
    lockDelay = isNaN(delayVal) || delayVal <= 0 ? 5 : delayVal;

    const durationVal = parseInt(durationInput?.value);
    lockDuration = isNaN(durationVal) || durationVal <= 0 ? 15 : durationVal;

    const pollSpeed = parseInt(pollInput.value) || 100;

    const config = {
      selectors: selectorConfig,
      maxBidLimit: maxBidLimit === Infinity ? null : maxBidLimit,
      maxJumpLimit: maxJumpLimit === Infinity ? null : maxJumpLimit,
      lockDelay,
      lockDuration,
      totpSecret,
      pollSpeed
    };

    chrome.storage.local.set({ nlConfig: config }, () => {
      log('💾 Configuration saved!', 'success');
      updateOverlayStatus();
    });
  }

  // ── Load config from chrome.storage ──
  function loadConfig(callback) {
    chrome.storage.local.get(['nlConfig', 'isArmed'], (data) => {
      if (data.nlConfig) {
        selectorConfig = data.nlConfig.selectors || { ...DEFAULT_SELECTORS };
        maxBidLimit = data.nlConfig.maxBidLimit || Infinity;
        maxJumpLimit = data.nlConfig.maxJumpLimit || Infinity;
        lockDelay = data.nlConfig.lockDelay || 5;
        lockDuration = data.nlConfig.lockDuration || 15;
        totpSecret = data.nlConfig.totpSecret || 'SKP63DSLYZ4MH6DY4FM5WNQJW2RLK5NK';

        // Render QR in setup
        renderSetupQrCode();

        // Update UI
        const maxInput = document.getElementById('ireps-bot-max-input');
        if (maxInput && maxBidLimit !== Infinity) maxInput.value = maxBidLimit;

        const maxJumpInput = document.getElementById('ireps-bot-max-jump-input');
        if (maxJumpInput && maxJumpLimit !== Infinity) maxJumpInput.value = maxJumpLimit;

        const delayInput = document.getElementById('ireps-bot-lock-delay-input');
        if (delayInput) delayInput.value = lockDelay;

        const durationInput = document.getElementById('ireps-bot-lock-duration-input');
        if (durationInput) durationInput.value = lockDuration;

        const pollInput = document.getElementById('ireps-bot-poll-input');
        if (pollInput) pollInput.value = data.nlConfig.pollSpeed || 100;

        // Update selector status icons
        for (const field of ['currentBidDisplay', 'nextBidInput', 'bidAmountInput', 'bidButton']) {
          const statusEl = document.getElementById(`sel-status-${field}`);
          if (statusEl) statusEl.textContent = selectorConfig[field] ? '✅' : '❌';
        }

        log('📂 Config loaded from storage', 'info');
      }

      if (callback) callback(data);
    });
  }

  // ── Listen for messages from popup ──
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getStatus') {
      sendResponse({
        isArmed,
        bidCount,
        maxBidLimit: maxBidLimit === Infinity ? null : maxBidLimit,
        maxJumpLimit: maxJumpLimit === Infinity ? null : maxJumpLimit,
        currentBid: readCurrentBidForDisplay(),
        nextBid: readNextBidAmount(),
        configured: !!(selectorConfig?.nextBidInput && selectorConfig?.bidAmountInput && selectorConfig?.bidButton),
        lockState,
        isLocked,
        lockCountdownRemaining,
        lockDurationRemaining,
        totpSecret,
        totpFormatted: formatSecretDisplay(totpSecret)
      });
    } else if (message.action === 'arm') {
      setArmed(true);
      sendResponse({ ok: true });
    } else if (message.action === 'disarm') {
      setArmed(false);
      sendResponse({ ok: true });
    } else if (message.action === 'setMaxLimit') {
      maxBidLimit = message.value || Infinity;
      updateOverlayStatus();
      sendResponse({ ok: true });
    } else if (message.action === 'verifyAndLock') {
      if (verifyTotp(message.code, totpSecret)) {
        startLockSequence();
        sendResponse({ ok: true, lockState });
      } else {
        sendResponse({ ok: false, error: 'Invalid authenticator code' });
      }
    } else if (message.action === 'triggerLock') {
      startLockSequence();
      sendResponse({ ok: true, lockState });
    } else if (message.action === 'cancelLock') {
      cancelLockSequence('Cancelled from popup');
      sendResponse({ ok: true, lockState });
    } else if (message.action === 'toggleLock') {
      if (lockState === 'idle') {
        openAuthModalOnPage();
      } else if (lockState === 'countdown') {
        cancelLockSequence('Cancelled by user');
      } else if (lockState === 'locked') {
        releaseStaticLock('Emergency unlocked by user');
      }
      sendResponse({ ok: true, lockState });
    }
    return true;
  });

  // ═══════════════════════════════════
  //  INIT
  // ═══════════════════════════════════

  function init() {
    createOverlay();
    loadConfig((data) => {
      log('🚀 Nik-lamb loaded!', 'success');
      log('⚙️ Click "Setup" to configure element selectors.', 'info');

      // Check if selectors are configured
      if (selectorConfig?.nextBidInput && selectorConfig?.bidAmountInput && selectorConfig?.bidButton) {
        log('✅ Selectors configured. Ready to arm.', 'success');
      } else {
        log('⚠️ Selectors not configured. Use Setup to point at page elements.', 'warn');
      }
    });
  }

  // Wait for page to be fully ready
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }

})();
