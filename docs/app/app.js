const App = (() => {
  /* State */
  let currentBundle = null; // { manifest, sessionId }
  let openedViaFileHandler = false;

  /* ── Helpers ─────────────────────────────────────────────────────────── */

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, children = []) => {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k.startsWith('data-')) e.dataset[k.slice(5)] = v;
      else e[k] = v;
    });
    children.forEach(c => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return e;
  };

  function showToast(msg, isError = false) {
    const t = $('toast');
    t.textContent = msg;
    t.className = isError ? 'error' : '';
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 3000);
  }

  function showError(msg) { showToast(msg, true); }

  function showLoading(msg = 'Loading…') {
    $('loading-msg').textContent = msg;
    $('loading').classList.add('active');
  }

  function hideLoading() { $('loading').classList.remove('active'); }

  function setView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $('view-' + name).classList.add('active');
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ── IndexedDB helpers ────────────────────────────────────────────────── */

  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('portableweb', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('bundle-files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function storeBundle(sessionId, entries) {
    const db = await openIDB();
    const tx = db.transaction('bundle-files', 'readwrite');
    const store = tx.objectStore('bundle-files');
    for (const { path, data, mime } of entries) {
      store.put({ data, mime }, `${sessionId}/${path}`);
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  function clearBundle(sessionId) {
    openIDB().then(db => {
      const tx = db.transaction('bundle-files', 'readwrite');
      tx.objectStore('bundle-files').delete(
        IDBKeyRange.bound(`${sessionId}/`, `${sessionId}/￿`)
      );
      tx.oncomplete = () => db.close();
    }).catch(() => {});
  }

  function getMime(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    return {
      html: 'text/html', htm: 'text/html',
      css: 'text/css',
      js: 'application/javascript', mjs: 'application/javascript', cjs: 'application/javascript',
      json: 'application/json',
      svg: 'image/svg+xml',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
      ico: 'image/x-icon',
      woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
      mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
      ogg: 'audio/ogg', wav: 'audio/wav',
      txt: 'text/plain', md: 'text/markdown',
    }[ext] || 'application/octet-stream';
  }

  /* Open a file picker that returns a File promise */
  function pickFile(accept) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = accept;
      inp.addEventListener('change', () => resolve(inp.files[0] || null));
      inp.click();
    });
  }

  /* ── Bundle open ──────────────────────────────────────────────────────── */

  async function openBundle(file) {
    if (!('serviceWorker' in navigator)) {
      showError('Your browser must support Service Workers to open .pweb bundles.');
      return;
    }

    // The SW must be controlling this page before we set the iframe src,
    // otherwise it won't intercept /app/bundle/* requests.
    // On first load the SW installs and claims via clients.claim() — wait for it.
    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise(resolve =>
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Viewer timed out initialising. Please reload and try again.')), 8000)
        ),
      ]);
    }

    showLoading('Opening bundle…');
    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());

      /* Parse manifest */
      const mf = zip.file('manifest.json');
      if (!mf) throw new Error('Invalid bundle: missing manifest.json');
      const manifest = JSON.parse(await mf.async('text'));
      for (const k of ['spec_version', 'title', 'entry']) {
        if (!manifest[k]) throw new Error(`manifest.json is missing required field: "${k}"`);
      }

      /* Extract every file and store in IndexedDB */
      const sessionId = crypto.randomUUID
        ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');

      const entries = [];
      await Promise.all(
        Object.values(zip.files)
          .filter(entry => !entry.dir)
          .map(entry =>
            entry.async('uint8array').then(data => {
              entries.push({ path: entry.name, data, mime: getMime(entry.name) });
            })
          )
      );

      await storeBundle(sessionId, entries);

      /* Clear previous session */
      if (currentBundle?.sessionId) clearBundle(currentBundle.sessionId);

      currentBundle = { manifest, sessionId, filename: file.name };
      showViewer();
    } catch (e) {
      showError(e.message);
    } finally {
      hideLoading();
    }
  }

  function showViewer() {
    const { manifest, sessionId } = currentBundle;
    const toolbar = $('viewer-toolbar');

    if (openedViaFileHandler) {
      /* Opened via OS double-click — no toolbar, window title = bundle title */
      document.title = manifest.title;
      if (toolbar) toolbar.style.display = 'none';
    } else {
      /* Opened from inside the app — show toolbar with bundle name, window = PortableWeb */
      document.title = 'PortableWeb';
      const titleEl = $('viewer-title');
      if (titleEl) titleEl.textContent = manifest.title;
      if (toolbar) toolbar.style.display = 'flex';
    }

    $('viewer-frame').src = `/app/bundle/${sessionId}/${manifest.entry}`;
    setView('viewer');
  }

  function closeViewer() {
    $('viewer-frame').src = 'about:blank';
    if (currentBundle?.sessionId) clearBundle(currentBundle.sessionId);
    currentBundle = null;
    openedViaFileHandler = false;
    document.title = 'PortableWeb';
    setView('dashboard');
  }

  /* ── Developer tools ──────────────────────────────────────────────────── */

  async function doUnpack() {
    const file = await pickFile('.pweb,application/vnd.portableweb+zip');
    if (!file) return;
    const bytes = await file.arrayBuffer();
    const blob = new Blob([bytes], { type: 'application/zip' });
    downloadBlob(blob, file.name.replace(/\.pweb$/, '.zip'));
    showToast('Saved as ' + file.name.replace(/\.pweb$/, '.zip'));
  }

  function promptForPackManifest() {
    return new Promise((resolve) => {
      const dlg = $('dialog-pack-manifest');
      const form = $('form-pack-manifest');
      form.reset();
      let submitted = false;

      function onSubmit(e) {
        e.preventDefault();
        submitted = true;
        const data = Object.fromEntries(new FormData(form));
        form.removeEventListener('submit', onSubmit);
        dlg.close();
        resolve(data);
      }

      function onClose() {
        form.removeEventListener('submit', onSubmit);
        if (!submitted) resolve(null);
      }

      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('close', onClose, { once: true });
      dlg.showModal();
    });
  }

  async function doPack() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.webkitdirectory = true;
    inp.multiple = true;
    const files = await new Promise(r => { inp.addEventListener('change', () => r(Array.from(inp.files))); inp.click(); });
    if (!files.length) return;

    const rootDir = files[0].webkitRelativePath.split('/')[0];
    const normalized = files
      .map(f => ({ file: f, path: f.webkitRelativePath.slice(rootDir.length + 1) }))
      .filter(f => f.path);

    let generatedManifest = null;

    if (!normalized.some(f => f.path === 'manifest.json')) {
      const data = await promptForPackManifest();
      if (!data) return;

      const title = data.title.trim();
      const description = data.description ? data.description.trim() : '';
      const author = data.author ? data.author.trim() : '';
      const rawId = data.id ? data.id.trim() : '';
      const bundleId = rawId || `org.portableweb.${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '')}`;

      const manifest = {
        spec_version: '0.1',
        id: bundleId,
        version: '1.0.0',
        title,
        entry: 'index.html',
        created: new Date().toISOString().split('T')[0],
        ...(description && { description }),
        ...(author && { author: { name: author } }),
      };

      generatedManifest = JSON.stringify(manifest, null, 2);
    }

    showLoading('Packing bundle…');
    try {
      const zip = new JSZip();
      /* mimetype must be first, uncompressed — EPUB convention */
      zip.file('mimetype', 'application/vnd.portableweb+zip', { compression: 'STORE' });

      for (const { file, path } of normalized) {
        if (path === 'mimetype') continue;
        zip.file(path, await file.arrayBuffer());
      }

      if (generatedManifest) {
        zip.file('manifest.json', generatedManifest);
      }

      const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.portableweb+zip' });
      const name = rootDir + '.pweb';
      downloadBlob(blob, name);
      showToast('Created ' + name);
    } catch (e) {
      showError(e.message);
    } finally {
      hideLoading();
    }
  }

  async function doValidate() {
    const file = await pickFile('.pweb,application/vnd.portableweb+zip');
    if (!file) return;

    showLoading('Validating…');
    const checks = [];

    try {
      const ab = await file.arrayBuffer();
      const u8 = new Uint8Array(ab);

      /* 1 – ZIP signature */
      const isZip = u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 0x03 && u8[3] === 0x04;
      checks.push({ ok: isZip, label: 'Valid ZIP format' });
      if (!isZip) { checks.push({ ok: false, label: 'Cannot continue — not a valid ZIP' }); throw 0; }

      /* 2 – mimetype is first entry */
      const view = new DataView(ab);
      const fnLen = view.getUint16(26, true);
      const firstName = new TextDecoder().decode(new Uint8Array(ab, 30, fnLen));
      checks.push({ ok: firstName === 'mimetype', label: 'mimetype is the first entry' });

      /* 3 – mimetype is STORE (uncompressed) */
      checks.push({ ok: view.getUint16(8, true) === 0, label: 'mimetype uses STORE (uncompressed)' });

      const zip = await JSZip.loadAsync(ab);

      /* 4 – mimetype value */
      const mimetypeEntry = zip.file('mimetype');
      const mimeOk = mimetypeEntry && (await mimetypeEntry.async('text')).trim() === 'application/vnd.portableweb+zip';
      checks.push({ ok: !!mimeOk, label: 'mimetype value is application/vnd.portableweb+zip' });

      /* 5 – manifest.json present */
      const manifestEntry = zip.file('manifest.json');
      checks.push({ ok: !!manifestEntry, label: 'manifest.json exists' });
      if (!manifestEntry) throw 0;

      /* 6 – manifest.json parses */
      let manifest;
      try {
        manifest = JSON.parse(await manifestEntry.async('text'));
        checks.push({ ok: true, label: 'manifest.json is valid JSON' });
      } catch {
        checks.push({ ok: false, label: 'manifest.json is valid JSON' });
        throw 0;
      }

      /* 7-11 – required fields */
      for (const field of ['spec_version', 'id', 'version', 'title', 'entry']) {
        checks.push({ ok: !!manifest[field], label: `manifest.${field} present` });
      }

      /* 12 – entry file exists */
      if (manifest.entry) {
        checks.push({ ok: !!zip.file(manifest.entry), label: `Entry file exists (${manifest.entry})` });
      }
    } catch (_) { /* partial results are fine */ }

    hideLoading();

    const passed = checks.filter(c => c.ok).length;
    const total = checks.length;
    const allPass = passed === total;

    $('validate-title').textContent = `Validation — ${file.name}`;
    $('validate-results').innerHTML = `
      <div class="validate-score ${allPass ? 'pass' : 'fail'}">
        ${passed} / ${total} checks passed ${allPass ? '&#10003;' : ''}
      </div>
      <div class="validate-list">
        ${checks.map(c => `
          <div class="validate-item ${c.ok ? 'ok' : 'fail'}">
            <span class="validate-icon">${c.ok ? '&#10003;' : '&#10007;'}</span>
            <span>${c.label}</span>
          </div>
        `).join('')}
      </div>
    `;
    $('dialog-validate').showModal();
  }

  function doNew() { $('dialog-new').showModal(); }

  async function generateNewProject(data) {
    const { title, description, author, id, format } = data;
    const asPweb = format !== 'zip';
    const bundleId = id.trim() || `org.portableweb.${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '')}`;
    const slug = title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '') || 'bundle';

    const manifest = {
      spec_version: '0.1',
      id: bundleId,
      version: '1.0.0',
      title: title.trim(),
      description: description.trim() || undefined,
      author: author.trim() ? { name: author.trim() } : undefined,
      entry: 'index.html',
      created: new Date().toISOString().split('T')[0],
    };
    Object.keys(manifest).forEach(k => manifest[k] === undefined && delete manifest[k]);

    const css = `/* ${title} — PortableWeb v0.1 */
:root {
  --ink:        #0f0f1a;
  --ink-soft:   #2d2d50;
  --paper:      #f7f8ff;
  --surface:    #edeeff;
  --accent:     #7c3aed;
  --blue:       #2563eb;
  --teal:       #20d6d2;
  --muted:      #6565a0;
  --gradient:   linear-gradient(135deg, #7c3aed 0%, #2563eb 46%, #20d6d2 100%);
  --serif:      ui-serif, "Iowan Old Style", "Apple Garamond", Baskerville, "Times New Roman", serif;
  --sans:       ui-sans-serif, system-ui, -apple-system, sans-serif;
  --mono:       ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --radius:     10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink:      #e8e8ff;
    --ink-soft: #b0b0d8;
    --paper:    #08080f;
    --surface:  #0f0f1e;
    --muted:    #7070a8;
  }
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  background: var(--paper);
  color: var(--ink);
  font-family: var(--serif);
  font-size: 18px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
main {
  max-width: 680px;
  margin: 4rem auto;
  padding: 0 1.5rem;
}
header {
  margin-bottom: 2.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid rgba(15,15,26,0.12);
}
@media (prefers-color-scheme: dark) {
  header { border-bottom-color: rgba(232,232,255,0.1); }
}
.eyebrow {
  font-family: var(--mono);
  font-size: 0.65rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 1rem;
}
.eyebrow::before {
  content: "";
  display: inline-block;
  width: 20px;
  height: 2px;
  background: var(--gradient);
  border-radius: 2px;
  flex-shrink: 0;
}
h1 {
  font-size: clamp(2rem, 5vw, 2.75rem);
  font-style: italic;
  font-weight: 400;
  line-height: 1.1;
  letter-spacing: -0.02em;
  margin-bottom: 1rem;
}
h1 .highlight {
  background: var(--gradient);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.lead {
  font-size: 1.1rem;
  color: var(--ink-soft);
  max-width: 32em;
}
.badge {
  display: inline-block;
  margin-top: 1.5rem;
  padding: 0.4rem 1rem;
  background: var(--gradient);
  color: #fff;
  font-family: var(--mono);
  font-size: 0.7rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  border-radius: 4px;
  cursor: pointer;
  border: none;
  transition: opacity 0.15s;
}
.badge:hover { opacity: 0.85; }
section {
  margin-top: 2.5rem;
}
h2 {
  font-size: 1.3rem;
  font-weight: 400;
  font-style: italic;
  margin-bottom: 0.75rem;
  color: var(--ink);
}
p { margin-bottom: 0.85rem; color: var(--ink-soft); max-width: 36em; }
a { color: var(--accent); }
code {
  font-family: var(--mono);
  font-size: 0.82em;
  background: var(--surface);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--accent);
}
pre {
  margin: 0.75rem 0 0.85rem;
  padding: 14px 16px;
  background: var(--surface);
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius) var(--radius) 0;
  overflow-x: auto;
}
pre code {
  background: none;
  padding: 0;
  font-size: 0.85rem;
  color: var(--ink-soft);
}
`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">PortableWeb &middot; v0.1</p>
      <h1><span class="highlight">${escHtml(title)}</span></h1>
      ${description ? `<p class="lead">${escHtml(description)}</p>` : '<p class="lead">An interactive document that lives in a file you own.</p>'}
      <button class="badge" onclick="this.textContent = this.textContent === 'Hello!' ? '${escJs(title)}' : 'Hello!'">
        Say hello &rarr;
      </button>
    </header>

    <section>
      <h2>Get started</h2>
      <p>Edit <code>index.html</code> and <code>style.css</code> to build your interactive document.</p>
      <p><strong>To pack into a .pweb:</strong> open the
         <a href="https://portableweb.org/app/" target="_blank" rel="noopener">PortableWeb viewer</a>,
         click <strong>Pack</strong>, and select this project folder.
         (Tip: dragging a folder into the viewer doesn&rsquo;t work &mdash; use the Pack button.)</p>
      <p><strong>Or use the CLI:</strong></p>
      <pre><code>npm install -g portableweb
pweb pack ./          # short alias
portableweb pack ./   # full name</code></pre>
    </section>
  </main>
  <script>
    console.log('%c${escJs(title)}%c — PortableWeb v0.1',
      'background:linear-gradient(90deg,#7c3aed,#2563eb,#20d6d2);color:#fff;padding:2px 8px;border-radius:3px',
      'color:inherit'
    );
  <\/script>
</body>
</html>
`;

    const zip = new JSZip();

    if (asPweb) {
      /* spec-compliant: mimetype first, uncompressed */
      zip.file('mimetype', 'application/vnd.portableweb+zip', { compression: 'STORE' });
    }

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('index.html', html);
    zip.file('style.css', css);

    showLoading('Generating…');
    try {
      if (asPweb) {
        const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.portableweb+zip' });
        downloadBlob(blob, slug + '.pweb');
        showToast('Downloaded ' + slug + '.pweb');
      } else {
        const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
        downloadBlob(blob, slug + '.zip');
        showToast('Downloaded ' + slug + '.zip — unzip to edit, then pack when ready');
      }
    } finally {
      hideLoading();
    }
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escJs(s) {
    return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  }

  /* ── Bundle info panel ───────────────────────────────────────────────── */
  function showBundleInfo() {
    if (!currentBundle) return;
    const m = currentBundle.manifest;

    const perms = m.permissions;
    const permHtml = Array.isArray(perms) && perms.length
      ? `<div class="perm-list">${perms.map(p => `<span class="perm-badge">${escHtml(p)}</span>`).join('')}</div>`
      : '<span style="color:var(--muted);font-size:13px">none declared</span>';

    const rows = [
      ['Title',    escHtml(m.title)],
      ['ID',       `<code style="font-size:12px">${escHtml(m.id || '—')}</code>`],
      ['Version',  escHtml(m.version || '—')],
      ['Spec',     escHtml(m.spec_version || '—')],
      ['Entry',    `<code style="font-size:12px">${escHtml(m.entry || '—')}</code>`],
      ['Author',   escHtml((m.author?.name || m.author) || '—')],
      ['Permissions', permHtml],
    ].filter(([, v]) => v !== '—');

    $('info-body').innerHTML = `<table class="info-table">${
      rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')
    }</table>`;
    $('info-title').textContent = m.title;
    $('dialog-info').showModal();
  }


  /* ── PWA: File Handling API (OS file-open) ───────────────────────────── */
  function setupFileHandling() {
    if (!('launchQueue' in window)) return;
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files.length) return;
      try {
        openedViaFileHandler = true;
        const file = await params.files[0].getFile();
        await openBundle(file);
      } catch (e) {
        showError(String(e));
      }
    });
  }

  /* ── Drag-and-drop ────────────────────────────────────────────────────── */
  function setupDragDrop() {
    let enterCount = 0;
    const overlay = $('drop-overlay');

    const hasPweb = (dt) => {
      if (!dt) return false;
      for (const item of dt.items) {
        if (item.kind === 'file') return true;
      }
      return false;
    };

    document.addEventListener('dragenter', (e) => {
      if (!hasPweb(e.dataTransfer)) return;
      enterCount++;
      overlay.classList.add('active');
    });

    document.addEventListener('dragleave', (e) => {
      enterCount = Math.max(0, enterCount - 1);
      if (enterCount === 0) {
        overlay.classList.remove('active');
      }
    });

    document.addEventListener('dragover', (e) => e.preventDefault());

    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      enterCount = 0;
      overlay.classList.remove('active');

      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (file.name.endsWith('.pweb') || file.type.includes('portableweb')) {
        await openBundle(file);
      } else {
        showError('Please drop a .pweb file');
      }
    });
  }

  /* ── PWA install prompt ───────────────────────────────────────────────── */
  function setupInstallPrompt() {
    let deferredPrompt = null;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      const btn = $('btn-install');
      const hint = $('install-manual-hint');
      if (btn) { btn.hidden = false; }
      if (hint) { hint.hidden = true; }
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
    });

    $('btn-install')?.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') deferredPrompt = null;
    });
  }

  /* ── Mobile hint ──────────────────────────────────────────────────────── */
  function setupMobileHint() {
    const isTouch = navigator.maxTouchPoints > 0;
    if (isTouch) {
      const hint = $('open-drag-hint');
      if (hint) hint.textContent = 'or tap to pick a file from your device';
    }
  }

  /* ── Event wiring ─────────────────────────────────────────────────────── */
  function setupEvents() {
    $('btn-open').addEventListener('click', async () => {
      const file = await pickFile('.pweb,application/vnd.portableweb+zip');
      if (file) openBundle(file);
    });

    $('btn-unpack').addEventListener('click', doUnpack);
    $('btn-pack').addEventListener('click', doPack);
    $('btn-validate').addEventListener('click', doValidate);
    $('btn-new').addEventListener('click', doNew);
    $('btn-generate').addEventListener('click', doNew);

    $('btn-back').addEventListener('click', closeViewer);
    $('btn-info')?.addEventListener('click', showBundleInfo);

    $('form-new').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      $('dialog-new').close();
      await generateNewProject(data);
    });

    /* Close buttons on dialogs */
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dlg = $(btn.dataset.close);
        if (dlg) dlg.close();
      });
    });

    /* Close dialog on backdrop click */
    document.querySelectorAll('dialog').forEach(dlg => {
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg) dlg.close();
      });
    });
  }

  /* ── Service Worker registration ─────────────────────────────────────── */
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/app/sw.js').catch(() => {});
    }
  }

  /* ── Init ─────────────────────────────────────────────────────────────── */
  function init() {
    setupFileHandling();
    setupDragDrop();
    setupInstallPrompt();
    setupMobileHint();
    setupEvents();
    registerSW();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);