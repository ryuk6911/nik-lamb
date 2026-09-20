/* ============================================================
   Nik-lamb — Network Interceptor (MAIN world)
   
   This script runs in the PAGE's JS context (not the extension's
   isolated world). It intercepts XHR and fetch responses to detect
   bid-related data changes BEFORE the DOM updates.
   
   Communication: window.postMessage → content.js listener
   ============================================================ */

(function () {
  'use strict';

  if (window.__NL_INTERCEPTOR_LOADED__) return;
  window.__NL_INTERCEPTOR_LOADED__ = true;

  const SIGNATURE = 'nl-intercept';

  // ── Utility: Extract numbers that look like bid amounts ──
  function extractBidCandidates(text) {
    if (!text || typeof text !== 'string') return [];
    // Match numbers that could be bid amounts (Indian format with optional commas)
    const matches = text.match(/[\d,]+\.?\d*/g);
    if (!matches) return [];
    return matches
      .map(m => parseFloat(m.replace(/,/g, '')))
      .filter(n => !isNaN(n) && n > 0);
  }

  // ── Utility: Check if URL or response might be bid-related ──
  function isBidRelated(url, responseText) {
    if (!url && !responseText) return false;

    const urlStr = (url || '').toLowerCase();
    const bodyStr = (responseText || '').toLowerCase();

    // URL pattern matching — common endpoint patterns
    const urlPatterns = [
      'bid', 'auction', 'eauction', 'lot', 'tender',
      'current_price', 'currentprice', 'highestbid',
      'getbid', 'fetchbid', 'bidinfo', 'biddetail',
      'refresh', 'update', 'poll', 'status',
      'ajax', 'async', 'json'
    ];

    const urlMatch = urlPatterns.some(p => urlStr.includes(p));

    // Response body pattern matching
    const bodyPatterns = [
      'bid', 'amount', 'price', 'current', 'highest',
      'auction', 'lot', 'bidder', 'increment'
    ];

    const bodyMatch = bodyPatterns.some(p => bodyStr.includes(p));

    // Return true if URL matches, or if body contains bid-like content
    return urlMatch || bodyMatch;
  }

  // ── Post intercepted data to content script ──
  function postInterceptedData(url, responseText, source) {
    try {
      let parsedData = null;

      // Try parsing as JSON first
      try {
        parsedData = JSON.parse(responseText);
      } catch {
        // Not JSON — could be HTML fragment or plain text
        parsedData = null;
      }

      window.postMessage({
        type: SIGNATURE,
        payload: {
          url: url,
          source: source, // 'xhr' or 'fetch'
          timestamp: Date.now(),
          rawText: responseText?.substring(0, 5000), // Cap at 5KB
          parsed: parsedData,
          bidCandidates: extractBidCandidates(responseText)
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
    this.addEventListener('load', function () {
      try {
        const url = this._nlUrl || '';
        const responseText = this.responseText || '';

        if (isBidRelated(url, responseText)) {
          postInterceptedData(url, responseText, 'xhr');
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
      // Clone so the original consumer can still read the body
      const clone = response.clone();

      clone.text().then(text => {
        if (isBidRelated(url, text)) {
          postInterceptedData(url, text, 'fetch');
        }
      }).catch(() => {});

      return response;
    });
  };

  // ═══════════════════════════════════════════
  //  PATCH WebSocket (in case NL uses WS)
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
          if (isBidRelated(url, data)) {
            postInterceptedData(url, data, 'websocket');
          }
        } catch {}
      });

      return ws;
    };

    // Preserve prototype chain
    window.WebSocket.prototype = OrigWebSocket.prototype;
    window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    window.WebSocket.OPEN = OrigWebSocket.OPEN;
    window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
    window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
  }

  console.log('[NL] Network interceptor active (XHR + fetch + WebSocket)');
})();
