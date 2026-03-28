import { loadPyodideRuntime, getPyodide, ensureRenderPackages, ensureSqlite3 } from './pyodide-loader.js';

const ACCOUNTS_ROOT = '/accounts';
const DEFAULT_ACCOUNT = 'default';
const ACCOUNTS_STORAGE_KEY = 'coulomb_accounts';

function loadAccountsStorage() {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_STORAGE_KEY)) || { active: 'default', profiles: {} }; }
  catch { return { active: 'default', profiles: {} }; }
}

function saveAccountsStorage(data) {
  localStorage.setItem(ACCOUNTS_STORAGE_KEY, JSON.stringify(data));
}

let activeAccount = loadAccountsStorage().active || DEFAULT_ACCOUNT;

function getWorkspace() { return `${ACCOUNTS_ROOT}/${activeAccount}`; }
function getPublic() { return `${getWorkspace()}/public`; }
function getPrivate() { return `${getWorkspace()}/private`; }
function getChangelog() { return `${getWorkspace()}/changelog`; }

/**
 * Bridge between the JS UI and coulomb Python code running in Pyodide.
 * Uses pyodide.globals to pass results since runPythonAsync (exec mode)
 * does not return expression values.
 */

async function runPy(code) {
  const pyodide = getPyodide();
  pyodide.runPython('_bridge_out = None');
  await pyodide.runPythonAsync(code);
  const out = pyodide.globals.get('_bridge_out');
  pyodide.runPython('_bridge_out = None');
  return out === undefined || out === null ? null : out;
}

// ── Accounts ──

export function getActiveAccount() { return activeAccount; }
export function getWorkspacePath() { return getWorkspace(); }

export async function listAccounts() {
  const pyodide = getPyodide();
  const names = new Set();
  try {
    pyodide.FS.readdir(ACCOUNTS_ROOT).filter(e => e !== '.' && e !== '..').forEach(e => names.add(e));
  } catch {}
  const data = loadAccountsStorage();
  Object.keys(data.profiles).forEach(n => names.add(n));
  names.add(activeAccount);
  return [...names].sort();
}

export async function createAccount(name) {
  const pyodide = getPyodide();
  const path = `${ACCOUNTS_ROOT}/${name}`;
  try { pyodide.FS.stat(path); throw new Error(`Account "${name}" already exists`); } catch (e) {
    if (e.message?.includes('already exists')) throw e;
  }
  pyodide.FS.mkdir(path);
  const data = loadAccountsStorage();
  if (!data.profiles[name]) data.profiles[name] = {};
  saveAccountsStorage(data);
  return name;
}

export async function switchAccount(name) {
  const pyodide = getPyodide();
  const path = `${ACCOUNTS_ROOT}/${name}`;
  try { pyodide.FS.stat(path); } catch {
    pyodide.FS.mkdir(path);
  }
  activeAccount = name;
  const data = loadAccountsStorage();
  data.active = name;
  saveAccountsStorage(data);
  await ensureWorkspace();
}

export async function deleteAccount(name, { force = false } = {}) {
  if (name === activeAccount && !force) throw new Error('Cannot delete the active account');
  await runPy(`
import shutil, os
os.chdir('/')
path = '${ACCOUNTS_ROOT}/${name}'
if os.path.exists(path):
    shutil.rmtree(path)
`);
  const data = loadAccountsStorage();
  delete data.profiles[name];
  saveAccountsStorage(data);
}

export function getAccountProfiles() {
  return loadAccountsStorage().profiles;
}

export function updateAccountProfile(name, { author_id, display_name, avatar_url }) {
  const data = loadAccountsStorage();
  if (!data.profiles[name]) data.profiles[name] = {};
  if (author_id !== undefined) data.profiles[name].author_id = author_id;
  if (display_name !== undefined) data.profiles[name].display_name = display_name;
  if (avatar_url !== undefined) data.profiles[name].avatar_url = avatar_url;
  saveAccountsStorage(data);
}

// ── Workspace ──

export async function ensureWorkspace() {
  const pyodide = getPyodide();
  const ws = getWorkspace();
  const priv = getPrivate();
  await pyodide.runPythonAsync(`
import os
os.makedirs('${ACCOUNTS_ROOT}', exist_ok=True)
for d in ['${ws}', '${priv}']:
    os.makedirs(d, exist_ok=True)
os.chdir('${ws}')
`);
}

export async function isInitialized() {
  const result = await runPy(`
import os, glob
os.chdir('${getWorkspace()}')
identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
_bridge_out = len(identity_files) > 0
`);
  return result;
}

export async function initialize() {
  const result = await runPy(`
import os, sys, io
os.chdir('${getWorkspace()}')

os.makedirs('${getPrivate()}', exist_ok=True)
if os.path.exists('${getPublic()}'):
    import shutil
    shutil.rmtree('${getPublic()}')

_capture = io.StringIO()
_old_stdout = sys.stdout
sys.stdout = _capture

from coulomb.init import main as coulomb_init
coulomb_init(
    public='${getPublic()}',
    private='${getPrivate()}',
    source=None,
    change_log='${getChangelog()}',
    print_='id'
)

sys.stdout = _old_stdout
_bridge_out = _capture.getvalue().strip()
`);
  return result;
}

// ── Identity ──

export async function getIdentityInfo() {
  const result = await runPy(`
import os, glob, json
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
_bridge_out = None
if identity_files:
    import cbor2
    with open(identity_files[0], 'rb') as f:
        entry = cbor2.load(f)
    author = entry['content']['author']
    config = author.get('config', {})
    _bridge_out = json.dumps({
        'id': author['id'],
        'signing_keys': author.get('signing_keys', []),
        'encryption_keys': author.get('encryption_keys', []),
        'display_name': config.get('display_name', config.get('user.display_name', '')),
        'avatar_url': config.get('avatar_url', ''),
        'locations': author.get('locations', []),
        'config': config,
    })
`);
  return result ? JSON.parse(result) : null;
}

export async function setIdentityConfig(textPairs) {
  const pyodide = getPyodide();
  const pairsJson = JSON.stringify(textPairs);
  await pyodide.runPythonAsync(`
import os, glob, json
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

import cbor2
with open(identity_files[0], 'rb') as f:
    entry = cbor2.load(f)
author = entry['content']['author']
key_id = author['id']

private_key_files = glob.glob('${getPrivate()}/private_identity.*.cbor') + glob.glob('${getPrivate()}/signing.*.cbor')

_pairs = json.loads(${JSON.stringify(pairsJson)})

from coulomb.identity import set_config
with open('${getChangelog()}', 'a') as _cl:
    set_config(
        identity='${getPublic()}/identity/' + key_id,
        change_log=_cl,
        signatures=private_key_files,
        text=_pairs
    )
`);
}

export async function setDisplayName(name) {
  return setIdentityConfig([['display_name', name]]);
}

export async function setAvatarUrl(url) {
  return setIdentityConfig([['avatar_url', url]]);
}

// ── Key Management ──

export async function createSigningKey() {
  const result = await runPy(`
import os, json
os.chdir('${getWorkspace()}')

from coulomb.create_key import signing
import io, sys
_old_stdout = sys.stdout
sys.stdout = io.StringIO()
signing(private='${getPrivate()}', print_='id')
key_id = sys.stdout.getvalue().strip()
sys.stdout = _old_stdout
_bridge_out = json.dumps({'key_id': key_id})
`);
  return JSON.parse(result);
}

export async function createEncryptionKey() {
  const result = await runPy(`
import os, json
os.chdir('${getWorkspace()}')

from coulomb.create_key import encryption
import io, sys
_old_stdout = sys.stdout
sys.stdout = io.StringIO()
encryption(private='${getPrivate()}')
key_id = sys.stdout.getvalue().strip()
sys.stdout = _old_stdout
_bridge_out = json.dumps({'key_id': key_id})
`);
  return JSON.parse(result);
}

export async function addKeyToIdentity(keyFilePaths) {
  const pathsJson = JSON.stringify(keyFilePaths);
  await runPy(`
import os, glob, json
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

import cbor2
with open(identity_files[0], 'rb') as f:
    entry = cbor2.load(f)
key_id = entry['content']['author']['id']

private_key_files = glob.glob('${getPrivate()}/private_identity.*.cbor') + glob.glob('${getPrivate()}/signing.*.cbor')

from coulomb.identity import add_key
with open('${getChangelog()}', 'a') as _cl:
    add_key(
        identity='${getPublic()}/identity/' + key_id,
        change_log=_cl,
        signatures=private_key_files,
        key_files=json.loads(${JSON.stringify(pathsJson)})
    )
`);
}

export async function removeKeyFromIdentity(keyIds) {
  const idsJson = JSON.stringify(keyIds);
  await runPy(`
import os, glob, json
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

import cbor2
with open(identity_files[0], 'rb') as f:
    entry = cbor2.load(f)
key_id = entry['content']['author']['id']

private_key_files = glob.glob('${getPrivate()}/private_identity.*.cbor') + glob.glob('${getPrivate()}/signing.*.cbor')

from coulomb.identity import rm_key
with open('${getChangelog()}', 'a') as _cl:
    rm_key(
        identity='${getPublic()}/identity/' + key_id,
        change_log=_cl,
        signatures=private_key_files,
        key_ids=json.loads(${JSON.stringify(idsJson)})
    )
`);
}

export async function listKeys() {
  const result = await runPy(`
import os, glob, json
os.chdir('${getWorkspace()}')

import cbor2

# Get identity keys
identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
signing_keys = []
encryption_keys = []
if identity_files:
    with open(identity_files[0], 'rb') as f:
        entry = cbor2.load(f)
    author = entry['content']['author']
    signing_keys = author.get('signing_keys', [])
    encryption_keys = author.get('encryption_keys', [])

# Get private key files
private_signing = glob.glob('${getPrivate()}/signing.*.cbor')
private_encryption = glob.glob('${getPrivate()}/encryption.*.cbor')
private_identity = glob.glob('${getPrivate()}/private_identity.*.cbor')

_bridge_out = json.dumps({
    'signing_keys': signing_keys,
    'encryption_keys': encryption_keys,
    'private_signing': [os.path.basename(f) for f in private_signing],
    'private_encryption': [os.path.basename(f) for f in private_encryption],
    'private_identity': [os.path.basename(f) for f in private_identity],
})
`);
  return JSON.parse(result);
}

export async function addLocation(url, index = null) {
  const indexPy = index !== null ? index : 'None';
  await runPy(`
import os, glob
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

import cbor2
with open(identity_files[0], 'rb') as f:
    entry = cbor2.load(f)
key_id = entry['content']['author']['id']

private_key_files = glob.glob('${getPrivate()}/private_identity.*.cbor') + glob.glob('${getPrivate()}/signing.*.cbor')

from coulomb.identity import add_location
with open('${getChangelog()}', 'a') as _cl:
    add_location(
        identity='${getPublic()}/identity/' + key_id,
        change_log=_cl,
        signatures=private_key_files,
        location=${JSON.stringify(url)},
        index=${indexPy}
    )
`);
}

export async function removeLocation(url) {
  await runPy(`
import os, glob
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

import cbor2
with open(identity_files[0], 'rb') as f:
    entry = cbor2.load(f)
key_id = entry['content']['author']['id']

private_key_files = glob.glob('${getPrivate()}/private_identity.*.cbor') + glob.glob('${getPrivate()}/signing.*.cbor')

from coulomb.identity import rm_location
with open('${getChangelog()}', 'a') as _cl:
    rm_location(
        identity='${getPublic()}/identity/' + key_id,
        change_log=_cl,
        signatures=private_key_files,
        location=${JSON.stringify(url)}
    )
`);
}

// ── Posts ──

export async function createPost(text, files = [], replyTo = null) {
  // Write attached files to a unique temp dir in Pyodide FS
  const pyodide = getPyodide();
  const tmpDir = `/tmp/post_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pyodide.FS.mkdirTree(tmpDir);
  const filePaths = [];
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    const tmpPath = `${tmpDir}/${file.name}`;
    pyodide.FS.writeFile(tmpPath, data);
    filePaths.push(tmpPath);
  }

  const filePathsJson = JSON.stringify(filePaths);
  const result = await runPy(`
import os, glob, json
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

private_key_files = glob.glob('${getPrivate()}/private_identity.*.cbor') + glob.glob('${getPrivate()}/signing.*.cbor')

_file_paths = json.loads(${JSON.stringify(filePathsJson)})

from coulomb.post import main as coulomb_post
_post_result = coulomb_post(
    root='${getPublic()}',
    author=identity_files[0],
    text=${JSON.stringify(text)},
    files=_file_paths,
    signatures=private_key_files,
    changelogs=['${getChangelog()}'],
    reply=${replyTo ? JSON.stringify(replyTo) : 'None'}
)
_bridge_out = json.dumps({'post_path': str(_post_result) if _post_result else None})
`);

  // Clean up temp dir
  try {
    for (const p of filePaths) {
      try { pyodide.FS.unlink(p); } catch (_) {}
    }
    try { pyodide.FS.rmdir(tmpDir); } catch (_) {}
  } catch (_) {}

  return JSON.parse(result);
}

// ── Markdown ──

/**
 * Render Markdown text to sanitised HTML via the Python markdown library.
 * Returns an HTML string.
 */
export async function renderMarkdown(text) {
  const result = await runPy(`
from coulomb.markdown_render import render_markdown
_bridge_out = render_markdown(${JSON.stringify(text)})
`);
  return result || '';
}

export async function listRecentPosts(limit = 20, offset = 0) {
  const result = await runPy(`
import os, glob, json
os.chdir('${getWorkspace()}')

import cbor2
from coulomb.markdown_render import render_markdown as _render_md

# Build latest identity config map (author_id → config dict)
_latest_configs = {}
for _id_file in glob.glob('${getPublic()}/identity/*/latest.cbor'):
    try:
        with open(_id_file, 'rb') as f:
            _id_author = cbor2.load(f)['content']['author']
        _latest_configs[_id_author['id']] = _id_author.get('config', {})
    except Exception:
        pass

post_files = sorted(glob.glob('${getPublic()}/posts/**/*.cbor', recursive=True), reverse=True)
post_files = [p for p in post_files if os.path.basename(p) != 'index.cbor']
_total_count = len(post_files)
post_files = post_files[${offset}:${offset + limit}]

posts = []
for pf in post_files:
    try:
        with open(pf, 'rb') as f:
            entry = cbor2.load(f)
        content = entry['content']
        author = content.get('author', {})
        author_id = author.get('id', '')
        # Use latest identity config for display, fall back to per-post snapshot
        config = _latest_configs.get(author_id, author.get('config', {}))
        file_list = content.get('files', [])
        reply_to = content.get('reply_to', None)
        post_id = content.get('id', '')
        _text = content.get('text', '')
        # Files directory: posts/{author_id}/{post_id}/files/
        post_dir = os.path.dirname(pf)
        files_dir = os.path.join(post_dir, post_id, 'files')
        files_rel = os.path.relpath(files_dir, '${getPublic()}') if os.path.isdir(files_dir) else None
        posts.append({
            'path': pf,
            'rel_path': pf.replace('${getPublic()}/', ''),
            'text': _text,
            'text_html': _render_md(_text),
            'tags': content.get('tags', []),
            'time': content.get('time', ''),
            'author_id': author_id,
            'display_name': config.get('display_name', ''),
            'files': [f.get('name', '') for f in file_list],
            'files_dir': files_rel,
            'file_count': len(file_list),
            'reply_to': reply_to,
            'sig_count': len(entry.get('signatures', {})),
        })
    except Exception:
        pass

posts.sort(key=lambda p: p['time'], reverse=True)
_bridge_out = json.dumps({'posts': posts, 'total': _total_count})
`);
  return JSON.parse(result);
}

/**
 * Verify the cryptographic signatures on a post.
 * Returns { valid: bool, detail: string, signatures: [{key_id, ok}] }
 */
export async function verifyPost(postPath) {
  const result = await runPy(`
import json, cbor2, nacl.signing

with open(${JSON.stringify(postPath)}, 'rb') as f:
    entry = cbor2.load(f)

content = entry['content']
author = content.get('author', {})
signing_keys = set(author.get('signing_keys', []))
sigs = entry.get('signatures', {})
content_bytes = cbor2.dumps(content, canonical=True)

results = []
endorsed_ok = 0
for key_id, signature in sigs.items():
    endorsed = key_id in signing_keys
    try:
        key = nacl.signing.VerifyKey(bytes.fromhex(key_id))
        key.verify(content_bytes, signature)
        results.append({'key_id': key_id, 'ok': True, 'endorsed': endorsed})
        if endorsed:
            endorsed_ok += 1
    except Exception as e:
        results.append({'key_id': key_id, 'ok': False, 'endorsed': endorsed, 'error': str(e)})

if len(sigs) == 0:
    detail = 'No signatures'
    valid = False
elif endorsed_ok == 0:
    detail = f'{len(sigs)} signature(s), none from endorsed keys'
    valid = False
else:
    detail = f'{endorsed_ok}/{len(sigs)} valid endorsed signature(s)'
    valid = True

_bridge_out = json.dumps({'valid': valid, 'detail': detail, 'signatures': results})
`);
  return JSON.parse(result);
}

// ── Site Config ──

export async function getSiteConfig() {
  const result = await runPy(`
import os, json, glob
os.chdir('${getWorkspace()}')

import cbor2
_bridge_out = '{}'
config_files = glob.glob('${getPublic()}/config/*/latest.cbor')
if config_files:
    with open(config_files[0], 'rb') as f:
        entry = cbor2.load(f)
    _bridge_out = json.dumps(entry['content'].get('config', {}))
`);
  return JSON.parse(result);
}

export async function setSiteConfig(key, value) {
  await runPy(`
import os, glob
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

import cbor2
with open(identity_files[0], 'rb') as f:
    entry = cbor2.load(f)
key_id = entry['content']['author']['id']

private_key_files = glob.glob('${getPrivate()}/private_identity.*.cbor') + glob.glob('${getPrivate()}/signing.*.cbor')

from coulomb.config import main as config_main
config_main(
    identity='${getPublic()}/identity/' + key_id,
    change_log='${getChangelog()}',
    signatures=private_key_files,
    text=[[${JSON.stringify(key)}, ${JSON.stringify(value)}]],
    delete=[],
)
`);
}

export async function getPendingFiles() {
  const result = await runPy(`
import os, json
os.chdir('${getWorkspace()}')
changelog_path = '${getChangelog()}'
files = []
if os.path.exists(changelog_path):
    with open(changelog_path) as f:
        files = [line.strip() for line in f if line.strip()]
_bridge_out = json.dumps(files)
`);
  return JSON.parse(result);
}

export async function getAllPublicFiles() {
  const result = await runPy(`
import os, json
public = '${getPublic()}'
files = []
for dirpath, dirnames, filenames in os.walk(public):
    for fname in filenames:
        full = os.path.join(dirpath, fname)
        rel = os.path.relpath(full, public)
        files.append(rel)
_bridge_out = json.dumps(files)
`);
  return JSON.parse(result);
}

export function readWorkspaceFile(relativePath) {
  const pyodide = getPyodide();
  const fullPath = `${getPublic()}/${relativePath}`;
  try {
    return pyodide.FS.readFile(fullPath);
  } catch {
    return null;
  }
}

// ── QR Code ──

let segnoLoaded = false;

export async function generateQRCodeSVG(text) {
  if (!segnoLoaded) {
    const pyodide = getPyodide();
    await pyodide.runPythonAsync(`
import micropip
await micropip.install('segno')
`);
    segnoLoaded = true;
  }

  const result = await runPy(`
import segno, io

qr = segno.make(${JSON.stringify(text)})
buf = io.BytesIO()
qr.save(buf, kind='svg', scale=4, border=2, dark='#e94560', light='#16213e')
_bridge_out = buf.getvalue().decode()
`);
  return result;
}

export async function renderSite({ includePwa = false } = {}) {
  // jinja2 + sqlite3 are only needed for rendering, loaded lazily
  await ensureRenderPackages();

  if (includePwa) {
    // Fetch PWA files from the web server into Pyodide FS so render can bundle them
    const pyodide = getPyodide();
    const pwaFiles = [
      'index.html', 'manifest.json', 'sw.js',
      'css/style.css', 'icons/icon.svg',
      'js/app.js', 'js/coulomb-bridge.js', 'js/feed-renderer.js',
      'js/fs-sync.js', 'js/identicon.js', 'js/pyodide-loader.js',
      'js/storage/adapter.js', 'js/storage/github.js',
    ];
    const fetches = pwaFiles.map(f =>
      fetch(f).then(r => r.ok ? r.text() : null).then(text => text && { path: f, text })
    );
    const results = await Promise.all(fetches);
    for (const file of results) {
      if (file) {
        const fullPath = `/coulomb/pwa/${file.path}`;
        const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
        pyodide.FS.mkdirTree(dir);
        pyodide.FS.writeFile(fullPath, file.text);
      }
    }
  }

  await runPy(`
import os, shutil, glob
os.chdir('${getWorkspace()}')

# Render in a staging copy so original post CBOR files stay untouched
# (originals preserve signatures for future cryptographic verification)
RENDER_ROOT = '${getWorkspace()}/render_staging'
if os.path.exists(RENDER_ROOT):
    shutil.rmtree(RENDER_ROOT)
shutil.copytree('${getPublic()}', RENDER_ROOT)

# Update template CSS (may be stale from initial init)
_src = '/coulomb/template/static/global/style.css'
_dst = os.path.join(RENDER_ROOT, 'static/global/style.css')
if os.path.exists(_src):
    os.makedirs(os.path.dirname(_dst), exist_ok=True)
    shutil.copy(_src, _dst)

# Patch staging post files with latest identity config so re-renders
# pick up display name / avatar changes
import cbor2
identity_files = glob.glob(os.path.join(RENDER_ROOT, 'identity/*/latest.cbor'))
if identity_files:
    with open(identity_files[0], 'rb') as f:
        _latest_author = cbor2.load(f)['content']['author']

    for pf in glob.glob(os.path.join(RENDER_ROOT, 'posts/**/*.cbor'), recursive=True):
        if os.path.basename(pf) == 'index.cbor':
            continue
        try:
            with open(pf, 'rb') as f:
                entry = cbor2.load(f)
            post_author = entry['content']['author']
            if post_author['id'] == _latest_author['id']:
                post_author['config'] = _latest_author.get('config', {})
                with open(pf, 'wb') as f:
                    cbor2.dump(entry, f, canonical=True)
        except Exception:
            pass

from coulomb.rebuild_index import main as rebuild_index
rebuild_index(
    root=RENDER_ROOT,
    hashes=['sha512'],
    changelog=None,
    filter_=None,
)

_pwa_dir = '/coulomb/pwa' if ${includePwa ? 'True' : 'False'} and os.path.isdir('/coulomb/pwa') else None

from coulomb.render import main as coulomb_render
coulomb_render(
    root=RENDER_ROOT,
    cache_file='${getPrivate()}/render_cache.sqlite',
    hash_name='sha512',
    template_dir=None,
    change_log=None,
    post_dirs=['posts'],
    html_dir='pages',
    pwa_dir=_pwa_dir,
)

# Copy rendered pages + updated static assets back to workspace public
_copy_dirs = ['pages', 'static']
if _pwa_dir:
    _copy_dirs.append('pwa')
for subdir in _copy_dirs:
    src = os.path.join(RENDER_ROOT, subdir)
    dst = os.path.join('${getPublic()}', subdir)
    if os.path.exists(src):
        if os.path.exists(dst):
            shutil.rmtree(dst)
        shutil.copytree(src, dst)

# When bundling PWA, also copy Python source and template so the
# published site can bootstrap Pyodide (pyodide-loader.js fetches ../coulomb/)
if _pwa_dir:
    for src_dir, dst_name in [('/coulomb/coulomb', 'coulomb'), ('/coulomb/template', 'template')]:
        if os.path.isdir(src_dir):
            dst = os.path.join('${getPublic()}', dst_name)
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.copytree(src_dir, dst, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))

# Copy detail page HTML files from posts/ (without overwriting original CBOR data)
for html_file in glob.glob(os.path.join(RENDER_ROOT, 'posts/**/*.html'), recursive=True):
    rel = os.path.relpath(html_file, RENDER_ROOT)
    dst = os.path.join('${getPublic()}', rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy(html_file, dst)

# Create root index.html redirect to latest page
_index = os.path.join('${getPublic()}', 'index.html')
with open(_index, 'w') as f:
    f.write('<!doctype html><meta http-equiv="refresh" content="0;url=pages/latest.html">')
`);
}

export function getRenderedPage(pageName) {
  const pyodide = getPyodide();
  try {
    return pyodide.FS.readFile(`${getPublic()}/pages/${pageName}`, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

export function getRenderedFile(relPath) {
  const pyodide = getPyodide();
  try {
    return pyodide.FS.readFile(`${getPublic()}/${relPath}`, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

// ── Pull Sources ──

const SOURCES_STORAGE_KEY = 'coulomb_pull_sources';

function loadSourcesStorage() {
  try {
    return JSON.parse(localStorage.getItem(`${SOURCES_STORAGE_KEY}_${activeAccount}`) || '[]');
  } catch { return []; }
}

function saveSourcesStorage(sources) {
  localStorage.setItem(`${SOURCES_STORAGE_KEY}_${activeAccount}`, JSON.stringify(sources));
}

export function getPullSources() {
  return loadSourcesStorage();
}

export function addPullSource(url, label) {
  const sources = loadSourcesStorage();
  const normalized = url.replace(/\/+$/, '');
  if (sources.some(s => s.url === normalized)) return sources;
  sources.push({ url: normalized, label: label || normalized, last_pulled: null });
  saveSourcesStorage(sources);
  return sources;
}

export function removePullSource(url) {
  const sources = loadSourcesStorage().filter(s => s.url !== url);
  saveSourcesStorage(sources);
  return sources;
}

export async function pullFromSource(sourceUrl) {
  await ensureSqlite3();
  const public_ = getPublic();
  const cacheFile = `${getWorkspace()}/pull_cache.db`;
  const changelog = getChangelog();

  // In Pyodide, urllib doesn't work — use pyfetch as fetcher
  const result = await runPy(`
import json
from pyodide.http import pyfetch

async def _pyodide_fetcher(url):
    resp = await pyfetch(url)
    return (await resp.bytes()).to_py()

from coulomb.pull import main as pull_main, PullCache
# Wrap to pass async fetcher — PullCache.get needs to be sync,
# so we pre-fetch via JS fetch and cache results
import js
from pyodide.ffi import to_js

class _BrowserPullCache(PullCache):
    def get(self, location):
        from pyodide.http import open_url
        # open_url is synchronous and returns text; we need bytes
        # Use XMLHttpRequest synchronously for binary
        from js import XMLHttpRequest
        xhr = XMLHttpRequest.new()
        xhr.open('GET', location, False)
        xhr.responseType = 'arraybuffer'
        xhr.send()
        if xhr.status != 200:
            raise IOError(f'HTTP {xhr.status} fetching {location}')
        return bytes(xhr.response.to_py())

_cache = _BrowserPullCache(
    root=${JSON.stringify(public_)},
    filename=${JSON.stringify(cacheFile)},
    hash_name='sha512',
    change_log=open(${JSON.stringify(changelog)}, 'a'),
)
for _src in [${JSON.stringify(sourceUrl)}]:
    _cache.stale_check(_src)
_cache.change_log.close()
_bridge_out = str(_cache.imported_count)
`);

  const count = parseInt(result, 10) || 0;

  // Update last_pulled timestamp
  const sources = loadSourcesStorage();
  const src = sources.find(s => s.url === sourceUrl);
  if (src) {
    src.last_pulled = new Date().toISOString();
    saveSourcesStorage(sources);
  }

  return count;
}

export async function pullAllSources() {
  const sources = loadSourcesStorage();
  let total = 0;
  let failed = 0;
  for (const src of sources) {
    try {
      total += await pullFromSource(src.url);
    } catch (e) {
      failed++;
      console.error(`Pull failed for ${src.url}:`, e);
    }
  }
  return { count: total, failed };
}

export function listRenderedPages() {
  const pyodide = getPyodide();
  try {
    const files = pyodide.FS.readdir(`${getPublic()}/pages`);
    return files.filter(f => f.endsWith('.html')).sort();
  } catch {
    return [];
  }
}
