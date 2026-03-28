const DB_NAME = 'coulomb-fs';
const DB_VERSION = 1;
const STORE_NAME = 'files';

let db = null;

async function openDB() {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE_NAME, { keyPath: 'path' });
      store.createIndex('dir', 'dir', { unique: false });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

// Save the Pyodide virtual FS working directory to IndexedDB.
// Uses the changelog for incremental saves when available;
// falls back to full-tree save when force=true or no changelog exists.
export async function saveToIDB(pyodide, basePath = '/workspace', { force = false } = {}) {
  const idb = await openDB();
  const publicDir = `${basePath}/public`;
  const privateDir = `${basePath}/private`;

  let filesToSave;
  const changelog = getChangelogEntries(pyodide, basePath);

  if (!force && changelog.length > 0) {
    // Incremental: save only changed files (from changelog) + private dir + workspace root files
    const changedPaths = new Set();
    for (const relPath of changelog) {
      changedPaths.add(`${publicDir}/${relPath}`);
    }
    // Always include private dir (keys)
    for (const f of listFilesRecursive(pyodide, privateDir)) {
      changedPaths.add(f);
    }
    // Always include workspace root-level files (changelog, pull_cache.db, etc.)
    try {
      for (const name of pyodide.FS.readdir(basePath)) {
        if (name === '.' || name === '..') continue;
        const full = `${basePath}/${name}`;
        try {
          if (!pyodide.FS.isDir(pyodide.FS.stat(full).mode)) changedPaths.add(full);
        } catch {}
      }
    } catch {}
    filesToSave = [...changedPaths].filter(p => {
      try { pyodide.FS.stat(p); return true; } catch { return false; }
    });
  } else {
    // Full save: enumerate everything
    filesToSave = listFilesRecursive(pyodide, basePath);
  }

  const tx = idb.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  for (const filePath of filesToSave) {
    try {
      const data = pyodide.FS.readFile(filePath);
      const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
      store.put({ path: filePath, dir, data: data.buffer, mtime: Date.now() });
    } catch (e) {
      console.warn(`Failed to save ${filePath}:`, e);
    }
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(filesToSave.length);
    tx.onerror = () => reject(tx.error);
  });
}

// Restore files from IndexedDB into the Pyodide virtual FS
export async function restoreFromIDB(pyodide, basePath = '/workspace') {
  const idb = await openDB();
  const tx = idb.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const all = store.getAll();

  return new Promise((resolve, reject) => {
    all.onsuccess = () => {
      const files = all.result.filter(f => f.path.startsWith(basePath));
      let failCount = 0;
      for (const file of files) {
        try {
          ensureDir(pyodide, file.path.substring(0, file.path.lastIndexOf('/')));
          pyodide.FS.writeFile(file.path, new Uint8Array(file.data));
        } catch (e) {
          failCount++;
          console.warn(`Failed to restore ${file.path}:`, e);
        }
      }
      if (failCount > 0) {
        console.error(`${failCount}/${files.length} files failed to restore from IndexedDB`);
      }
      resolve({ total: files.length, failed: failCount });
    };
    all.onerror = () => reject(all.error);
  });
}

// Delete all IDB entries under a prefix
export async function deleteFromIDB(basePath) {
  const idb = await openDB();
  const tx = idb.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const all = store.getAllKeys();

  return new Promise((resolve, reject) => {
    all.onsuccess = () => {
      const keys = all.result.filter(k => k.startsWith(basePath));
      for (const key of keys) store.delete(key);
      resolve(keys.length);
    };
    all.onerror = () => reject(all.error);
  });
}

// List all files in IDB under a prefix (for sync/publish)
export async function listIDBFiles(basePath = '/workspace') {
  const idb = await openDB();
  const tx = idb.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const all = store.getAll();

  return new Promise((resolve, reject) => {
    all.onsuccess = () => {
      resolve(all.result.filter(f => f.path.startsWith(basePath)));
    };
    all.onerror = () => reject(all.error);
  });
}

// Read a single file from IDB
export async function readIDBFile(path) {
  const idb = await openDB();
  const tx = idb.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(path);

  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result.data) : null);
    req.onerror = () => reject(req.error);
  });
}

// Get the changelog (list of changed files since last publish)
export async function getChangelog(pyodide, basePath = '/workspace') {
  const changelogPath = `${basePath}/changelog`;
  try {
    const content = pyodide.FS.readFile(changelogPath, { encoding: 'utf8' });
    return content.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Clear the changelog after a successful publish
export async function clearChangelog(pyodide, basePath = '/workspace') {
  const changelogPath = `${basePath}/changelog`;
  try {
    pyodide.FS.writeFile(changelogPath, '');
  } catch {
    // Changelog may not exist yet
  }
}

function listFilesRecursive(pyodide, dirPath) {
  const results = [];
  try {
    const entries = pyodide.FS.readdir(dirPath).filter(e => e !== '.' && e !== '..');
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry}`;
      const stat = pyodide.FS.stat(fullPath);
      if (pyodide.FS.isDir(stat.mode)) {
        results.push(...listFilesRecursive(pyodide, fullPath));
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist yet
  }
  return results;
}

// Synchronous changelog read for use by saveToIDB
function getChangelogEntries(pyodide, basePath) {
  const changelogPath = `${basePath}/changelog`;
  try {
    const content = pyodide.FS.readFile(changelogPath, { encoding: 'utf8' });
    return content.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ── Export / Import ──

// Export the full workspace as a tar.gz blob for portability.
// Uses Python's tarfile module running in Pyodide.
export async function exportWorkspace(pyodide, basePath = '/workspace', { includePrivate = true } = {}) {
  const { runPythonAsync } = pyodide;
  const includePvt = includePrivate ? 'True' : 'False';
  await runPythonAsync(`
import tarfile, io, os, json

_base = ${JSON.stringify(basePath)}
_buf = io.BytesIO()

with tarfile.open(fileobj=_buf, mode='w:gz') as tar:
    for dirpath, dirnames, filenames in os.walk(_base):
        rel = os.path.relpath(dirpath, _base)
        # Skip render staging
        if rel.startswith('render_staging'):
            continue
        # Optionally skip private keys
        if not ${includePvt} and rel.startswith('private'):
            continue
        for fname in filenames:
            full = os.path.join(dirpath, fname)
            arcname = os.path.join('workspace', os.path.relpath(full, _base))
            tar.add(full, arcname=arcname)

_export_data = _buf.getvalue()
`);
  const data = pyodide.globals.get('_export_data');
  const bytes = data.toJs();
  pyodide.runPython('del _export_data');
  return new Blob([bytes], { type: 'application/gzip' });
}

// Import a workspace tar.gz blob, replacing the current workspace.
export async function importWorkspace(pyodide, blob, basePath = '/workspace') {
  const buffer = await blob.arrayBuffer();
  const data = new Uint8Array(buffer);
  pyodide.FS.writeFile('/tmp/_import.tar.gz', data);

  await pyodide.runPythonAsync(`
import tarfile, os, shutil

_base = ${JSON.stringify(basePath)}

# Back up private keys in case import doesn't include them
_private_backup = _base + '_private_bak'
_private_dir = os.path.join(_base, 'private')
if os.path.exists(_private_dir):
    if os.path.exists(_private_backup):
        shutil.rmtree(_private_backup)
    shutil.copytree(_private_dir, _private_backup)

# Clear workspace
if os.path.exists(_base):
    shutil.rmtree(_base)
os.makedirs(_base, exist_ok=True)

with tarfile.open('/tmp/_import.tar.gz', 'r:gz') as tar:
    for member in tar.getmembers():
        # Strip leading 'workspace/' prefix
        if member.name.startswith('workspace/'):
            member.name = member.name[len('workspace/'):]
        else:
            continue
        dest = os.path.join(_base, member.name)
        if member.isdir():
            os.makedirs(dest, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            f = tar.extractfile(member)
            if f:
                with open(dest, 'wb') as out:
                    out.write(f.read())

# Restore private keys if import didn't include them
_private_dir = os.path.join(_base, 'private')
if not os.path.exists(_private_dir) and os.path.exists(_private_backup):
    shutil.copytree(_private_backup, _private_dir)
if os.path.exists(_private_backup):
    shutil.rmtree(_private_backup)

os.remove('/tmp/_import.tar.gz')
`);
}

function ensureDir(pyodide, dirPath) {
  const parts = dirPath.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    try {
      pyodide.FS.stat(current);
    } catch {
      pyodide.FS.mkdir(current);
    }
  }
}
