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
  let lastKnownBid = null;
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

  // ── Default selector hints (user will configure these) ──
  const DEFAULT_SELECTORS = {
    currentBidDisplay: '', // Element showing the current highest bid
    nextBidInput: '',      // Input field with the next valid bid amount
    bidButton: '',         // The submit/place bid button
    extraInfo: ''         // Optional: who placed the last entry
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

  // ── Core: Read current bid from page ──
  function readCurrentBid() {
    if (!selectorConfig?.currentBidDisplay) return null;
    const el = getEl(selectorConfig.currentBidDisplay);
    if (!el) return null;
    const text = el.value !== undefined && el.value !== '' ? el.value : el.textContent;
    return extractNumber(text);
  }

  // ── Core: Read next bid amount (pre-filled by the page) ──
  function readNextBidAmount() {
    if (!selectorConfig?.nextBidInput) return null;
    const el = getEl(selectorConfig.nextBidInput);
    if (!el) return null;
    // Could be an input or a span/div
    const text = el.value !== undefined && el.value !== '' ? el.value : el.textContent;
    return extractNumber(text);
  }

  // ── Core: Click the bid button ──
  function clickBidButton() {
    if (!selectorConfig?.bidButton) return false;
    const btn = getEl(selectorConfig.bidButton);
    if (!btn) {
      log('❌ Bid button not found!', 'error');
      return false;
    }
    if (btn.disabled) {
      log('⚠️ Bid button is disabled, skipping', 'warn');
      return false;
    }
    btn.click();
    return true;
  }

  // ── Core: The bid check logic ──
  function checkAndBid(source = 'poll') {
    if (!isArmed) return;

    const currentBid = readCurrentBid();
    const nextBidAmount = readNextBidAmount();

    if (currentBid === null) return;

    // Detect if bid changed
    if (lastKnownBid !== null && currentBid !== lastKnownBid) {
      log(`🔔 Bid changed! ${lastKnownBid} → ${currentBid} [via ${source}]`, 'alert');

      // Check if next bid exceeds our max limit
      if (nextBidAmount !== null && nextBidAmount > maxBidLimit) {
        log(`🛑 Next bid ₹${nextBidAmount} exceeds max limit ₹${maxBidLimit}. STOPPING.`, 'warn');
        setArmed(false);
        updateOverlayStatus();
        return;
      }

      // ACT NOW!
      log(`⚡ Acting! Placing entry: ₹${nextBidAmount || '(page default)'}`, 'bid');
      const clicked = clickBidButton();
      if (clicked) {
        bidCount++;
        log(`✅ Bid #${bidCount} placed successfully!`, 'success');

        // Confirmation dialog is handled by the dedicated confirmObserver
        // which fires the instant a modal/dialog enters the DOM — no delay.
      }
    }

    lastKnownBid = currentBid;
    updateOverlayCurrentBid(currentBid, nextBidAmount);
  }

  // ── Network Intercept: Listen for bid data from MAIN world interceptor ──
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'nl-intercept') return;
    if (!isArmed) return;

    const payload = event.data.payload;
    const now = Date.now();

    // Debounce: skip if we just processed a network event <20ms ago
    if (now - lastNetworkBidTimestamp < 20) return;
    lastNetworkBidTimestamp = now;

    log(`📡 Network intercept [${payload.source}]: ${payload.url?.substring(0, 60)}...`, 'info');

    // The page may not have updated the DOM yet — use requestAnimationFrame
    // to check on the very next render frame (typically <16ms)
    requestAnimationFrame(() => {
      checkAndBid('network');
    });
  });

  // ── Handle confirmation popups/modals ──
  function handleConfirmationDialog() {
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

  // ── MutationObserver: Watch for DOM changes on bid element ──
  function startObserver() {
    if (observer) observer.disconnect();

    // Try to observe just the bid display element for precision
    let target = null;
    if (selectorConfig?.currentBidDisplay) {
      target = getEl(selectorConfig.currentBidDisplay);
    }

    observer = new MutationObserver((mutations) => {
      if (!isArmed) return;
      checkAndBid('mutation');
    });

    if (target) {
      // Targeted: observe only the bid element and its subtree
      observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['value', 'textContent', 'innerHTML']
      });
      log('👁️ MutationObserver started (targeted on bid element)', 'info');
    } else {
      // Fallback: observe entire body if bid element not found yet
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['value', 'textContent', 'innerHTML']
      });
      log('👁️ MutationObserver started (full body — bid element not found)', 'info');
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
    // Only react if we're armed and just placed a bid
    if (!isArmed || bidCount === 0) return;

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
      lastKnownBid = readCurrentBid();
      log(`🟢 ARMED! Watching for bid changes. Current bid: ₹${lastKnownBid || 'unknown'}`, 'success');
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
    // Persist state
    chrome.storage.local.set({ isArmed: armed });
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
          <button id="ireps-bot-setup" class="ireps-bot-btn ireps-bot-btn-setup">⚙️ Setup</button>
        </div>
        <div class="ireps-bot-setup-panel" id="ireps-bot-setup-panel" style="display:none;">
          <p class="ireps-bot-setup-hint">Click a button below, then click the element on the page.</p>
          <div class="ireps-bot-selector-row">
            <button data-field="currentBidDisplay" class="ireps-bot-sel-btn">📊 Current Bid Element</button>
            <span class="ireps-bot-sel-status" id="sel-status-currentBidDisplay">❌</span>
          </div>
          <div class="ireps-bot-selector-row">
            <button data-field="nextBidInput" class="ireps-bot-sel-btn">💰 Next Bid Input</button>
            <span class="ireps-bot-sel-status" id="sel-status-nextBidInput">❌</span>
          </div>
          <div class="ireps-bot-selector-row">
            <button data-field="bidButton" class="ireps-bot-sel-btn">🖱️ Bid Button</button>
            <span class="ireps-bot-sel-status" id="sel-status-bidButton">❌</span>
          </div>
          <div class="ireps-bot-input-row">
            <label for="ireps-bot-max-input">Max Bid Limit (₹):</label>
            <input type="number" id="ireps-bot-max-input" placeholder="No limit" />
          </div>
          <div class="ireps-bot-input-row">
            <label for="ireps-bot-poll-input">Poll Speed (ms):</label>
            <input type="number" id="ireps-bot-poll-input" value="30" min="20" max="2000" />
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
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }

  function updateOverlayStatus() {
    const dot = document.getElementById('ireps-bot-dot');
    const text = document.getElementById('ireps-bot-status-text');
    const armBtn = document.getElementById('ireps-bot-arm');
    const disarmBtn = document.getElementById('ireps-bot-disarm');

    if (isArmed) {
      dot.className = 'ireps-bot-dot ireps-bot-dot-armed';
      text.textContent = 'ARMED — WATCHING';
      armBtn.style.display = 'none';
      disarmBtn.style.display = '';
    } else {
      dot.className = 'ireps-bot-dot ireps-bot-dot-disarmed';
      text.textContent = 'DISARMED';
      armBtn.style.display = '';
      disarmBtn.style.display = 'none';
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
    const pollInput = document.getElementById('ireps-bot-poll-input');

    const val = parseFloat(maxInput.value);
    maxBidLimit = isNaN(val) || val <= 0 ? Infinity : val;

    const pollSpeed = parseInt(pollInput.value) || 100;

    const config = {
      selectors: selectorConfig,
      maxBidLimit: maxBidLimit === Infinity ? null : maxBidLimit,
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

        // Update UI
        const maxInput = document.getElementById('ireps-bot-max-input');
        if (maxInput && maxBidLimit !== Infinity) maxInput.value = maxBidLimit;

        const pollInput = document.getElementById('ireps-bot-poll-input');
        if (pollInput) pollInput.value = data.nlConfig.pollSpeed || 100;

        // Update selector status icons
        for (const field of ['currentBidDisplay', 'nextBidInput', 'bidButton']) {
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
        currentBid: readCurrentBid(),
        nextBid: readNextBidAmount(),
        configured: !!(selectorConfig?.currentBidDisplay && selectorConfig?.bidButton)
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
      if (selectorConfig?.currentBidDisplay && selectorConfig?.bidButton) {
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
