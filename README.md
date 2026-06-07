# portableweb-studio

**Experimental** browser-based viewer for `.pweb` bundles with cross-origin bundle isolation.

> **Official live site:** [portableweb.org](https://portableweb.org) / [portableweb.github.io](https://github.com/portableweb/portableweb.github.io)
>
> This org is for experimental security work. Changes here are tested before being considered for the main site. Do not rely on it for production use.

## What this is

This is the `portableweb/web` viewer adapted to run bundles on a separate origin:

- **Viewer app** → `portableweb-studio.github.io/app/`
- **Bundle execution** → `portableweb-sandbox.github.io` (separate origin, enforced by browser)

The key difference from the main site: bundles no longer run on the same origin as the viewer. They run on `portableweb-sandbox.github.io`, which means the browser's same-origin policy provides a hard security boundary between bundle JS and the viewer's storage/DOM.

## What's inside

```
docs/
  index.html        # portableweb.org marketing homepage
  icons/icon.svg    # brand icon
  app/
    index.html      # PWA app shell (dashboard, all JS/CSS inline)
    manifest.json   # Web App Manifest — file_handlers for .pweb
    sw.js           # Service Worker — caches app shell only (no bundle serving)
    app.js          # App logic — opens bundles in sandbox popup
server.js           # Express — static files + JSZip route + SPA fallback
```

## Getting started

```bash
npm install
npm start          # → http://localhost:3000
```

Note: bundle opening requires `portableweb-sandbox.github.io` to be reachable on first use (to install the sandbox service worker). After that, it works offline.

## Bundle rendering — cross-origin popup flow

1. User drops or picks a `.pweb` file — the studio unzips it into memory with JSZip.
2. A popup opens to `portableweb-sandbox.github.io/portal.html?s=<sessionId>`. The studio retains the window reference (no `noopener`).
3. Studio waits for a `{ type: 'portal-ready' }` postMessage from the sandbox.
4. In parallel, the sandbox portal registers its service worker (installs on first visit, instant thereafter).
5. Once both ready: studio sends all bundle files via postMessage with ArrayBuffer transfer (zero-copy). Files are received by the sandbox portal and stored in a per-session IndexedDB database on `portableweb-sandbox.github.io`.
6. Portal navigates to `/bundle/<sessionId>/<entry>`. The sandbox service worker intercepts the request and serves the entry HTML from IDB, injecting a security guard and setting CSP headers.
7. When opened via OS double-click (File Handling API), the launcher window closes after the popup opens.

## Security model

### True origin isolation
Bundles run on `portableweb-sandbox.github.io` — a different origin from the viewer. The browser's same-origin policy enforces:
- Bundle JS cannot read or write the studio's localStorage, IndexedDB, or cookies
- Bundle JS cannot access the studio's `window` object or DOM
- `postMessage` is the only channel between the two origins, and the viewer only accepts messages from the sandbox origin

### Additional controls applied inside the sandbox

| Threat | Control |
|---|---|
| Bundle reading another session's IDB | Per-session databases with UUID names unknown to bundles |
| Bundle accessing IDB directly | Sandbox SW injects `window.indexedDB = undefined` |
| Bundle registering a rogue service worker | Sandbox SW injects `navigator.serviceWorker = undefined` |
| Bundle spawning workers to bypass injection | CSP `worker-src 'none'` |
| Bundle exfiltrating data externally | CSP `connect-src /bundle/<sessionId>/` |

### Offline support
On first visit, the studio loads a hidden iframe from `portableweb-sandbox.github.io/install.html`, which registers the sandbox service worker in the background. After that one online visit, the sandbox works fully offline — bundle popups load from cache and serve files from IDB.

## Developer tools (dashboard)

| Tool | What it does |
|---|---|
| **Open** | Pick and open a `.pweb` bundle in a sandbox popup |
| **Unpack** | Rename `.pweb` → `.zip` and download for inspection/editing |
| **Pack** | Select a folder → build a spec-compliant `.pweb` |
| **Validate** | Run 12 spec checks against a `.pweb` |
| **New Project** | Fill a short form → download a ready-to-edit starter `.pweb` |

## Related

| Repo | Purpose |
|---|---|
| [portableweb-sandbox](https://github.com/portableweb-sandbox/portableweb-sandbox.github.io) | Isolated bundle execution origin (experimental) |
| [portableweb/portableweb.github.io](https://github.com/portableweb/portableweb.github.io) | Official live site |
| [portableweb/spec](https://github.com/portableweb/spec) | v0.1 spec, `hello.pweb` example |
| [portableweb/cli](https://github.com/portableweb/cli) | `pweb` CLI — `pack`, `validate`, `init` |
| [portableweb/viewer](https://github.com/portableweb/viewer) | Native desktop viewer (Tauri) |

## License

MIT — see [portableweb/spec](https://github.com/portableweb/spec) for the CC-BY 4.0 spec license.
