/* ============================================================
   Nik-lamb — Network Interceptor (MAIN world)
   
   This script runs in the PAGE's JS context (not the extension's
   isolated world). It intercepts XHR responses to detect data 
   changes BEFORE the DOM updates.
   
   Communication: window.postMessage → content.js listener
   
   Target endpoints (DWR framework):
   - BiddingAjaxRequestProcessor.handle  (active polling)
   - ReverseAjax.dwr                     (server push / comet)
   ============================================================ */

(function () {
  'use strict';

  if (window.__NL_INTERCEPTOR_LOADED__) return;
  window.__NL_INTERCEPTOR_LOADED__ = true;

  const SIGNATURE = 'nl-intercept';

  // ── Known DWR endpoints from IREPS ──
  const PRIORITY_ENDPOINTS = [
    'BiddingAjaxRequestProcessor',
    'ReverseAjax.dwr'
  ];

  const GENERAL_PATTERNS = [
    'bid', 'auction', 'eauction', 'lot',
    'currentprice', 'highestbid'
  ];

  // ── Track last seen values to detect actual changes ──
  let lastResponseHash = '';

  // ── Fast hash for change detection ──
  function quickHash(str) {
    let hash = 0;
    const len = Math.min(str.length, 2000);
    for (let i = 0; i < len; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }

  // ── Check if URL is a priority DWR endpoint ──
  function isPriorityEndpoint(url) {
    if (!url) return false;
    return PRIORITY_ENDPOINTS.some(p => url.includes(p));
  }

  // ── Check if URL or response is generally relevant ──
  function isRelevant(url, responseText) {
    if (!url && !responseText) return false;
    const urlStr = (url || '').toLowerCase();
    const bodyStr = (responseText || '').substring(0, 1000).toLowerCase();
    return GENERAL_PATTERNS.some(p => urlStr.includes(p) || bodyStr.includes(p));
  }

  // ── Parse DWR response format ──
  // DWR responses look like:
  //   //#DWR-INSERT
  //   //#DWR-REPLY
  //   dwr.engine._remoteHandleCallback('batchId','callId', data);
  // Or for reverse ajax, they may contain script execution calls
  function parseDwrResponse(responseText) {
    if (!responseText) return null;

    const result = {
      isDwr: false,
      callbacks: [],
      rawValues: [],
      hasDataChange: false
    };

    // Check if it's a DWR response
    if (responseText.includes('//#DWR') || responseText.includes('dwr.engine')) {
      result.isDwr = true;
    }

    // Extract callback data — these contain the actual bid values
    // Pattern: dwr.engine._remoteHandleCallback('id','id', { ... });
    // Or: dwr.engine._remoteHandleCallback('id','id', "value");
    const callbackRegex = /dwr\.engine\._remoteHandleCallback\([^)]+\)/g;
    const matches = responseText.match(callbackRegex);
    if (matches) {
      result.callbacks = matches;
    }

    // Extract any numeric values that could be bid amounts
    // Look for patterns like: s0.bidRate=10; or s0.currentBidRate=15.5;
    const valueRegex = /\b(?:bid|rate|price|amount|current|highest)\w*\s*[=:]\s*["']?([\d,.]+)["']?/gi;
    let match;
    while ((match = valueRegex.exec(responseText)) !== null) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(val) && val > 0) {
        result.rawValues.push(val);
      }
    }

    // Also extract from DWR property assignments: s0.propertyName=value;
    const dwrPropRegex = /s\d+\.(\w*(?:bid|rate|price|amount)\w*)\s*=\s*["']?([\d,.]+)["']?/gi;
    while ((match = dwrPropRegex.exec(responseText)) !== null) {
      const val = parseFloat(match[2].replace(/,/g, ''));
      if (!isNaN(val) && val > 0) {
        result.rawValues.push(val);
      }
    }

    return result;
  }

  // ── Post intercepted data to content script ──
  function postInterceptedData(url, responseText, source, priority) {
    try {
      const hash = quickHash(responseText || '');
      const isNewData = hash !== lastResponseHash;
      lastResponseHash = hash;

      const dwrData = parseDwrResponse(responseText);

      window.postMessage({
        type: SIGNATURE,
        payload: {
          url: url,
          source: source,
          priority: priority, // 'high' for known DWR endpoints
          timestamp: Date.now(),
          isNewData: isNewData,
          dwrValues: dwrData?.rawValues || [],
          isDwr: dwrData?.isDwr || false,
          rawText: responseText?.substring(0, 3000)
        }
      }, '*');
    } catch {
      // Silently fail — don't break the page
    }
  }

  // ═══════════════════════════════════════════
  //  PATCH XMLHttpRequest
  // ═══════════════════════════════════════════

  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (method, url, ...args) {
    this._nlMethod = method;
    this._nlUrl = url;
    return origOpen.call(this, method, url, ...args);
  };

  OrigXHR.prototype.send = function (...args) {
    const xhr = this;

    xhr.addEventListener('load', function () {
      try {
        const url = xhr._nlUrl || '';
        const responseText = xhr.responseText || '';

        // Priority: known DWR endpoints — always process
        if (isPriorityEndpoint(url)) {
          postInterceptedData(url, responseText, 'xhr', 'high');
          return;
        }

        // General: check if content seems relevant
        if (isRelevant(url, responseText)) {
          postInterceptedData(url, responseText, 'xhr', 'low');
        }
      } catch {
        // Never break the page
      }
    });

    return origSend.call(this, ...args);
  };

  // ═══════════════════════════════════════════
  //  PATCH fetch()
  // ═══════════════════════════════════════════

  const origFetch = window.fetch;

  window.fetch = function (input, init) {
    const url = typeof input === 'string'
      ? input
      : (input instanceof Request ? input.url : String(input));

    return origFetch.call(this, input, init).then(response => {
      const clone = response.clone();

      clone.text().then(text => {
        if (isPriorityEndpoint(url)) {
          postInterceptedData(url, text, 'fetch', 'high');
        } else if (isRelevant(url, text)) {
          postInterceptedData(url, text, 'fetch', 'low');
        }
      }).catch(() => {});

      return response;
    });
  };

  // ═══════════════════════════════════════════
  //  PATCH WebSocket
  // ═══════════════════════════════════════════

  const OrigWebSocket = window.WebSocket;

  if (OrigWebSocket) {
    window.WebSocket = function (url, protocols) {
      const ws = protocols
        ? new OrigWebSocket(url, protocols)
        : new OrigWebSocket(url);

      ws.addEventListener('message', function (event) {
        try {
          const data = typeof event.data === 'string' ? event.data : '';
          if (isPriorityEndpoint(url) || isRelevant(url, data)) {
            postInterceptedData(url, data, 'websocket', 'high');
          }
        } catch {}
      });

      return ws;
    };

    window.WebSocket.prototype = OrigWebSocket.prototype;
    window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    window.WebSocket.OPEN = OrigWebSocket.OPEN;
    window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
    window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
  }

  console.log('[NL] Network interceptor active (XHR + fetch + WebSocket)');
})();
