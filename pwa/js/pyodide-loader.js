const PYODIDE_VERSION = '0.27.4';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let pyodideInstance = null;
let _sqlite3Loaded = false;
let _jinja2Loaded = false;

export async function loadPyodideRuntime(onProgress) {
  if (pyodideInstance) return pyodideInstance;

  onProgress?.('Loading Pyodide runtime…', 10);

  // Dynamically load the Pyodide loader script
  if (!window.loadPyodide) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${PYODIDE_CDN}pyodide.js`;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  onProgress?.('Initializing Python…', 30);

  pyodideInstance = await window.loadPyodide({
    indexURL: PYODIDE_CDN,
  });

  onProgress?.('Installing packages…', 50);

  // Install micropip, then batch-install essential packages in parallel
  await pyodideInstance.loadPackage('micropip');
  const micropip = pyodideInstance.pyimport('micropip');

  // PyNaCl (with cffi + libsodium bindings) installs and works in Pyodide
  await Promise.all([micropip.install('cbor2'), micropip.install('pynacl')]);

  onProgress?.('Loading Coulomb…', 75);

  // Fetch all coulomb source files in parallel
  await loadCoulombSource(pyodideInstance);

  onProgress?.('Ready', 100);

  return pyodideInstance;
}

/**
 * Ensure sqlite3 is loaded (needed for pull cache and render cache).
 */
export async function ensureSqlite3() {
  if (_sqlite3Loaded) return;
  await pyodideInstance.loadPackage('sqlite3');
  _sqlite3Loaded = true;
}

/**
 * Load packages only needed for rendering (jinja2, sqlite3).
 * Called lazily on first renderSite() to keep boot fast.
 */
export async function ensureRenderPackages() {
  const loads = [];
  if (!_jinja2Loaded) {
    const micropip = pyodideInstance.pyimport('micropip');
    loads.push(micropip.install('jinja2').then(() => { _jinja2Loaded = true; }));
  }
  if (!_sqlite3Loaded) loads.push(ensureSqlite3());
  if (loads.length) await Promise.all(loads);
}

async function loadCoulombSource(pyodide) {
  // Fetch coulomb Python source files and write them to the virtual FS
  const coulombFiles = [
    '__init__.py',
    '__main__.py',
    'cmd.py',
    'config.py',
    'init.py',
    'post.py',
    'create_key.py',
    'identity.py',
    'pull.py',
    'index_walker.py',
    'render.py',
    'rebuild_index.py',
    'verify.py',
    'TimeArchive.py',
    'util.py',
  ];

  pyodide.FS.mkdirTree('/coulomb/coulomb');
  pyodide.FS.mkdirTree('/coulomb/template/static/global');

  // Fetch all source files in parallel
  const fetches = [
    ...coulombFiles.map(fname =>
      fetch(`../coulomb/${fname}`).then(r => r.ok ? r.text() : null)
        .then(text => text && { path: `/coulomb/coulomb/${fname}`, text })
        .catch(() => null)
    ),
    fetch('../template/static/global/style.css').then(r => r.ok ? r.text() : null)
      .then(text => text && { path: '/coulomb/template/static/global/style.css', text })
      .catch(() => null),
  ];

  const results = await Promise.all(fetches);
  for (const file of results) {
    if (file) pyodide.FS.writeFile(file.path, file.text);
  }

  await pyodide.runPythonAsync(`
import sys
if '/coulomb' not in sys.path:
    sys.path.insert(0, '/coulomb')
`);
}

export function getPyodide() {
  return pyodideInstance;
}
