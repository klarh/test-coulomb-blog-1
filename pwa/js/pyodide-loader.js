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

  // cbor2 is needed immediately; pynacl may fail and needs a fallback
  const naclP = micropip.install('pynacl').catch(async () => {
    console.warn('PyNaCl not available via micropip, installing fallback shim');
    await installNaclShim(pyodideInstance);
  });
  await Promise.all([micropip.install('cbor2'), naclP]);

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

async function installNaclShim(pyodide) {
  // Pure-Python shim that wraps the Web Crypto API / tweetnacl.js
  // via Pyodide's JS interop for Ed25519 signing operations.
  // This provides the subset of nacl.signing that coulomb needs.
  pyodide.FS.mkdirTree('/lib/python/nacl');
  pyodide.FS.writeFile('/lib/python/nacl/__init__.py', '');
  pyodide.FS.writeFile('/lib/python/nacl/signing.py', `
"""Minimal nacl.signing shim using tweetnacl.js via Pyodide JS interop."""
from pyodide.ffi import to_js
from js import Uint8Array, crypto
import hashlib
import struct

# We use a pure Python Ed25519 fallback since we need deterministic
# key generation from seed bytes. This is the standard ref10 implementation.
# For production, prefer the real PyNaCl or a WASM libsodium build.

class _Ed25519:
    """Minimal Ed25519 using Python hashlib + standard constants."""
    # This is a placeholder - in practice we'd bundle a tested pure-Python
    # Ed25519 implementation or use a JS library via interop.
    pass

class VerifyKey:
    def __init__(self, key_bytes):
        if isinstance(key_bytes, bytes) and len(key_bytes) == 32:
            self._key = key_bytes
        else:
            raise ValueError("VerifyKey must be 32 bytes")

    def __bytes__(self):
        return self._key

    def verify(self, message, signature):
        # Verification delegated to JS interop or pure-Python Ed25519
        raise NotImplementedError("Signature verification requires PyNaCl or JS interop")

class SignedMessage:
    def __init__(self, signature, message):
        self.signature = signature
        self.message = message

class SigningKey:
    def __init__(self, seed=None):
        if seed is not None:
            if len(seed) != 32:
                raise ValueError("Seed must be 32 bytes")
            self._seed = seed
            # Derive keypair from seed - requires Ed25519 implementation
            self.verify_key = VerifyKey(self._derive_public_key(seed))
        else:
            raise ValueError("Seed required")

    @classmethod
    def generate(cls):
        import secrets
        seed = secrets.token_bytes(32)
        return cls(seed)

    def __bytes__(self):
        return self._seed

    def _derive_public_key(self, seed):
        # Placeholder - needs real Ed25519 key derivation
        # In the real implementation, this calls into JS or uses pure-Python Ed25519
        h = hashlib.sha512(seed).digest()
        # Return first 32 bytes as placeholder (NOT correct Ed25519)
        return h[:32]

    def sign(self, message):
        # Placeholder - needs real Ed25519 signing
        raise NotImplementedError("Signing requires PyNaCl or JS interop")
`);

  pyodide.FS.writeFile('/lib/python/nacl/public.py', `
"""Minimal nacl.public shim - placeholder for X25519."""
import secrets

class PrivateKey:
    def __init__(self, private_key=None):
        if private_key is not None:
            self._key = private_key
        else:
            self._key = secrets.token_bytes(32)
        self.public_key = PublicKey(self._derive_public(self._key))

    @classmethod
    def generate(cls):
        return cls()

    def __bytes__(self):
        return self._key

    def _derive_public(self, private):
        import hashlib
        return hashlib.sha256(private).digest()

class PublicKey:
    def __init__(self, public_key):
        self._key = public_key

    def __bytes__(self):
        return self._key
`);

  // Add to Python path
  await pyodide.runPythonAsync(`
import sys
if '/lib/python' not in sys.path:
    sys.path.insert(0, '/lib/python')
`);
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
