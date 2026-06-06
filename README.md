# @portableweb/web

Node.js server powering **portableweb.org** — marketing homepage at `/` and browser-based PWA viewer at `/app/`.

## What's inside

```
public/
  index.html        # portableweb.org marketing homepage
  icons/icon.svg    # brand icon (used by both pages and the PWA manifest)
  app/
    index.html      # PWA app shell (dashboard + viewer, all JS/CSS inline)
    manifest.json   # Web App Manifest — file_handlers for .pweb, offline icons
    sw.js           # Service Worker — pre-caches app shell for offline use
server.js           # Express — static files + JSZip route + SPA fallback
```

## Getting started

```bash
npm install
npm start          # → http://localhost:3000
```

Set `PORT` env var to change the port.

## Routes

| Path | What it serves |
|---|---|
| `/` | Marketing homepage |
| `/app/` | PWA viewer app |
| `/app/jszip.min.js` | JSZip 3.x (served from node_modules, cached by SW) |
| `/icons/icon.svg` | Brand icon |

Any `/app/*` path not matched by a static file falls back to the app shell (SPA routing).

## PWA features

**File Handling API** — when the PWA is installed in Chrome or Edge on desktop, opening a `.pweb` file from the OS launches the app directly. The app receives the file via `window.launchQueue` and renders it immediately.

**Drag-and-drop** — drop a `.pweb` file anywhere on the window to open it.

**File picker** — the "Choose .pweb file" button opens a native file picker. On mobile, this opens the system file browser.

**Offline** — the service worker pre-caches the app shell (HTML, manifest, SW, JSZip, icon) on install. The viewer works fully offline once cached.

**Share Target** — the manifest declares a share target so `.pweb` files can be shared to the app from the OS share sheet (Android / desktop).

## Developer tools (dashboard)

| Tool | What it does |
|---|---|
| **Open** | Pick and render a `.pweb` bundle in the viewer |
| **Unpack** | Rename `.pweb` → `.zip` and download for inspection/editing |
| **Pack** | Select a folder → build a spec-compliant `.pweb` (mimetype first, STORE compression) |
| **Validate** | Run 12 spec checks against a `.pweb` and show a pass/fail report |
| **New Project** | Fill a short form → download a ready-to-edit starter `.pweb` |

## Bundle rendering

Bundles open in a dedicated popup window (not an iframe). The flow:

1. User drops or picks a `.pweb` file — the app unpacks it with JSZip and stores every file in a per-session IndexedDB database named `portableweb-<sessionId>`.
2. A popup window opens immediately (while the user gesture is still active) to `/app/bundle-portal.html?s=<sessionId>`. The portal polls its own session database until the files are ready, then navigates to the bundle's entry point.
3. The service worker intercepts all requests under `/app/bundle/<sessionId>/` and serves them from the session database, so the bundle runs entirely offline with no network round-trips.
4. When opened via OS double-click (File Handling API), the launcher window closes itself after the popup opens — the user sees only the bundle window.

## Security model

Bundles run at the same origin as the viewer (`portableweb.org`), so several explicit controls are applied to prevent a malicious bundle from escaping its session.

### `noopener` popup
The popup is opened with `noopener,noreferrer`. `window.opener` is permanently `null` inside the bundle window for its entire lifetime, even after the portal navigates to the bundle URL. The bundle cannot reach back to the viewer app's window, DOM, or call methods on it.

### Per-session IndexedDB isolation
Each bundle session is stored in its own database (`portableweb-<sessionId>`). A bundle's JavaScript knows its own session ID from its URL, so it can open its own database. It does not know other sessions' UUIDs and cannot target them by name.

### API lockdown via SW injection
The service worker injects a guard script into the `<head>` of every HTML response it serves for a bundle, before any of the bundle's own scripts run:

```js
// Injected by SW into bundle HTML — runs first, cannot be bypassed by bundle scripts
Object.defineProperty(window, 'indexedDB', { get: () => undefined, configurable: false });
Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: false });
```

- **`indexedDB` → `undefined`**: Bundles cannot enumerate or access any IndexedDB database, including their own session database or any other bundle's. Raw storage access is revoked entirely; the viewer storage API (planned) will be the sanctioned path.
- **`navigator.serviceWorker` → `undefined`**: Bundles cannot register a service worker that could shadow or interfere with the viewer's own SW.

### CSP `worker-src 'none'`
Every bundle response is served with a `Content-Security-Policy` header that includes `worker-src 'none'`. This blocks `new Worker()` and `new SharedWorker()` at the browser level before they can be instantiated. Workers would otherwise get a fresh JS scope not covered by the HTML injection.

### CSP `connect-src`
Network requests from inside a bundle are restricted to the bundle's own session path (`/app/bundle/<sessionId>/`). The bundle cannot make fetch or XHR calls to external servers or to other parts of the viewer origin.

### Summary

| Threat | Control |
|---|---|
| Bundle accessing viewer window DOM/methods | `noopener` — `window.opener` is null |
| Bundle reading/writing another session's files | Per-session IDB databases with UUID names |
| Bundle accessing any IndexedDB directly | SW injects `window.indexedDB = undefined` |
| Bundle registering a rogue service worker | SW injects `navigator.serviceWorker = undefined` |
| Bundle spawning workers that bypass JS injection | CSP `worker-src 'none'` |
| Bundle exfiltrating data to external servers | CSP `connect-src /app/bundle/<sessionId>/` |

### Known remaining gap
A bundle could call `indexedDB.databases()` (Chrome/Firefox) to enumerate all databases on the origin and discover other sessions' UUID-named databases — **but** the `window.indexedDB = undefined` injection now prevents this entirely on the main thread, and workers are blocked by CSP. The only residual gap is if a bundle somehow bypasses the injection (e.g. accesses `IDBFactory` via a prototype chain trick). True origin isolation (separate subdomain per bundle) would close this completely but is not feasible for an offline-first PWA without infrastructure changes.

## Related packages

| Repo | Purpose |
|---|---|
| [`portableweb/spec`](https://github.com/portableweb/spec) | v0.1 spec, `hello.pweb` example, container and manifest docs |
| [`portableweb/cli`](https://github.com/portableweb/cli) | `pweb` CLI — `pack`, `validate`, `init` |
| [`portableweb/viewer`](https://github.com/portableweb/viewer) | Native desktop viewer (Tauri) with full sandbox and `pweb://` protocol |

## Known issues / TODOs

### Recent files re-open (not yet implemented)

The "Recent" section in the dashboard stores filenames and titles in `localStorage`
but cannot re-open files — the browser has no persistent access to the original file
path after the session ends.

**Fix:** Use the [File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
to store a `FileSystemFileHandle` per recent entry in IndexedDB.
On click, call `handle.requestPermission({ mode: 'read' })` to re-acquire access,
then `handle.getFile()` → `openBundle(file)`.

Caveats:
- Chrome/Edge desktop only (no Firefox, no mobile Safari)
- Requires a user permission re-prompt each browser session
- Handle goes stale if the file is moved or deleted

### Domain categorisation — submit to enterprise web filters

New domains default to "Uncategorized" in enterprise web filters, which most
corporate firewalls block. Submit portableweb.org to each vendor's portal and
request the category **Technology / Information Technology / Open Source Software**.

| Vendor | Submission URL |
|---|---|
| Cisco Umbrella / Talos | https://investigate.umbrella.com |
| Palo Alto Networks | https://urlfiltering.paloaltonetworks.com |
| Zscaler | https://zscaler.com/tools/url-categorization |
| Fortinet FortiGuard | https://fortiguard.com/webfilter |
| Symantec / Broadcom | https://sitereview.symantec.com |
| Barracuda | https://barracudacentral.org/lookups |
| McAfee / Trellix | https://trustedsource.org |
| Webroot BrightCloud | https://brightcloud.com/tools/url-ip-lookup |
| IBM X-Force | https://exchange.xforce.ibmcloud.com |
| Trend Micro | https://sitesafety.trendmicro.com |
| Google Safe Browsing | https://transparencyreport.google.com/safe-browsing/search |

Priority: **Cisco and Palo Alto** are the most common in enterprise environments.
Most vendors review within 24–72 hours.

## License

MIT — see [portableweb/spec](https://github.com/portableweb/spec) for the CC-BY 4.0 spec license.
