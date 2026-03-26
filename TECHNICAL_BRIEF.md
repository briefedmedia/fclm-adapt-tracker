# Associate ADAPT Tracker — Technical Specification Brief

Use this document as full context when discussing project changes. It describes the complete architecture, data model, networking layer, UI system, and known constraints of a Tampermonkey userscript.

---

## 1. Project Overview

**What it is:** A single-file Tampermonkey userscript (~1,490 lines, zero external dependencies) that enables Amazon warehouse managers at the HDC3 building to collaboratively mark Associate (AA) profiles with ADAPT status indicators that persist across page navigations and sync in real-time between all managers using the tool.

**Core problem it solves:** When a manager pulls an AA for a Speak To Understand (STU) or write-up, other managers have no visibility. This leads to duplicate STU conversations, accidental coding of unexcused time during active write-ups, and no shared state between managers on the same shift.

**Delivery mechanism:** Installed via Tampermonkey browser extension. Single self-contained IIFE. No build system, no bundler, no package.json, no external stylesheets or scripts.

---

## 2. Target Environment

### Browser Extension
- **Platform:** Tampermonkey (userscript)
- **Match pattern:** `https://fclm-portal.amazon.com/*`
- **Run-at:** `document-idle`

### Tampermonkey Grants Used
```
GM_setValue / GM_getValue    — Local persistent storage (manager alias)
GM_addStyle                  — CSS injection (all styles are injected this way)
GM_xmlhttpRequest            — Cross-origin HTTP to Firebase (bypasses CORS)
GM_registerMenuCommand       — Tampermonkey dropdown menu entries
```

### Target Pages (all under `https://fclm-portal.amazon.com/*`)

| Page | URL Pattern | Type Constant | Content |
|------|-------------|---------------|---------|
| Function Rollup (PPR) | `/reports/functionRollup?...&warehouseId=HDC3` | `functionRollup` | Table of AAs with links |
| AA Profile (PPR) | `/employee/timeDetails?employeeId=XXXXX&warehouseId=HDC3` | `pprProfile` | Single AA time detail |
| AA Profile (PPA) | `/employee/ppaTimeDetails?...&employeeId=XXXXX&warehouseId=HDC3` | `ppaProfile` | Single AA PPA detail |
| TOT (PPR) | `/reports/timeOnTask?&warehouseId=HDC3` | `totPPR` | Table of AAs with TOT data |
| TOT (PPA) | `/reports/ppaTimeOnTask?&warehouseId=HDC3` | `totPPA` | Table of AAs with PPA TOT |

Pages are classified into two behavioral groups:
- **Table pages** (`functionRollup`, `totPPR`, `totPPA`, `table`): Show mark buttons, row highlighting, inline badges
- **Profile pages** (`pprProfile`, `ppaProfile`, `profile`): Show employee-specific status panel

---

## 3. Backend & Networking

### Firebase Realtime Database (REST API)
- **URL:** `https://fclm-adapt-tracker-default-rtdb.firebaseio.com`
- **Auth:** Currently in test mode (open read/write) — no authentication
- **Access method:** All calls go through `GM_xmlhttpRequest` (Tampermonkey's cross-origin HTTP), NOT the Firebase SDK
- **Protocol:** REST API with `.json` suffix on all paths
- **Methods used:** GET, PUT, DELETE

### `firebaseRequest(method, path, data)` — Central Network Function
```
URL format:  {FIREBASE_DB_URL}{path}.json
Headers:     Content-Type: application/json
Timeout:     8000ms
```

**Response handling:**
- HTTP 2xx → parse JSON, set `firebaseConnected = true`, update UI status dot to green
- HTTP 4xx/5xx → log error, set `firebaseConnected = false`, update status dot to red, resolve `null`
- Network error → log, set disconnected, resolve `null`
- Timeout → log, set disconnected, resolve `null`
- **All errors resolve `null` instead of throwing** — the UI must remain functional even when Firebase is down

### `@connect` Declarations
```
// @connect      firebaseio.com
// @connect      fclm-adapt-tracker-default-rtdb.firebaseio.com
```
Both are required. The first covers any firebaseio.com subdomain; the second is the specific database host.

### Specific Firebase Operations

| Operation | Method | Path | Notes |
|-----------|--------|------|-------|
| Fetch all today's markings | GET | `/{WAREHOUSE_ID}/markings/{YYYY-MM-DD}` | Returns object or null |
| Save a marking | PUT | `/{WAREHOUSE_ID}/markings/{YYYY-MM-DD}/{sanitized_empId}` | Overwrites entire key |
| Delete a marking | DELETE | `/{WAREHOUSE_ID}/markings/{YYYY-MM-DD}/{sanitized_empId}` | |
| List all date keys | GET | `/{WAREHOUSE_ID}/markings` | For cleanup only |
| Delete old date key | DELETE | `/{WAREHOUSE_ID}/markings/{old_date}` | Cleanup |

### Key Sanitization
Employee IDs used as Firebase keys must have `.#$/[]` replaced with `_` via `sanitizeKey()`.

---

## 4. Data Model

### Firebase Path Structure
```
/{WAREHOUSE_ID}/markings/{YYYY-MM-DD}/{sanitized_employeeId}
```
Example: `/HDC3/markings/2026-03-25/202303565`

### Marking Object
```json
{
  "employeeId": "202303565",
  "employeeName": "John Smith",
  "status": "writeup",
  "markedBy": "jsmith",
  "timestamp": 1711382400000,
  "notes": "Optional manager notes"
}
```

### Status Definitions
| Key | Label | Background | Border | Icon | Priority (sort order) |
|-----|-------|-----------|--------|------|-----------------------|
| `stu_pending` | STU Pending | `#fff3cd` | `#ffc107` | ⏳ | 2 |
| `stu_complete` | STU Complete | `#ffe0b2` | `#ff9800` | ✅ | 3 |
| `writeup` | Write-Up | `#f8d7da` | `#dc3545` | ✍️ | 1 (highest) |
| `resolved` | Resolved | `#d1e7dd` | `#198754` | ✔️ | 4 |

Priority determines sort order in the side panel (write-ups shown first).

### Date Key Derivation
1. Check URL params: `startDateIntraday` or `startDateDay`
2. Parse as Date and format to `YYYY-MM-DD`
3. If no URL param or invalid: use today's date (`new Date().toISOString().slice(0, 10)`)

**Important:** The date key determines which markings are fetched and displayed. If two managers are on different pages with different date parameters, they see different marking sets. This is by design — markings are date-scoped.

### Cleanup / Expiration
- On init, fetches all date keys under `/{WAREHOUSE_ID}/markings/`
- Deletes any date key older than `CLEANUP_HOURS` (default: 48 hours)
- Comparison: `Date.now() - new Date(dateKey + 'T00:00:00').getTime() > cutoff`
- Runs asynchronously on startup (fire-and-forget)

---

## 5. Real-Time Sync System

### Polling
- `POLL_INTERVAL_MS = 10000` (every 10 seconds)
- `setInterval(pollMarkings, POLL_INTERVAL_MS)`
- Each poll: GET markings → JSON-stringify compare old vs new

### Change Detection Flow
```
pollMarkings()
  → fetchMarkings() from Firebase
  → Compare JSON.stringify(old) vs JSON.stringify(new)
  → If different AND first poll: silently apply (no notification)
  → If different AND not first poll: store as pending, show in-panel notification
  → If same: no-op
  → Always: update sync timestamp in footer
```

### Remote Change Notification (not auto-apply)
When remote changes are detected:
1. A blue notification bar appears inside the panel: "⚠️ Another manager made changes"
2. A "Sync Now" button is shown
3. Clicking "Sync Now" applies the pending changes to local state and refreshes all UI
4. The Refresh (↻) button in the header also fetches fresh and applies immediately

This design prevents disruptive mid-interaction UI updates while keeping managers informed.

### State Variables
- `pendingRemoteChanges` (boolean) — whether there are unapplied remote changes
- `pendingRemoteMarkings` (object|null) — the actual marking data waiting to be applied
- `isFirstPoll` (boolean) — suppresses notification on initial load

---

## 6. Manager Identity

### Alias System
- On first run: a styled modal (not browser `prompt()`) asks for Amazon login alias
- Stored via `GM_setValue('managerAlias', value)` — persists across sessions per-browser
- Alias is attached to every marking's `markedBy` field
- Can be changed via Tampermonkey menu command "Change Alias" or the styled modal

### Alias Modal Design
- Custom DOM modal with Amazon-inspired dark gradient header
- Clipboard emoji icon, "Associate ADAPT Tracker" title
- Centered text input with `placeholder="e.g. jsmith"`
- Hint: "Use your Amazon login (the part before @)"
- "Get Started" button (first-run) or "Update" button (change)
- Button disabled until input has content
- First-run modal cannot be dismissed via backdrop click (forces entry)
- Change modal can be dismissed via backdrop click

---

## 7. Employee Detection System

FCLM pages have varied DOM structures. The script uses 6 strategies executed in order, all feeding into the same `found` map keyed by employee ID:

| # | Strategy | Selector / Method | What it finds |
|---|----------|-------------------|---------------|
| 1 | Direct employeeId links | `a[href*="employeeId"]` | Links with employeeId query param |
| 2 | Employee path links | `a[href*="/employee/"]` | Links to employee paths (filtered to those with employeeId) |
| 3 | timeDetails links | `a[href]` matching `/timeDetails\|ppaTimeDetails/` | Time detail page links |
| 4 | Table cell scan | `tr > td` → `a[href*="employeeId"]` | Employee links inside table cells |
| 5 | Profile page URL | `window.location.href` | Current page's employeeId (profile pages only) |
| 6 | onclick handlers | `[onclick*="employeeId"]` | Elements with employeeId in onclick attrs |

### Detected Employee Object
```javascript
{
  empId: "202303565",
  empName: "John Smith",  // best name found across all strategies
  links: [DOMElement, ...],  // all <a> elements for this employee
  rows: [DOMElement, ...]    // all <tr> elements containing this employee
}
```

### Link Deduplication (Priority System)
FCLM tables often show the same employee multiple times per row (login link, name link, ID link). The script deduplicates to **one mark button and one inline badge per row** using this priority:

| Classification | Pattern | Priority |
|---------------|---------|----------|
| `login` | No spaces, not pure digits (e.g., "jsmith") | 1 (highest) |
| `name` | Contains a space (e.g., "John Smith") | 2 |
| `id` | Pure digits or fallback (e.g., "202303565") | 3 |

`pickPrimaryLink(emp, row)` filters the employee's links to those in the given `<tr>`, sorts by classification priority, and returns the best one.

### Re-detection
- DOM MutationObserver watches `document.body` for `childList + subtree` changes
- Debounced at 800ms
- On trigger: re-runs `detectEmployees()`, re-applies highlights, re-injects buttons, updates profile panel

---

## 8. UI Components

### 8.1 Side Panel (always visible, all pages)
- **Position:** Fixed, top-right, 340px wide, z-index 99999
- **Header:** Dark gradient (`#232f3e → #37475a`), draggable, contains:
  - Title: "Associate ADAPT Tracker"
  - Orange badge with active marking count
  - Green/red connection status dot (glows)
  - Buttons: Manual Add (+), Refresh (↻), Debug (🐛, only when `DEBUG=true`), Minimize (─/□)
- **Remote change notification bar:** Blue bar below header, hidden by default, shows "⚠️ Another manager made changes" with "Sync Now" button
- **Body:** Scrollable list of markings sorted by priority (write-ups first). Each item shows: status icon, employee name, status label · marked by · time, truncated notes. Click any item to open edit modal.
- **Footer:** Last sync timestamp, current date key, page type
- **Minimizable:** Toggles body + footer visibility

### 8.2 Profile Employee Panel (profile pages only)
- **Position:** Fixed, top-left, 320px wide, z-index 99998
- **Header:** Same dark gradient, draggable, titled "Employee Status"
- **Body:** Employee name (large), employee ID, then either:
  - **If marked:** Color-coded status card (bg + left border matching status), showing icon, label, "Marked by X at Y", notes. Below: "Change Status" (orange) + "Clear" (red) buttons
  - **If not marked:** Italic "No active marking for this associate" + "Mark This Associate" button (dark)
- **Replaces** the old inline banner approach

### 8.3 Marking Modal
- **Trigger:** Click mark button, click panel item, right-click employee link/row, Alt+M on profile pages
- **Structure:** Dark gradient header with employee name + ID, then:
  - If existing marking: info box showing current status, who marked, when, notes
  - 4 status radio options as large clickable cards with colored backgrounds
  - Notes textarea with orange focus ring
  - Actions: Clear (if existing, red), Cancel (gray), Save (orange)
- **Behavior:** Save → PUT to Firebase → update local state → refresh UI → close → toast. Clear → DELETE → update → refresh → close → toast.

### 8.4 Manual Add Modal
- Same structure as marking modal but with:
  - Single text input for Employee ID or login (no display name field)
  - Saves to Firebase with `employeeName` set to the entered ID
  - **Syncs to all users** — if that employee ID appears on any page, the marking will show as row highlight + badge

### 8.5 Table Page Enhancements
- **Mark buttons:** Small dark buttons (⚑) injected next to the primary link per row
- **Row highlighting:** Marked employees' `<tr>` gets background color + 4px left border matching status
- **Inline badges:** Status icon + label badge next to primary link, with tooltip showing full details

### 8.6 Right-Click Context Menu
- Intercepts `contextmenu` event
- Walks up DOM (max 10 levels) looking for `<a>` with employeeId in href, or `<tr>` containing such a link
- If found: `preventDefault()` and open marking modal
- If not found: default context menu proceeds

### 8.7 Toast Notifications
- Fixed bottom-center, dark background, 3-second auto-dismiss with opacity fade
- Used for: confirmations, warnings, sync updates

### 8.8 Debug Panel (when `DEBUG=true`)
- Fixed bottom-left, dark theme (Consolas font)
- Toggle via header button
- Shows: page type, URL, date key, Firebase status, manager alias, marking count, detected employee count
- Expandable sections: detected employees (with link/row counts), employee links on page, tables with headers, current markings JSON, raw DOM (first 3000 chars)

---

## 9. CSS Architecture

- **All CSS injected via `GM_addStyle()`** — no external stylesheets
- **Font stack:** `'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- **Color scheme:** Amazon-inspired — dark navy headers (`#232f3e`), orange accents (`#ff9900`), status-specific colors
- **All class names prefixed with `fclm-`** to avoid conflicts with FCLM portal styles
- **Transitions:** 0.15s on hover states, 0.3s on toast/highlight fade, 0.2s on input focus
- **Animations:** `fclm-fadeIn` keyframe for alias modal (scale + opacity)
- **Responsive:** Modals use `max-width: 90vw`, panels are fixed-width

---

## 10. Initialization Sequence

```
1. detectPageType() + getDateKey()     — Classify page, determine date scope
2. injectStyles()                       — Inject all CSS via GM_addStyle
3. ensureAlias()                        — Show alias modal if first run (await)
4. createPanel() + createDebugPanel()   — Build DOM for side panel + debug
5. registerMenuCommands()               — Register Tampermonkey menu items
6. waitForContent()                     — Poll up to 15s for tables/links/content
7. detectEmployees()                    — Run 6 detection strategies
8. fetchMarkings()                      — GET from Firebase, set connection status
9. refreshAllUI()                       — Render panel body, highlights, buttons, profile panel
10. setupContextMenu()                  — Attach contextmenu listener
11. setupKeyboardShortcuts()            — Attach keydown listener (Escape, Alt+M)
12. setupMutationObserver()             — Watch DOM for dynamic content changes
13. startPolling()                      — Begin 10-second Firebase poll loop
14. cleanupOldMarkings()                — Async cleanup of >48hr date keys
```

### Content Wait Strategy
FCLM pages load slowly. The script polls every 500ms (up to 30 attempts = 15 seconds):
- **Table pages:** Wait for `<table>` elements or `a[href*="employeeId"]` links
- **Profile pages:** Wait for employeeId to appear in body text or body text > 500 chars
- **Timeout:** Proceeds anyway after 15 seconds

---

## 11. Keyboard Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `Alt+M` | Open marking modal for current employee | Profile pages only |
| `Escape` | Close any open modal | Global |

---

## 12. Tampermonkey Menu Commands

| Command | Action |
|---------|--------|
| Change Alias | Opens styled alias modal |
| Clear All My Markings (Today) | Deletes only markings where `markedBy === currentAlias`, with confirm dialog |
| Export Today's Markings (CSV) | Downloads CSV: Employee ID, Employee Name, Status, Marked By, Time, Notes |

---

## 13. Configuration Constants

```javascript
FIREBASE_DB_URL      = 'https://fclm-adapt-tracker-default-rtdb.firebaseio.com'
WAREHOUSE_ID         = 'HDC3'
POLL_INTERVAL_MS     = 10000    // 10 seconds between Firebase polls
DEBUG                = true     // enables debug panel + console logging
CONTENT_WAIT_INTERVAL = 500     // ms between content readiness checks
CONTENT_WAIT_MAX     = 30       // max checks (30 × 500ms = 15 seconds)
CLEANUP_HOURS        = 48       // markings older than this are auto-deleted
DEBOUNCE_MS          = 800      // DOM mutation observer debounce
```

---

## 14. Known Constraints & Limitations

1. **No Firebase authentication** — Database is in test mode (open read/write). Any client with the URL can read/write all data. Production deployment should add Firebase security rules.
2. **No Firebase SDK** — REST-only via `GM_xmlhttpRequest`. This means no WebSocket-based real-time listeners; sync is polling-based (10s intervals).
3. **Polling, not push** — Changes from other managers take up to 10 seconds to appear as a notification, and require manual "Sync Now" to apply.
4. **Employee detection is DOM-dependent** — If Amazon changes FCLM portal HTML structure, detection strategies may break. The debug panel exists to diagnose this.
5. **Single warehouse scope** — Hardcoded to `HDC3`. Multi-warehouse would require making `WAREHOUSE_ID` configurable.
6. **Date key scoping** — Markings are scoped to the date derived from URL params or today's date. Managers viewing different dates see different marking sets.
7. **No conflict resolution** — Last-write-wins. If two managers mark the same AA simultaneously, the last PUT overwrites.
8. **Cleanup is client-side** — Old date key cleanup runs on each client's init. If no one opens the tool for 48+ hours, old data accumulates until the next visit.
9. **All CSS is inline** — Injected via `GM_addStyle`. No external stylesheet loading.
10. **No offline support** — If Firebase is unreachable, markings can't be saved or fetched. The UI shows a red status dot and warning toasts.

---

## 15. File Structure

```
FCLM ADAPT Tracker/
  fclm-adapt-tracker.user.js    — The entire application (single file, ~1,490 lines)
  TECHNICAL_BRIEF.md            — This document
```

No build system. No node_modules. No package.json. The `.user.js` file is installed directly into Tampermonkey.

---

## 16. Security Considerations

- **XSS mitigation:** All user-generated content (employee names, notes, aliases) is escaped via `escapeHtml()` before DOM insertion
- **Firebase exposure:** Database URL is in the client code. Currently open read/write. Markings contain only employee IDs, names, status labels, and manager aliases — no sensitive credentials.
- **Cross-origin:** `GM_xmlhttpRequest` bypasses CORS by design (Tampermonkey privilege). Only `firebaseio.com` domains are whitelisted via `@connect`.
- **No eval/innerHTML with raw user input** — All dynamic HTML uses escaped interpolation

---

## 17. Manual Add Sync Behavior

When a marking is created via Manual Add:
1. The employee ID entered is used as the Firebase key (sanitized)
2. `employeeName` is set to the same value as `employeeId` (no separate name field)
3. The marking is PUT to Firebase at `/{WAREHOUSE_ID}/markings/{date}/{sanitized_id}`
4. On **any** page where that employee ID is detected via the 6 strategies, the marking will:
   - Highlight the employee's row
   - Show an inline badge next to the primary link
   - Appear in the side panel's marking list
5. Other managers will see it on their next poll cycle (up to 10 seconds)

The matching works because `applyHighlights()` iterates `currentMarkings` and checks `detectedEmployees[marking.employeeId]`. If the ID matches, highlighting is applied regardless of how the marking was originally created.
