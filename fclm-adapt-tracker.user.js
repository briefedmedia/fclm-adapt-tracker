// ==UserScript==
// @name         Should I Code? 🤔
// @namespace    https://fclm-adapt-tracker
// @version      1.0.0
// @author       Micah Griffth | Area Manager II | HDC3
// @description  Collaborative AA status tracking for HDC3 warehouse managers
// @match        https://fclm-portal.amazon.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      firebaseio.com
// @connect      fclm-adapt-tracker-default-rtdb.firebaseio.com
// @updateURL    https://raw.githubusercontent.com/briefedmedia/fclm-adapt-tracker/main/fclm-adapt-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/briefedmedia/fclm-adapt-tracker/main/fclm-adapt-tracker.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── Configuration ───────────────────────────────────────────────
  const FIREBASE_DB_URL = 'https://fclm-adapt-tracker-default-rtdb.firebaseio.com';
  const WAREHOUSE_ID = 'HDC3';
  const POLL_INTERVAL_MS = 10000;
  const DEBUG = true;
  const CONTENT_WAIT_INTERVAL = 500;
  const CONTENT_WAIT_MAX = 30;
  const CLEANUP_HOURS = 48;
  const DEBOUNCE_MS = 800;

  // ─── Status Definitions ──────────────────────────────────────────
  const STATUSES = {
    stu_pending: { key: 'stu_pending', label: 'STU Pending', bg: '#fff3cd', border: '#ffc107', icon: '\u23F3', priority: 2 },
    stu_complete: { key: 'stu_complete', label: 'STU Complete', bg: '#ffe0b2', border: '#ff9800', icon: '\u2705', priority: 3 },
    writeup: { key: 'writeup', label: 'Write-Up', bg: '#f8d7da', border: '#dc3545', icon: '\u270D\uFE0F', priority: 1 },
    resolved: { key: 'resolved', label: 'Resolved', bg: '#d1e7dd', border: '#198754', icon: '\u2714\uFE0F', priority: 4 },
  };

  // ─── State ───────────────────────────────────────────────────────
  let managerAlias = '';
  let currentMarkings = {};
  let detectedEmployees = {};
  let pollTimer = null;
  let isFirstPoll = true;
  let currentDateKey = '';
  let currentPageType = '';
  let pendingRemoteChanges = false;
  let firebaseConnected = false;

  // ─── Utility Functions ───────────────────────────────────────────

  function sanitizeKey(id) {
    return String(id).replace(/[.#$/\[\]]/g, '_');
  }

  function getDateKey() {
    const params = new URLSearchParams(window.location.search);
    const dateStr = params.get('startDateIntraday') || params.get('startDateDay');
    if (dateStr) {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10);
      }
    }
    return new Date().toISOString().slice(0, 10);
  }

  function detectPageType() {
    const path = window.location.pathname;
    if (path.includes('/reports/functionRollup')) return 'functionRollup';
    if (path.includes('/employee/ppaTimeDetails')) return 'ppaProfile';
    if (path.includes('/employee/timeDetails')) return 'pprProfile';
    if (path.includes('/reports/ppaTimeOnTask')) return 'totPPA';
    if (path.includes('/reports/timeOnTask')) return 'totPPR';
    if (path.includes('/employee/')) return 'profile';
    if (path.includes('/reports/')) return 'table';
    return 'unknown';
  }

  function isProfilePage() {
    return ['pprProfile', 'ppaProfile', 'profile'].includes(currentPageType);
  }

  function isTablePage() {
    return ['functionRollup', 'totPPR', 'totPPA', 'table'].includes(currentPageType);
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '\u2026' : str;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function log(...args) {
    if (DEBUG) console.log('[FCLM Tracker]', ...args);
  }

  // ─── Link Classification (for dedup: login > name > id) ────────
  // Classifies a link's text to determine priority for button injection.
  // login = lowercase no spaces, not pure digits (e.g. "jsmith")
  // name  = contains a space (e.g. "John Smith")
  // id    = pure digits or fallback (e.g. "202303565")
  function classifyLinkText(text) {
    if (!text) return 'id';
    text = text.trim();
    if (!text) return 'id';
    if (/^\d+$/.test(text)) return 'id';
    if (/\s/.test(text)) return 'name';
    return 'login'; // no spaces, not pure digits = login
  }

  const LINK_PRIORITY = { login: 1, name: 2, id: 3 };

  // Pick the best link for a given employee within a specific row.
  // Returns the single link that should get the mark button.
  function pickPrimaryLink(emp, row) {
    const candidates = row
      ? emp.links.filter(l => l.closest && l.closest('tr') === row)
      : emp.links;
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    candidates.sort((a, b) => {
      const pa = LINK_PRIORITY[classifyLinkText(a.textContent)] || 3;
      const pb = LINK_PRIORITY[classifyLinkText(b.textContent)] || 3;
      return pa - pb;
    });
    return candidates[0];
  }

  // ─── Firebase REST API ───────────────────────────────────────────

  function firebaseRequest(method, path, data) {
    return new Promise((resolve) => {
      const url = `${FIREBASE_DB_URL}${path}.json`;
      log(`Firebase ${method} ${path}`);
      const opts = {
        method,
        url,
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            firebaseConnected = true;
            updateConnectionStatus(true);
            try {
              resolve(JSON.parse(res.responseText));
            } catch {
              resolve(null);
            }
          } else {
            log(`Firebase error: ${res.status} ${res.statusText}`, res.responseText);
            firebaseConnected = false;
            updateConnectionStatus(false);
            resolve(null);
          }
        },
        onerror(err) {
          log('Firebase network error:', err);
          firebaseConnected = false;
          updateConnectionStatus(false);
          resolve(null);
        },
        ontimeout() {
          log('Firebase timeout');
          firebaseConnected = false;
          updateConnectionStatus(false);
          resolve(null);
        },
      };
      if (data !== undefined) opts.data = JSON.stringify(data);
      GM_xmlhttpRequest(opts);
    });
  }

  function getMarkingsPath() {
    return `/${WAREHOUSE_ID}/markings/${currentDateKey}`;
  }

  async function fetchMarkings() {
    const data = await firebaseRequest('GET', getMarkingsPath());
    return data || {};
  }

  async function saveMarking(empId, marking) {
    const key = sanitizeKey(empId);
    const result = await firebaseRequest('PUT', `${getMarkingsPath()}/${key}`, marking);
    if (result) {
      log('Marking saved successfully:', key, result);
    } else {
      log('WARNING: Marking may not have saved for', key);
      showToast('Warning: Could not save to server. Check connection.');
    }
    return result;
  }

  async function deleteMarking(empId) {
    const key = sanitizeKey(empId);
    return firebaseRequest('DELETE', `${getMarkingsPath()}/${key}`);
  }

  async function cleanupOldMarkings() {
    const data = await firebaseRequest('GET', `/${WAREHOUSE_ID}/markings`);
    if (!data) return;
    const now = Date.now();
    const cutoff = CLEANUP_HOURS * 60 * 60 * 1000;
    for (const dateKey of Object.keys(data)) {
      const dateTs = new Date(dateKey + 'T00:00:00').getTime();
      if (now - dateTs > cutoff) {
        log('Cleaning up old date key:', dateKey);
        await firebaseRequest('DELETE', `/${WAREHOUSE_ID}/markings/${dateKey}`);
      }
    }
  }

  // ─── Polling & Sync ──────────────────────────────────────────────

  async function pollMarkings() {
    const newMarkings = await fetchMarkings();
    const oldJson = JSON.stringify(currentMarkings);
    const newJson = JSON.stringify(newMarkings);
    if (oldJson !== newJson) {
      if (!isFirstPoll) {
        // Check if all changes were made by the current user
        const onlyMyChanges = Object.keys(newMarkings).every(key => {
          const oldM = currentMarkings[key];
          const newM = newMarkings[key];
          if (JSON.stringify(oldM) === JSON.stringify(newM)) return true;
          return newM && newM.markedBy === managerAlias;
        }) && Object.keys(currentMarkings).every(key => {
          // Also check deletions — if a key was removed, check who owned it
          if (newMarkings[key]) return true;
          const oldM = currentMarkings[key];
          return oldM && oldM.markedBy === managerAlias;
        });

        if (onlyMyChanges) {
          // Silently apply — these are our own changes echoed back
          currentMarkings = newMarkings;
          refreshAllUI();
        } else {
          // Another manager made changes — show notification
          pendingRemoteChanges = true;
          showRemoteChangeNotification(newMarkings);
        }
      } else {
        currentMarkings = newMarkings;
        refreshAllUI();
      }
    }
    isFirstPoll = false;
    updateSyncTimestamp();
  }

  function applyRemoteChanges(newMarkings) {
    currentMarkings = newMarkings || currentMarkings;
    pendingRemoteChanges = false;
    hideRemoteChangeNotification();
    refreshAllUI();
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollMarkings, POLL_INTERVAL_MS);
  }

  // ─── Employee Detection ──────────────────────────────────────────

  function extractEmpIdFromHref(href) {
    if (!href) return null;
    const m = href.match(/employeeId=([^&]+)/);
    return m ? m[1] : null;
  }

  function extractEmpNameFromLink(link) {
    const text = (link.textContent || '').trim();
    return text || null;
  }

  function detectEmployees() {
    const found = {};

    function addEmployee(empId, empName, link, row) {
      if (!empId) return;
      empId = empId.trim();
      if (!found[empId]) {
        found[empId] = { empId, empName: empName || empId, links: [], rows: [] };
      }
      if (empName && empName !== empId) found[empId].empName = empName;
      if (link && !found[empId].links.includes(link)) found[empId].links.push(link);
      if (row && !found[empId].rows.includes(row)) found[empId].rows.push(row);
    }

    // Strategy 1: a[href*="employeeId"]
    document.querySelectorAll('a[href*="employeeId"]').forEach(a => {
      const empId = extractEmpIdFromHref(a.href);
      const row = a.closest('tr');
      addEmployee(empId, extractEmpNameFromLink(a), a, row);
    });

    // Strategy 2: a[href*="/employee/"]
    document.querySelectorAll('a[href*="/employee/"]').forEach(a => {
      const empId = extractEmpIdFromHref(a.href);
      if (empId) {
        const row = a.closest('tr');
        addEmployee(empId, extractEmpNameFromLink(a), a, row);
      }
    });

    // Strategy 3: Links matching timeDetails/ppaTimeDetails
    document.querySelectorAll('a[href]').forEach(a => {
      if (/timeDetails|ppaTimeDetails/.test(a.href)) {
        const empId = extractEmpIdFromHref(a.href);
        const row = a.closest('tr');
        addEmployee(empId, extractEmpNameFromLink(a), a, row);
      }
    });

    // Strategy 4: Table cell scan
    document.querySelectorAll('tr > td').forEach(td => {
      const a = td.querySelector('a[href*="employeeId"]');
      if (a) {
        const empId = extractEmpIdFromHref(a.href);
        addEmployee(empId, extractEmpNameFromLink(a), a, a.closest('tr'));
      }
    });

    // Strategy 5: Profile page URL
    if (isProfilePage()) {
      const empId = extractEmpIdFromHref(window.location.href);
      if (empId) {
        let empName = null;
        const h1 = document.querySelector('h1, h2, .employee-name, [class*="employeeName"]');
        if (h1) empName = h1.textContent.trim();
        addEmployee(empId, empName, null, null);
      }
    }

    // Strategy 6: onclick handlers
    document.querySelectorAll('[onclick*="employeeId"]').forEach(el => {
      const onclick = el.getAttribute('onclick') || '';
      const m = onclick.match(/employeeId[=:]?\s*['"]?([^'"&\s,)]+)/);
      if (m) {
        const row = el.closest('tr');
        addEmployee(m[1], el.textContent.trim(), el, row);
      }
    });

    detectedEmployees = found;
    log('Detected employees:', Object.keys(found).length);
    return found;
  }

  // ─── CSS Injection ───────────────────────────────────────────────

  function injectStyles() {
    GM_addStyle(`
      /* ─── Side Panel ─── */
      #fclm-tracker-panel {
        position: fixed; top: 10px; right: 10px; width: 340px;
        background: #fff; border: 1px solid #ccc; border-radius: 10px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.15); z-index: 99999;
        font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px; color: #333; max-height: 90vh; display: flex; flex-direction: column;
        transition: width 0.2s;
      }
      #fclm-tracker-panel.minimized { width: 240px; }
      #fclm-tracker-panel.minimized .fclm-panel-body,
      #fclm-tracker-panel.minimized .fclm-panel-footer { display: none; }

      .fclm-panel-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; background: linear-gradient(135deg, #232f3e, #37475a);
        color: #fff; border-radius: 10px 10px 0 0;
        cursor: move; user-select: none; flex-shrink: 0;
      }
      .fclm-panel-header .fclm-title { font-weight: 700; font-size: 13px; letter-spacing: 0.3px; }
      .fclm-panel-header .fclm-badge {
        background: #ff9900; color: #111; border-radius: 10px;
        padding: 1px 8px; font-size: 11px; font-weight: 700; margin-left: 8px;
        min-width: 18px; text-align: center;
      }
      .fclm-panel-header .fclm-status-dot {
        width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-left: 8px;
        box-shadow: 0 0 4px rgba(0,0,0,0.3);
      }
      .fclm-panel-header .fclm-status-dot.connected { background: #4caf50; box-shadow: 0 0 6px #4caf50; }
      .fclm-panel-header .fclm-status-dot.disconnected { background: #f44336; box-shadow: 0 0 6px #f44336; }

      .fclm-header-buttons { display: flex; gap: 2px; }
      .fclm-header-buttons button {
        background: rgba(255,255,255,0.1); border: none; color: #fff; cursor: pointer;
        font-size: 13px; padding: 3px 7px; border-radius: 5px; line-height: 1;
        transition: background 0.15s;
      }
      .fclm-header-buttons button:hover { background: rgba(255,255,255,0.25); }

      .fclm-panel-body {
        overflow-y: auto; flex: 1; padding: 8px; min-height: 40px; max-height: 60vh;
      }
      .fclm-panel-body .fclm-empty {
        text-align: center; color: #aaa; padding: 24px 10px; font-style: italic; font-size: 12px;
      }

      /* ─── Remote change notification ─── */
      .fclm-remote-notice {
        display: none; padding: 8px 12px; background: #e3f2fd; border-bottom: 1px solid #90caf9;
        font-size: 12px; color: #1565c0; align-items: center; gap: 8px; flex-shrink: 0;
      }
      .fclm-remote-notice.visible { display: flex; }
      .fclm-remote-notice button {
        background: #1565c0; color: #fff; border: none; border-radius: 4px;
        padding: 3px 10px; font-size: 11px; font-weight: 600; cursor: pointer;
        margin-left: auto; white-space: nowrap;
      }
      .fclm-remote-notice button:hover { background: #1976d2; }

      .fclm-marking-item {
        display: flex; align-items: flex-start; padding: 8px 10px; margin-bottom: 4px;
        border-radius: 8px; cursor: pointer; border-left: 3px solid transparent;
        transition: background 0.15s;
      }
      .fclm-marking-item:hover { background: #f5f5f5; }
      .fclm-marking-item .fclm-mi-icon { font-size: 16px; margin-right: 8px; flex-shrink: 0; margin-top: 1px; }
      .fclm-marking-item .fclm-mi-body { flex: 1; min-width: 0; }
      .fclm-marking-item .fclm-mi-name { font-weight: 600; font-size: 13px; }
      .fclm-marking-item .fclm-mi-meta { font-size: 11px; color: #777; margin-top: 2px; }
      .fclm-marking-item .fclm-mi-notes { font-size: 11px; color: #555; margin-top: 2px; font-style: italic; }

      .fclm-panel-footer {
        padding: 8px 14px; border-top: 1px solid #eee; font-size: 10px; color: #999;
        flex-shrink: 0;
      }

      /* ─── Profile Employee Panel ─── */
      #fclm-profile-panel {
        position: fixed; top: 10px; left: 10px; width: 320px;
        background: #fff; border: 1px solid #ccc; border-radius: 10px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.15); z-index: 99998;
        font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px; color: #333; display: flex; flex-direction: column;
      }
      #fclm-profile-panel .fclm-pp-header {
        padding: 10px 14px; background: linear-gradient(135deg, #232f3e, #37475a);
        color: #fff; border-radius: 10px 10px 0 0; font-weight: 700; font-size: 13px;
        display: flex; align-items: center; justify-content: space-between;
        cursor: move; user-select: none;
      }
      #fclm-profile-panel .fclm-pp-body { padding: 12px 14px; }
      #fclm-profile-panel .fclm-pp-empname { font-weight: 700; font-size: 15px; margin-bottom: 2px; }
      #fclm-profile-panel .fclm-pp-empid { font-size: 11px; color: #777; margin-bottom: 10px; }
      #fclm-profile-panel .fclm-pp-status-card {
        padding: 10px 12px; border-radius: 8px; border-left: 4px solid; margin-bottom: 10px;
      }
      #fclm-profile-panel .fclm-pp-status-label { font-weight: 700; font-size: 14px; margin-bottom: 2px; }
      #fclm-profile-panel .fclm-pp-status-meta { font-size: 11px; color: #555; }
      #fclm-profile-panel .fclm-pp-status-notes { font-size: 12px; font-style: italic; color: #555; margin-top: 4px; }
      #fclm-profile-panel .fclm-pp-no-status { color: #aaa; font-style: italic; padding: 8px 0; }
      #fclm-profile-panel .fclm-pp-actions { display: flex; gap: 6px; margin-top: 8px; }
      #fclm-profile-panel .fclm-pp-actions button {
        flex: 1; padding: 7px 12px; border-radius: 6px; border: none; cursor: pointer;
        font-size: 12px; font-weight: 600; transition: background 0.15s;
      }
      .fclm-pp-btn-mark { background: #232f3e; color: #fff; }
      .fclm-pp-btn-mark:hover { background: #37475a; }
      .fclm-pp-btn-change { background: #ff9900; color: #111; }
      .fclm-pp-btn-change:hover { background: #e68a00; }
      .fclm-pp-btn-clear { background: #f8d7da; color: #dc3545; }
      .fclm-pp-btn-clear:hover { background: #f1c0c5; }

      /* ─── Modal ─── */
      .fclm-modal-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100000;
        display: flex; align-items: center; justify-content: center;
        backdrop-filter: blur(2px);
      }
      .fclm-modal {
        background: #fff; border-radius: 12px; padding: 0; width: 420px;
        max-width: 90vw; box-shadow: 0 12px 48px rgba(0,0,0,0.3);
        font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        overflow: hidden;
      }
      .fclm-modal-header {
        background: linear-gradient(135deg, #232f3e, #37475a); color: #fff;
        padding: 16px 20px; font-size: 16px; font-weight: 700;
      }
      .fclm-modal-header small { display: block; font-weight: 400; font-size: 12px; color: #adb5bd; margin-top: 2px; }
      .fclm-modal-content { padding: 20px; }
      .fclm-modal .fclm-existing-info {
        background: #f8f9fa; padding: 10px 14px; border-radius: 8px; border: 1px solid #e9ecef;
        font-size: 12px; color: #555; margin-bottom: 14px;
      }

      .fclm-status-options { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
      .fclm-status-option {
        display: flex; align-items: center; padding: 10px 12px; border-radius: 8px;
        border: 2px solid #e0e0e0; cursor: pointer; transition: all 0.15s;
      }
      .fclm-status-option:hover { border-color: #999; }
      .fclm-status-option.selected { border-color: #232f3e; box-shadow: 0 0 0 1px #232f3e; }
      .fclm-status-option input[type="radio"] { margin-right: 10px; accent-color: #232f3e; }
      .fclm-status-option .fclm-so-icon { font-size: 18px; margin-right: 8px; }
      .fclm-status-option .fclm-so-label { font-weight: 600; font-size: 13px; }
      .fclm-status-option .fclm-so-color {
        width: 12px; height: 12px; border-radius: 3px; margin-left: auto;
      }

      .fclm-modal textarea {
        width: 100%; box-sizing: border-box; border: 1px solid #d5d9d9; border-radius: 8px;
        padding: 10px; font-size: 13px; resize: vertical; min-height: 50px;
        font-family: inherit; margin-bottom: 16px; transition: border-color 0.2s;
      }
      .fclm-modal textarea:focus { outline: none; border-color: #ff9900; box-shadow: 0 0 0 2px rgba(255,153,0,0.2); }
      .fclm-modal input[type="text"] {
        width: 100%; box-sizing: border-box; border: 1px solid #d5d9d9; border-radius: 8px;
        padding: 10px; font-size: 13px; font-family: inherit; margin-bottom: 12px;
        transition: border-color 0.2s;
      }
      .fclm-modal input[type="text"]:focus { outline: none; border-color: #ff9900; box-shadow: 0 0 0 2px rgba(255,153,0,0.2); }

      .fclm-modal-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 0 20px 20px; }
      .fclm-modal-actions button {
        padding: 9px 20px; border-radius: 8px; border: none; cursor: pointer;
        font-size: 13px; font-weight: 600; transition: all 0.15s;
      }
      .fclm-btn-save { background: #ff9900; color: #111; }
      .fclm-btn-save:hover { background: #e68a00; }
      .fclm-btn-clear { background: #f8d7da; color: #dc3545; }
      .fclm-btn-clear:hover { background: #f1c0c5; }
      .fclm-btn-cancel { background: #f0f0f0; color: #333; }
      .fclm-btn-cancel:hover { background: #ddd; }

      /* ─── Alias Modal (first-run) ─── */
      .fclm-alias-modal {
        background: #fff; border-radius: 14px; width: 380px; max-width: 90vw;
        box-shadow: 0 16px 64px rgba(0,0,0,0.3); overflow: hidden;
        font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        animation: fclm-fadeIn 0.3s ease;
      }
      @keyframes fclm-fadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
      .fclm-alias-header {
        background: linear-gradient(135deg, #232f3e, #37475a); color: #fff;
        padding: 24px 24px 20px; text-align: center;
      }
      .fclm-alias-header .fclm-alias-logo { font-size: 36px; margin-bottom: 8px; }
      .fclm-alias-header h2 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: 0.3px; }
      .fclm-alias-header p { margin: 6px 0 0; font-size: 12px; color: #adb5bd; }
      .fclm-alias-body { padding: 24px; }
      .fclm-alias-body label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 6px; }
      .fclm-alias-body input {
        width: 100%; box-sizing: border-box; border: 2px solid #d5d9d9; border-radius: 8px;
        padding: 12px 14px; font-size: 15px; font-family: inherit; transition: border-color 0.2s;
        text-align: center; letter-spacing: 0.5px;
      }
      .fclm-alias-body input:focus { outline: none; border-color: #ff9900; box-shadow: 0 0 0 3px rgba(255,153,0,0.2); }
      .fclm-alias-body input::placeholder { color: #bbb; }
      .fclm-alias-body .fclm-alias-hint {
        font-size: 11px; color: #999; text-align: center; margin-top: 8px;
      }
      .fclm-alias-footer { padding: 0 24px 24px; }
      .fclm-alias-footer button {
        width: 100%; padding: 12px; background: #ff9900; color: #111; border: none;
        border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer;
        transition: background 0.15s; letter-spacing: 0.3px;
      }
      .fclm-alias-footer button:hover { background: #e68a00; }
      .fclm-alias-footer button:disabled { background: #ccc; cursor: not-allowed; }

      /* ─── Mark Buttons ─── */
      .fclm-mark-btn {
        display: inline-flex; align-items: center; gap: 3px;
        background: #232f3e; color: #fff; border: none; border-radius: 4px;
        padding: 2px 6px; font-size: 11px; cursor: pointer; margin-left: 4px;
        font-family: inherit; vertical-align: middle; line-height: 1.4;
        transition: background 0.15s;
      }
      .fclm-mark-btn:hover { background: #37475a; }

      /* ─── Inline Badge ─── */
      .fclm-inline-badge {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600;
        margin-left: 6px; white-space: nowrap; vertical-align: middle;
      }

      /* ─── Row Highlighting ─── */
      tr.fclm-row-highlight { transition: background 0.3s; }

      /* ─── Toast ─── */
      .fclm-toast {
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: #232f3e; color: #fff; padding: 10px 24px; border-radius: 8px;
        font-size: 13px; z-index: 100001; opacity: 0; transition: opacity 0.3s;
        font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        pointer-events: none; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      }
      .fclm-toast.show { opacity: 1; }

      /* ─── Debug Panel ─── */
      #fclm-debug-panel {
        position: fixed; bottom: 10px; left: 10px; width: 420px; max-height: 50vh;
        background: #1e1e1e; color: #d4d4d4; border-radius: 8px; padding: 12px;
        font-family: 'Consolas', 'Monaco', monospace; font-size: 11px;
        overflow-y: auto; z-index: 99998; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        display: none;
      }
      #fclm-debug-panel.visible { display: block; }
      #fclm-debug-panel h4 { color: #ff9900; margin: 8px 0 4px; font-size: 12px; }
      #fclm-debug-panel .dbg-section {
        margin-bottom: 6px; padding: 4px; background: #2d2d2d; border-radius: 4px;
      }
      #fclm-debug-panel details { margin: 4px 0; }
      #fclm-debug-panel summary { cursor: pointer; color: #ff9900; font-weight: 600; }
      #fclm-debug-panel pre { white-space: pre-wrap; word-break: break-all; margin: 2px 0; }
    `);
  }

  // ─── Toast ───────────────────────────────────────────────────────

  function showToast(msg) {
    let toast = document.getElementById('fclm-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'fclm-toast';
      toast.className = 'fclm-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }

  // ─── Remote Change Notification ──────────────────────────────────

  let pendingRemoteMarkings = null;

  function showRemoteChangeNotification(newMarkings) {
    pendingRemoteMarkings = newMarkings;
    const notice = document.getElementById('fclm-remote-notice');
    if (notice) notice.classList.add('visible');
  }

  function hideRemoteChangeNotification() {
    pendingRemoteMarkings = null;
    const notice = document.getElementById('fclm-remote-notice');
    if (notice) notice.classList.remove('visible');
  }

  // ─── Side Panel ──────────────────────────────────────────────────

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'fclm-tracker-panel';

    panel.innerHTML = `
      <div class="fclm-panel-header" id="fclm-panel-drag">
        <div style="display:flex;align-items:center;">
          <span class="fclm-title">Should I Code? 🤔</span>
          <span class="fclm-badge" id="fclm-badge-count">0</span>
          <span class="fclm-status-dot" id="fclm-status-dot" title="Firebase status"></span>
        </div>
        <div class="fclm-header-buttons">
          <button id="fclm-btn-add" title="Manual Add">+</button>
          <button id="fclm-btn-refresh" title="Refresh">\u21BB</button>
          ${DEBUG ? '<button id="fclm-btn-debug" title="Debug">\uD83D\uDC1B</button>' : ''}
          <button id="fclm-btn-minimize" title="Minimize">\u2500</button>
        </div>
      </div>
      <div class="fclm-remote-notice" id="fclm-remote-notice">
        <span>\u26A0\uFE0F Another manager made changes</span>
        <button id="fclm-btn-sync-now">Sync Now</button>
      </div>
      <div class="fclm-panel-body" id="fclm-panel-body">
        <div class="fclm-empty">No active markings for today</div>
      </div>
      <div class="fclm-panel-footer" id="fclm-panel-footer">
        <div id="fclm-sync-time">Last sync: never</div>
        <div id="fclm-footer-info"></div>
      </div>
    `;

    document.body.appendChild(panel);

    // Drag
    makeDraggable(panel, document.getElementById('fclm-panel-drag'));

    // Minimize
    document.getElementById('fclm-btn-minimize').addEventListener('click', () => {
      panel.classList.toggle('minimized');
      document.getElementById('fclm-btn-minimize').textContent = panel.classList.contains('minimized') ? '\u25A1' : '\u2500';
    });

    // Manual Add
    document.getElementById('fclm-btn-add').addEventListener('click', openManualAddModal);

    // Refresh
    document.getElementById('fclm-btn-refresh').addEventListener('click', async () => {
      const m = await fetchMarkings();
      applyRemoteChanges(m);
      showToast('Refreshed');
    });

    // Sync Now (remote changes)
    document.getElementById('fclm-btn-sync-now').addEventListener('click', () => {
      if (pendingRemoteMarkings) {
        applyRemoteChanges(pendingRemoteMarkings);
        showToast('Synced with latest changes');
      }
    });

    // Debug
    if (DEBUG) {
      document.getElementById('fclm-btn-debug').addEventListener('click', toggleDebugPanel);
    }

    updateFooterInfo();
  }

  function makeDraggable(el, handle) {
    let offsetX, offsetY, isDragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      offsetX = e.clientX - el.getBoundingClientRect().left;
      offsetY = e.clientY - el.getBoundingClientRect().top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      el.style.left = (e.clientX - offsetX) + 'px';
      el.style.top = (e.clientY - offsetY) + 'px';
      el.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { isDragging = false; });
  }

  function updatePanelBody() {
    const body = document.getElementById('fclm-panel-body');
    if (!body) return;

    const entries = Object.values(currentMarkings).filter(m => m && m.status);
    entries.sort((a, b) => {
      const pa = (STATUSES[a.status] || {}).priority || 99;
      const pb = (STATUSES[b.status] || {}).priority || 99;
      return pa - pb;
    });

    document.getElementById('fclm-badge-count').textContent = entries.length;

    if (entries.length === 0) {
      body.innerHTML = '<div class="fclm-empty">No active markings for today</div>';
      return;
    }

    body.innerHTML = entries.map(m => {
      const s = STATUSES[m.status] || STATUSES.stu_pending;
      return `
        <div class="fclm-marking-item" data-empid="${escapeHtml(m.employeeId)}" style="border-left-color:${s.border}">
          <span class="fclm-mi-icon">${s.icon}</span>
          <div class="fclm-mi-body">
            <div class="fclm-mi-name">${escapeHtml(m.employeeName || m.employeeId)}</div>
            <div class="fclm-mi-meta">${s.label} \u00B7 by ${escapeHtml(m.markedBy)} \u00B7 ${formatTime(m.timestamp)}</div>
            ${m.notes ? `<div class="fclm-mi-notes">${escapeHtml(truncate(m.notes, 60))}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    body.querySelectorAll('.fclm-marking-item').forEach(el => {
      el.addEventListener('click', () => {
        const empId = el.dataset.empid;
        const marking = currentMarkings[sanitizeKey(empId)];
        if (marking) openMarkingModal(marking.employeeId, marking.employeeName);
      });
    });
  }

  function updateSyncTimestamp() {
    const el = document.getElementById('fclm-sync-time');
    if (el) el.textContent = 'Last sync: ' + new Date().toLocaleTimeString();
  }

  function updateFooterInfo() {
    const el = document.getElementById('fclm-footer-info');
    if (el) el.textContent = `Date: ${currentDateKey} | Page: ${currentPageType}`;
  }

  function updateConnectionStatus(connected) {
    const dot = document.getElementById('fclm-status-dot');
    if (dot) {
      dot.className = 'fclm-status-dot ' + (connected ? 'connected' : 'disconnected');
      dot.title = connected ? 'Firebase connected' : 'Firebase disconnected';
    }
  }

  // ─── Profile Employee Panel (replaces banner) ───────────────────

  function updateProfilePanel() {
    // Remove old
    const existing = document.getElementById('fclm-profile-panel');
    if (existing) existing.remove();

    if (!isProfilePage()) return;

    const empId = extractEmpIdFromHref(window.location.href);
    if (!empId) return;

    const emp = detectedEmployees[empId];
    const empName = emp ? emp.empName : empId;
    const marking = currentMarkings[sanitizeKey(empId)];
    const s = marking ? STATUSES[marking.status] : null;

    const panel = document.createElement('div');
    panel.id = 'fclm-profile-panel';

    let statusContent;
    if (marking && s) {
      statusContent = `
        <div class="fclm-pp-status-card" style="background:${s.bg};border-left-color:${s.border}">
          <div class="fclm-pp-status-label">${s.icon} ${s.label}</div>
          <div class="fclm-pp-status-meta">Marked by ${escapeHtml(marking.markedBy)} at ${formatTime(marking.timestamp)}</div>
          ${marking.notes ? `<div class="fclm-pp-status-notes">${escapeHtml(marking.notes)}</div>` : ''}
        </div>
        <div class="fclm-pp-actions">
          <button class="fclm-pp-btn-change" id="fclm-pp-change">Change Status</button>
          <button class="fclm-pp-btn-clear" id="fclm-pp-clear">Clear</button>
        </div>
      `;
    } else {
      statusContent = `
        <div class="fclm-pp-no-status">No active marking for this associate</div>
        <div class="fclm-pp-actions">
          <button class="fclm-pp-btn-mark" id="fclm-pp-mark">Mark This Associate</button>
        </div>
      `;
    }

    panel.innerHTML = `
      <div class="fclm-pp-header" id="fclm-pp-drag">
        <span>Employee Status</span>
      </div>
      <div class="fclm-pp-body">
        <div class="fclm-pp-empname">${escapeHtml(empName)}</div>
        <div class="fclm-pp-empid">ID: ${escapeHtml(empId)}</div>
        ${statusContent}
      </div>
    `;

    document.body.appendChild(panel);
    makeDraggable(panel, document.getElementById('fclm-pp-drag'));

    // Attach events
    const markBtn = panel.querySelector('#fclm-pp-mark');
    const changeBtn = panel.querySelector('#fclm-pp-change');
    const clearBtn = panel.querySelector('#fclm-pp-clear');

    if (markBtn) {
      markBtn.addEventListener('click', () => openMarkingModal(empId, empName));
    }
    if (changeBtn) {
      changeBtn.addEventListener('click', () => openMarkingModal(empId, empName));
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        await deleteMarking(empId);
        delete currentMarkings[sanitizeKey(empId)];
        refreshAllUI();
        showToast(`Cleared marking for ${empName}`);
      });
    }
  }

  // ─── Marking Modal ──────────────────────────────────────────────

  function openMarkingModal(empId, empName) {
    closeAllModals();
    const existing = currentMarkings[sanitizeKey(empId)] || null;

    const backdrop = document.createElement('div');
    backdrop.className = 'fclm-modal-backdrop';
    backdrop.id = 'fclm-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'fclm-modal';

    let existingInfo = '';
    if (existing) {
      existingInfo = `
        <div class="fclm-existing-info">
          Currently marked as <strong>${(STATUSES[existing.status] || {}).label || existing.status}</strong>
          by <strong>${escapeHtml(existing.markedBy)}</strong> at ${formatTime(existing.timestamp)}
          ${existing.notes ? `<br>Notes: ${escapeHtml(existing.notes)}` : ''}
        </div>
      `;
    }

    modal.innerHTML = `
      <div class="fclm-modal-header">
        ${escapeHtml(empName || empId)}
        <small>Employee ID: ${escapeHtml(empId)}</small>
      </div>
      <div class="fclm-modal-content">
        ${existingInfo}
        <div class="fclm-status-options">
          ${Object.values(STATUSES).map(s => `
            <label class="fclm-status-option ${existing && existing.status === s.key ? 'selected' : ''}"
                   data-status="${s.key}" style="background:${s.bg}">
              <input type="radio" name="fclm-status" value="${s.key}"
                ${existing && existing.status === s.key ? 'checked' : ''}>
              <span class="fclm-so-icon">${s.icon}</span>
              <span class="fclm-so-label">${s.label}</span>
              <span class="fclm-so-color" style="background:${s.border}"></span>
            </label>
          `).join('')}
        </div>
        <textarea id="fclm-notes" placeholder="Optional notes...">${existing && existing.notes ? escapeHtml(existing.notes) : ''}</textarea>
      </div>
      <div class="fclm-modal-actions">
        ${existing ? '<button class="fclm-btn-clear" id="fclm-modal-clear">Clear</button>' : ''}
        <button class="fclm-btn-cancel" id="fclm-modal-cancel">Cancel</button>
        <button class="fclm-btn-save" id="fclm-modal-save">Save</button>
      </div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Status option click
    modal.querySelectorAll('.fclm-status-option').forEach(opt => {
      opt.addEventListener('click', () => {
        modal.querySelectorAll('.fclm-status-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        opt.querySelector('input[type="radio"]').checked = true;
      });
    });

    // Save
    modal.querySelector('#fclm-modal-save').addEventListener('click', async () => {
      const selected = modal.querySelector('input[name="fclm-status"]:checked');
      if (!selected) { showToast('Please select a status'); return; }
      const marking = {
        employeeId: empId,
        employeeName: empName || empId,
        status: selected.value,
        markedBy: managerAlias,
        timestamp: Date.now(),
        notes: modal.querySelector('#fclm-notes').value.trim(),
      };
      await saveMarking(empId, marking);
      currentMarkings[sanitizeKey(empId)] = marking;
      refreshAllUI();
      closeAllModals();
      showToast(`Marked ${escapeHtml(empName || empId)} as ${STATUSES[selected.value].label}`);
    });

    // Clear
    if (existing) {
      modal.querySelector('#fclm-modal-clear').addEventListener('click', async () => {
        await deleteMarking(empId);
        delete currentMarkings[sanitizeKey(empId)];
        refreshAllUI();
        closeAllModals();
        showToast(`Cleared marking for ${escapeHtml(empName || empId)}`);
      });
    }

    // Cancel / backdrop / escape
    modal.querySelector('#fclm-modal-cancel').addEventListener('click', closeAllModals);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeAllModals(); });
  }

  // ─── Manual Add Modal (no Display Name field) ───────────────────

  function openManualAddModal() {
    closeAllModals();

    const backdrop = document.createElement('div');
    backdrop.className = 'fclm-modal-backdrop';
    backdrop.id = 'fclm-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'fclm-modal';

    modal.innerHTML = `
      <div class="fclm-modal-header">
        Manual Add
        <small>Mark an employee not detected on this page</small>
      </div>
      <div class="fclm-modal-content">
        <input type="text" id="fclm-manual-empid" placeholder="Employee ID or login">
        <div class="fclm-status-options">
          ${Object.values(STATUSES).map(s => `
            <label class="fclm-status-option" data-status="${s.key}" style="background:${s.bg}">
              <input type="radio" name="fclm-status" value="${s.key}">
              <span class="fclm-so-icon">${s.icon}</span>
              <span class="fclm-so-label">${s.label}</span>
              <span class="fclm-so-color" style="background:${s.border}"></span>
            </label>
          `).join('')}
        </div>
        <textarea id="fclm-notes" placeholder="Optional notes..."></textarea>
      </div>
      <div class="fclm-modal-actions">
        <button class="fclm-btn-cancel" id="fclm-modal-cancel">Cancel</button>
        <button class="fclm-btn-save" id="fclm-modal-save">Save</button>
      </div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Status option click
    modal.querySelectorAll('.fclm-status-option').forEach(opt => {
      opt.addEventListener('click', () => {
        modal.querySelectorAll('.fclm-status-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        opt.querySelector('input[type="radio"]').checked = true;
      });
    });

    modal.querySelector('#fclm-modal-save').addEventListener('click', async () => {
      const empId = modal.querySelector('#fclm-manual-empid').value.trim();
      if (!empId) { showToast('Please enter an Employee ID'); return; }
      const selected = modal.querySelector('input[name="fclm-status"]:checked');
      if (!selected) { showToast('Please select a status'); return; }
      const marking = {
        employeeId: empId,
        employeeName: empId,
        status: selected.value,
        markedBy: managerAlias,
        timestamp: Date.now(),
        notes: modal.querySelector('#fclm-notes').value.trim(),
      };
      await saveMarking(empId, marking);
      currentMarkings[sanitizeKey(empId)] = marking;
      refreshAllUI();
      closeAllModals();
      showToast(`Marked ${empId} as ${STATUSES[selected.value].label}`);
    });

    modal.querySelector('#fclm-modal-cancel').addEventListener('click', closeAllModals);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeAllModals(); });
  }

  function closeAllModals() {
    document.querySelectorAll('.fclm-modal-backdrop').forEach(el => el.remove());
  }

  // ─── Keyboard Shortcuts ──────────────────────────────────────────

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllModals();
      }
      if (e.altKey && e.key.toLowerCase() === 'm' && isProfilePage()) {
        const empId = extractEmpIdFromHref(window.location.href);
        if (empId) {
          const emp = detectedEmployees[empId];
          openMarkingModal(empId, emp ? emp.empName : empId);
        }
      }
    });
  }

  // ─── Mark Buttons (Table Pages — deduplicated per row) ──────────

  function injectMarkButtons() {
    // Remove old buttons
    document.querySelectorAll('.fclm-mark-btn').forEach(el => el.remove());

    if (!isTablePage()) return;

    for (const [empId, emp] of Object.entries(detectedEmployees)) {
      // Group links by row
      const rowsHandled = new Set();

      for (const link of emp.links) {
        const row = link.closest('tr');
        const rowKey = row || link; // use link itself as key if no row

        if (rowsHandled.has(rowKey)) continue;
        rowsHandled.add(rowKey);

        // Pick the best link in this row
        const primaryLink = pickPrimaryLink(emp, row);
        if (!primaryLink || primaryLink !== link) {
          // This link is not the primary for its row — check if primary is
          // in this iteration; if primaryLink is a different link in emp.links
          // that shares this row, skip and let that one handle it.
          if (primaryLink && emp.links.includes(primaryLink)) continue;
        }

        if (primaryLink && primaryLink.parentElement && !primaryLink.parentElement.querySelector('.fclm-mark-btn')) {
          const btn = document.createElement('button');
          btn.className = 'fclm-mark-btn';
          btn.textContent = '\u2691';
          btn.title = 'Mark this associate';
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openMarkingModal(empId, emp.empName);
          });
          primaryLink.parentElement.insertBefore(btn, primaryLink.nextSibling);
        }
      }
    }
  }

  // ─── Row/Link Highlighting ──────────────────────────────────────

  function applyHighlights() {
    // Clear old highlights
    document.querySelectorAll('.fclm-row-highlight').forEach(el => {
      el.classList.remove('fclm-row-highlight');
      el.style.backgroundColor = '';
      el.style.borderLeft = '';
    });
    document.querySelectorAll('.fclm-inline-badge').forEach(el => el.remove());

    for (const [key, marking] of Object.entries(currentMarkings)) {
      if (!marking || !marking.status) continue;
      const s = STATUSES[marking.status];
      if (!s) continue;
      const emp = detectedEmployees[marking.employeeId];
      if (!emp) continue;

      // Row highlighting
      const rowsDone = new Set();
      emp.rows.forEach(row => {
        if (row && !rowsDone.has(row)) {
          rowsDone.add(row);
          row.classList.add('fclm-row-highlight');
          row.style.backgroundColor = s.bg;
          row.style.borderLeft = `4px solid ${s.border}`;
        }
      });

      // Inline badge — one per row only, next to primary link
      const badgeRowsDone = new Set();
      for (const row of emp.rows) {
        if (!row || badgeRowsDone.has(row)) continue;
        badgeRowsDone.add(row);
        const primaryLink = pickPrimaryLink(emp, row);
        if (primaryLink && primaryLink.parentElement && !primaryLink.parentElement.querySelector('.fclm-inline-badge')) {
          const badge = document.createElement('span');
          badge.className = 'fclm-inline-badge';
          badge.style.backgroundColor = s.bg;
          badge.style.color = s.border;
          badge.title = `${s.label} \u2014 by ${marking.markedBy} at ${formatTime(marking.timestamp)}${marking.notes ? '\n' + marking.notes : ''}`;
          badge.innerHTML = `${s.icon} ${s.label}`;
          primaryLink.parentElement.insertBefore(badge, primaryLink.nextSibling?.nextSibling || null);
        }
      }
    }
  }

  // ─── Context Menu ────────────────────────────────────────────────

  function setupContextMenu() {
    document.addEventListener('contextmenu', (e) => {
      let el = e.target;
      let empId = null;
      let empName = null;
      for (let i = 0; i < 10 && el && el !== document.body; i++) {
        if (el.tagName === 'A' && el.href) {
          empId = extractEmpIdFromHref(el.href);
          if (empId) { empName = extractEmpNameFromLink(el); break; }
        }
        if (el.tagName === 'TR') {
          const link = el.querySelector('a[href*="employeeId"]');
          if (link) {
            empId = extractEmpIdFromHref(link.href);
            empName = extractEmpNameFromLink(link);
            break;
          }
        }
        el = el.parentElement;
      }

      if (empId) {
        e.preventDefault();
        const emp = detectedEmployees[empId];
        openMarkingModal(empId, empName || (emp ? emp.empName : empId));
      }
    });
  }

  // ─── DOM Mutation Observer ──────────────────────────────────────

  function setupMutationObserver() {
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        detectEmployees();
        applyHighlights();
        injectMarkButtons();
        if (isProfilePage()) updateProfilePanel();
      }, DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Debug Panel ────────────────────────────────────────────────

  function createDebugPanel() {
    if (!DEBUG) return;
    const panel = document.createElement('div');
    panel.id = 'fclm-debug-panel';
    document.body.appendChild(panel);
  }

  function toggleDebugPanel() {
    const panel = document.getElementById('fclm-debug-panel');
    if (!panel) return;
    panel.classList.toggle('visible');
    if (panel.classList.contains('visible')) updateDebugPanel();
  }

  function updateDebugPanel() {
    const panel = document.getElementById('fclm-debug-panel');
    if (!panel || !panel.classList.contains('visible')) return;

    const empEntries = Object.entries(detectedEmployees);
    const allEmpLinks = document.querySelectorAll('a[href*="employeeId"]');
    const tables = document.querySelectorAll('table');

    panel.innerHTML = `
      <h4>FCLM Tracker Debug</h4>
      <div class="dbg-section">
        <div>Page type: <strong>${currentPageType}</strong></div>
        <div>URL: ${truncate(window.location.href, 80)}</div>
        <div>Date key: <strong>${currentDateKey}</strong></div>
        <div>Firebase: <strong>${firebaseConnected ? 'Connected' : 'Disconnected'}</strong></div>
        <div>Manager: <strong>${escapeHtml(managerAlias)}</strong></div>
        <div>Markings: <strong>${Object.keys(currentMarkings).length}</strong></div>
        <div>Detected employees: <strong>${empEntries.length}</strong></div>
      </div>

      <details>
        <summary>Detected Employees (${empEntries.length})</summary>
        <pre>${empEntries.map(([id, e]) => `${id}: ${e.empName} (${e.links.length} links, ${e.rows.length} rows)`).join('\n') || 'None'}</pre>
      </details>

      <details>
        <summary>Employee Links on Page (${allEmpLinks.length})</summary>
        <pre>${Array.from(allEmpLinks).slice(0, 30).map(a => truncate(a.href, 100)).join('\n') || 'None'}</pre>
      </details>

      <details>
        <summary>Tables (${tables.length})</summary>
        <pre>${Array.from(tables).map((t, i) => {
          const rows = t.querySelectorAll('tr');
          const hdrs = Array.from(t.querySelectorAll('th')).map(h => h.textContent.trim()).slice(0, 8);
          return `Table ${i}: ${rows.length} rows | Headers: ${hdrs.join(', ') || 'none'}`;
        }).join('\n') || 'None'}</pre>
      </details>

      <details>
        <summary>Current Markings</summary>
        <pre>${JSON.stringify(currentMarkings, null, 2)}</pre>
      </details>

      <details>
        <summary>Raw DOM (first 3000 chars)</summary>
        <pre>${(document.body.innerHTML || '').substring(0, 3000).replace(/</g, '&lt;')}</pre>
      </details>
    `;
  }

  // ─── Refresh All UI ──────────────────────────────────────────────

  function refreshAllUI() {
    updatePanelBody();
    applyHighlights();
    injectMarkButtons();
    if (isProfilePage()) updateProfilePanel();
    if (DEBUG) updateDebugPanel();
  }

  // ─── Content Wait Strategy ──────────────────────────────────────

  function waitForContent() {
    return new Promise((resolve) => {
      let attempts = 0;
      const check = () => {
        attempts++;
        const hasTables = document.querySelectorAll('table').length > 0;
        const hasEmpLinks = document.querySelectorAll('a[href*="employeeId"]').length > 0;

        if (isProfilePage()) {
          const empId = extractEmpIdFromHref(window.location.href);
          const bodyText = document.body.textContent || '';
          if (empId && (bodyText.includes(empId) || bodyText.length > 500)) {
            resolve();
            return;
          }
        } else if (hasTables || hasEmpLinks) {
          resolve();
          return;
        }

        if (attempts >= CONTENT_WAIT_MAX) {
          log('Content wait timed out after', attempts, 'attempts');
          resolve();
          return;
        }
        setTimeout(check, CONTENT_WAIT_INTERVAL);
      };
      check();
    });
  }

  // ─── Tampermonkey Menu Commands ──────────────────────────────────

  function registerMenuCommands() {
    GM_registerMenuCommand('Change Alias', () => {
      showAliasModal(true);
    });

    GM_registerMenuCommand('Clear All My Markings (Today)', async () => {
      if (!confirm(`Clear all markings made by "${managerAlias}" for today (${currentDateKey})?`)) return;
      let cleared = 0;
      for (const [key, marking] of Object.entries(currentMarkings)) {
        if (marking && marking.markedBy === managerAlias) {
          await deleteMarking(marking.employeeId);
          delete currentMarkings[key];
          cleared++;
        }
      }
      refreshAllUI();
      showToast(`Cleared ${cleared} marking(s)`);
    });

    GM_registerMenuCommand('Export Today\'s Markings (CSV)', () => {
      const entries = Object.values(currentMarkings).filter(m => m && m.status);
      if (entries.length === 0) { showToast('No markings to export'); return; }
      const header = 'Employee ID,Employee Name,Status,Marked By,Time,Notes';
      const rows = entries.map(m => {
        const esc = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
        return [
          esc(m.employeeId), esc(m.employeeName),
          esc((STATUSES[m.status] || {}).label || m.status),
          esc(m.markedBy), esc(formatTime(m.timestamp)), esc(m.notes),
        ].join(',');
      });
      const csv = [header, ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `markings_${currentDateKey}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('CSV exported');
    });
  }

  // ─── Styled Alias Modal ──────────────────────────────────────────

  function showAliasModal(isChange) {
    return new Promise((resolve) => {
      closeAllModals();

      const backdrop = document.createElement('div');
      backdrop.className = 'fclm-modal-backdrop';
      backdrop.id = 'fclm-modal-backdrop';
      backdrop.style.backdropFilter = 'blur(4px)';

      const modal = document.createElement('div');
      modal.className = 'fclm-alias-modal';

      modal.innerHTML = `
        <div class="fclm-alias-header">
          <div class="fclm-alias-logo">\uD83D\uDCCB</div>
          <h2>Should I Code? 🤔</h2>
          <p>${isChange ? 'Update your manager alias' : 'Welcome! Enter your login to get started.'}</p>
        </div>
        <div class="fclm-alias-body">
          <label>Manager Alias</label>
          <input type="text" id="fclm-alias-input" placeholder="e.g. jsmith"
                 value="${isChange && managerAlias ? escapeHtml(managerAlias) : ''}" autocomplete="off" spellcheck="false">
          <div class="fclm-alias-hint">Use your Amazon login (the part before @)</div>
        </div>
        <div class="fclm-alias-footer">
          <button id="fclm-alias-submit" ${!isChange ? 'disabled' : ''}>${isChange ? 'Update' : 'Get Started'}</button>
        </div>
      `;

      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);

      const input = modal.querySelector('#fclm-alias-input');
      const btn = modal.querySelector('#fclm-alias-submit');

      // Enable/disable button based on input
      input.addEventListener('input', () => {
        btn.disabled = !input.value.trim();
      });
      // If changing, button should be enabled if there's existing value
      if (isChange && managerAlias) btn.disabled = false;

      input.focus();

      function submit() {
        const val = input.value.trim();
        if (!val) return;
        managerAlias = val;
        GM_setValue('managerAlias', managerAlias);
        closeAllModals();
        if (isChange) showToast(`Alias updated to ${managerAlias}`);
        resolve(val);
      }

      btn.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });

      // Only allow closing on change, not on first run
      if (isChange) {
        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) { closeAllModals(); resolve(managerAlias); }
        });
      }
    });
  }

  // ─── Manager Alias ──────────────────────────────────────────────

  async function ensureAlias() {
    managerAlias = GM_getValue('managerAlias', '');
    if (!managerAlias) {
      await showAliasModal(false);
    }
  }

  // ─── Initialization ──────────────────────────────────────────────

  async function init() {
    log('Initializing Should I Code?...');

    // Detect page type and date early (before UI)
    currentPageType = detectPageType();
    currentDateKey = getDateKey();
    log('Page type:', currentPageType, '| Date key:', currentDateKey);

    // Inject styles first so modals look correct
    injectStyles();

    // Manager alias (may show modal)
    await ensureAlias();
    log('Manager alias:', managerAlias);

    // Create UI
    createPanel();
    createDebugPanel();

    // Register menu commands
    registerMenuCommands();

    // Wait for content to load
    await waitForContent();
    log('Content ready');

    // Detect employees
    detectEmployees();

    // Fetch markings
    const markings = await fetchMarkings();
    if (markings !== null) {
      currentMarkings = markings;
      updateConnectionStatus(true);
    } else {
      updateConnectionStatus(false);
    }

    // Refresh UI
    refreshAllUI();

    // Setup interactions
    setupContextMenu();
    setupKeyboardShortcuts();
    setupMutationObserver();

    // Start polling
    startPolling();

    // Cleanup old markings (fire and forget)
    cleanupOldMarkings();

    log('Initialization complete. Detected', Object.keys(detectedEmployees).length, 'employees,', Object.keys(currentMarkings).length, 'markings');
  }

  // Start
  init();

})();
