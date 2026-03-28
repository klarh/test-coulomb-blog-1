import { loadPyodideRuntime, getPyodide } from './pyodide-loader.js';
import { saveToIDB, restoreFromIDB, deleteFromIDB, getChangelog, clearChangelog, exportWorkspace, importWorkspace } from './fs-sync.js';
import {
  ensureWorkspace, isInitialized, initialize, getIdentityInfo,
  setDisplayName, setAvatarUrl, setIdentityConfig,
  addLocation, removeLocation,
  createPost, listRecentPosts, getPendingFiles, getAllPublicFiles,
  readWorkspaceFile, renderSite, verifyPost,
  getSiteConfig, setSiteConfig, generateQRCodeSVG,
  getActiveAccount, getWorkspacePath, listAccounts, createAccount, switchAccount, deleteAccount,
  getAccountProfiles, updateAccountProfile,
  getPullSources, addPullSource, removePullSource, pullFromSource, pullAllSources
} from './coulomb-bridge.js';
import { GitHubPagesBackend } from './storage/github.js';
import { renderFeed } from './feed-renderer.js';
import { generateIdenticonSVG } from './identicon.js';

// ── Theme ──
function applyTheme(accent, mode) {
  if (accent) {
    document.documentElement.style.setProperty('--accent', accent);
  } else {
    document.documentElement.style.removeProperty('--accent');
  }
  if (mode === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else if (mode === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function getThemeStorageKey() {
  return `coulomb_theme_${getActiveAccount()}`;
}

function loadAndApplyTheme() {
  const saved = JSON.parse(localStorage.getItem(getThemeStorageKey()) || '{}');
  applyTheme(saved.accent, saved.mode);
}

// ── State ──
let pyodide = null;
let backend = new GitHubPagesBackend();
let currentView = 'feed';
let replyTarget = null; // { path, text, author_id }

// ── Service Worker Registration ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

// ── Boot ──
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  const progress = document.getElementById('load-progress');
  const status = document.getElementById('load-status');

  try {
    pyodide = await loadPyodideRuntime((msg, pct) => {
      status.textContent = msg;
      progress.value = pct;
    });

    await ensureWorkspace();

    // One-time migration from old /workspace path
    status.textContent = 'Restoring data…';
    progress.value = 90;
    if (!localStorage.getItem('coulomb_migrated_workspace')) {
      const oldRestored = await restoreFromIDB(pyodide, '/workspace');
      if (oldRestored.total > 0) {
        await pyodide.runPythonAsync(`
import os, shutil
old = '/workspace'
new = '${getWorkspacePath()}'
for item in os.listdir(old):
    src = os.path.join(old, item)
    dst = os.path.join(new, item)
    if not os.path.exists(dst):
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
`);
        await deleteFromIDB('/workspace');
        console.log(`Migrated ${oldRestored.total} files from legacy /workspace`);
      }
      localStorage.setItem('coulomb_migrated_workspace', '1');
    }

    progress.value = 95;
    const restored = await restoreFromIDB(pyodide, getWorkspacePath());
    if (restored.total > 0) {
      console.log(`Restored ${restored.total} files from IndexedDB`);
      if (restored.failed > 0) {
        console.warn(`${restored.failed} file(s) failed to restore`);
      }
    }

    // Migrate any old global GitHub config to the active account
    GitHubPagesBackend.migrateGlobalConfig(getActiveAccount());
    backend.setAccountScope(getActiveAccount());
    backend.tryRestore();

    // Apply saved theme for active account
    loadAndApplyTheme();

    document.getElementById('loading-screen').classList.add('hidden');

    // Check for key import via URL fragment (before routing)
    const isProvision = await checkKeyImport();

    // Restore view and account from URL hash
    if (!isProvision) {
      const { account, view } = parseHash(location.hash);
      if (account && account !== getActiveAccount()) {
        const accounts = await listAccounts();
        if (accounts.includes(account)) {
          await switchAccount(account);
          await restoreFromIDB(getPyodide(), getWorkspacePath());
          backend.setAccountScope(account);
          backend.tryRestore();
          loadAndApplyTheme();
        }
      }
      showView(view || 'feed', { updateHash: false });
    } else {
      showView('sync', { updateHash: false });
    }

    bindEvents();
    await refreshSidebar();
    await refreshCurrentView();
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    console.error('Boot failed:', e);
  }
}

// ── Navigation ──
const VALID_VIEWS = ['feed', 'identity', 'sync'];

function showView(name, { updateHash = true } = {}) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.remove('hidden');
  document.getElementById(`nav-${name}`).classList.add('active');
  currentView = name;
  if (updateHash) {
    const account = getActiveAccount();
    const hashView = name === 'feed' ? '' : name;
    const hashAccount = account === 'default' ? '' : account;
    const parts = [hashAccount, hashView].filter(Boolean);
    const newHash = parts.length ? '#' + parts.join('/') : '';
    if (location.hash !== newHash) history.replaceState(null, '', newHash || location.pathname);
  }
}

function parseHash(hash) {
  if (!hash || hash === '#') return { account: null, view: null };
  const parts = hash.slice(1).split('/');
  // Provisioning hashes are handled separately
  if (parts[0] === 'provision' || parts[0] === 'import') return { account: null, view: null, provision: true };
  // Determine if first segment is a view or an account name
  if (VALID_VIEWS.includes(parts[0])) return { account: null, view: parts[0] };
  // First segment is account, second (if any) is view
  const account = parts[0] || null;
  const view = parts[1] && VALID_VIEWS.includes(parts[1]) ? parts[1] : null;
  return { account, view };
}

// ── Event Binding ──
function bindEvents() {
  // Hash-based routing
  window.addEventListener('hashchange', async () => {
    const { account, view, provision } = parseHash(location.hash);
    if (provision) return; // provisioning hashes handled elsewhere
    if (account && account !== getActiveAccount()) {
      const accounts = await listAccounts();
      if (accounts.includes(account)) {
        await handleSwitchAccount(account);
        return; // handleSwitchAccount calls showView
      }
    }
    const targetView = view || 'feed';
    if (targetView !== currentView) {
      showView(targetView, { updateHash: false });
      await refreshCurrentView();
    }
  });

  // Navigation
  document.getElementById('nav-feed').addEventListener('click', async () => {
    closeSidebar(); showView('feed'); await refreshFeed();
  });
  document.getElementById('nav-identity').addEventListener('click', async () => {
    closeSidebar(); showView('identity'); await refreshIdentity();
  });
  document.getElementById('nav-sync').addEventListener('click', async () => {
    closeSidebar(); showView('sync'); await refreshSync();
  });

  // Feed / Compose
  document.getElementById('btn-post').addEventListener('click', handlePost);
  document.getElementById('post-files').addEventListener('change', handleFileSelect);
  document.getElementById('btn-cancel-reply').addEventListener('click', cancelReply);

  // Identity
  document.getElementById('btn-init').addEventListener('click', handleInit);
  document.getElementById('btn-save-profile').addEventListener('click', handleSaveProfile);
  document.getElementById('btn-add-config').addEventListener('click', handleAddConfig);
  document.getElementById('btn-add-location').addEventListener('click', handleAddLocation);
  document.getElementById('btn-save-site-config').addEventListener('click', handleSaveSiteConfig);

  // Sync
  document.getElementById('btn-github-lookup').addEventListener('click', handleGitHubLookup);
  document.getElementById('btn-github-create-repo').addEventListener('click', handleGitHubCreateRepo);
  document.getElementById('btn-github-connect').addEventListener('click', handleGitHubConnect);
  document.getElementById('btn-github-disconnect').addEventListener('click', handleGitHubDisconnect);
  document.getElementById('btn-publish').addEventListener('click', handlePublish);
  const pwaCheckbox = document.getElementById('publish-include-pwa');
  pwaCheckbox.checked = localStorage.getItem('coulomb_bundle_pwa') === '1';
  pwaCheckbox.addEventListener('change', () => {
    localStorage.setItem('coulomb_bundle_pwa', pwaCheckbox.checked ? '1' : '0');
  });

  // Accounts
  document.getElementById('btn-sidebar-create-account').addEventListener('click', handleCreateAccount);

  // Data portability
  document.getElementById('btn-export').addEventListener('click', handleExport);
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', handleImport);

  // Device provisioning
  document.getElementById('btn-request-key').addEventListener('click', handleRequestKey);
  document.getElementById('btn-provision-send').addEventListener('click', handleProvisionSend);
  document.getElementById('btn-provision-receive').addEventListener('click', handleProvisionReceive);

  // Pull sources
  document.getElementById('btn-add-source').addEventListener('click', handleAddSource);
  document.getElementById('btn-pull-all').addEventListener('click', handlePullAll);

  // Theme color picker live preview
  document.getElementById('theme-accent').addEventListener('input', (e) => {
    document.getElementById('theme-accent-hex').textContent = e.target.value;
    document.documentElement.style.setProperty('--accent', e.target.value);
  });
}

// ── Feed ──
async function handlePost() {
  const textEl = document.getElementById('post-text');
  const text = textEl.value.trim();
  if (!text) return;

  const btn = document.getElementById('btn-post');
  const statusEl = document.getElementById('post-status');
  const fileInput = document.getElementById('post-files');

  btn.disabled = true;
  btn.textContent = 'Posting…';

  try {
    const initialized = await isInitialized();
    if (!initialized) {
      showStatus(statusEl, 'No identity found — redirecting to Identity tab.', 'error');
      showView('identity'); await refreshIdentity();
      return;
    }

    const files = Array.from(fileInput.files || []);
    const replyPath = replyTarget ? replyTarget.path : null;

    await createPost(text, files, replyPath);
    await saveToIDB(pyodide, getWorkspacePath());

    textEl.value = '';
    fileInput.value = '';
    document.getElementById('attached-files').textContent = '';
    cancelReply();
    showStatus(statusEl, 'Post created!', 'success');
    await refreshFeed();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post';
  }
}

function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  const el = document.getElementById('attached-files');
  el.textContent = files.length > 0
    ? files.map(f => `${f.name} (${formatSize(f.size)})`).join(', ')
    : '';
}

function setReplyTarget(post) {
  replyTarget = post;
  const ctx = document.getElementById('reply-context');
  const label = document.getElementById('reply-label');
  label.textContent = `Replying to: "${truncate(post.text, 60)}"`;
  ctx.classList.remove('hidden');
  document.getElementById('post-text').focus();
}

function cancelReply() {
  replyTarget = null;
  document.getElementById('reply-context').classList.add('hidden');
}

async function refreshFeed() {
  const PAGE_SIZE = 50;
  try {
    const { posts, total } = await listRecentPosts(PAGE_SIZE, 0);
    const container = document.getElementById('feed-container');
    const feedOpts = {
      onReply: (post) => setReplyTarget(post),
      onVerify: async (post, btn, statusEl) => {
        btn.disabled = true;
        btn.textContent = '⏳ Verifying…';
        try {
          const result = await verifyPost(post.path);
          if (result.valid) {
            btn.textContent = '✅ Valid';
            btn.classList.add('verified');
            statusEl.textContent = result.detail;
            statusEl.className = 'feed-verify-status valid';
          } else {
            btn.textContent = '❌ Invalid';
            btn.classList.add('failed');
            statusEl.textContent = result.detail;
            statusEl.className = 'feed-verify-status invalid';
          }
        } catch (e) {
          btn.textContent = '❌ Error';
          statusEl.textContent = e.message;
          statusEl.className = 'feed-verify-status invalid';
        }
      },
      onOpenFile: (post, filename) => {
        if (!post.files_dir) return null;
        return readWorkspaceFile(`${post.files_dir}/${filename}`);
      },
    };

    let loadedCount = posts.length;
    const onLoadMore = total > loadedCount ? async (btn) => {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const { posts: morePosts } = await listRecentPosts(PAGE_SIZE, loadedCount);
        loadedCount += morePosts.length;
        const hasMore = loadedCount < total;
        renderFeed(container, posts.concat(morePosts), { ...feedOpts, hasMore: hasMore, onLoadMore: hasMore ? onLoadMore : null });
        posts.push(...morePosts);
      } catch (e) {
        btn.textContent = 'Load more';
        btn.disabled = false;
        console.error('Failed to load more:', e);
      }
    } : null;

    renderFeed(container, posts, { ...feedOpts, hasMore: total > loadedCount, onLoadMore });
  } catch (e) {
    console.error('Failed to load feed:', e);
  }
}

// ── Identity ──
async function handleInit() {
  const btn = document.getElementById('btn-init');
  const statusEl = document.getElementById('identity-status');

  btn.disabled = true;
  btn.textContent = 'Initializing…';

  try {
    const keyId = await initialize();
    await saveToIDB(pyodide, getWorkspacePath());
    showStatus(statusEl, `Identity created! Key: ${keyId.slice(0, 16)}…`, 'success');
    await refreshSidebar();
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Initialize Identity';
  }
}

async function handleSaveProfile() {
  const name = document.getElementById('display-name').value.trim();
  const avatar = document.getElementById('avatar-url').value.trim();
  const statusEl = document.getElementById('identity-status');

  const pairs = [];
  if (name) pairs.push(['display_name', name]);
  if (avatar) pairs.push(['avatar_url', avatar]);
  if (pairs.length === 0) return;

  try {
    await setIdentityConfig(pairs);
    await saveToIDB(pyodide, getWorkspacePath());
    showStatus(statusEl, 'Profile updated!', 'success');
    try {
      const info = await getIdentityInfo();
      if (info) updateAccountProfile(getActiveAccount(), {
        author_id: info.id,
        display_name: info.display_name,
        avatar_url: info.avatar_url
      });
      await refreshSidebar();
    } catch {}
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleAddConfig() {
  const keyEl = document.getElementById('config-new-key');
  const valEl = document.getElementById('config-new-value');
  const key = keyEl.value.trim();
  const value = valEl.value.trim();
  if (!key || !value) return;

  const statusEl = document.getElementById('identity-status');

  try {
    await setIdentityConfig([[key, value]]);
    await saveToIDB(pyodide, getWorkspacePath());
    keyEl.value = '';
    valEl.value = '';
    showStatus(statusEl, `Config "${key}" set!`, 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleRemoveConfig(key) {
  const statusEl = document.getElementById('identity-status');
  try {
    await setIdentityConfig([[key, '']]);
    await saveToIDB(pyodide, getWorkspacePath());
    showStatus(statusEl, `Config "${key}" removed!`, 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleAddLocation() {
  const urlEl = document.getElementById('location-new-url');
  const url = urlEl.value.trim();
  if (!url) return;

  const statusEl = document.getElementById('identity-status');

  try {
    await addLocation(url);
    await saveToIDB(pyodide, getWorkspacePath());
    urlEl.value = '';
    showStatus(statusEl, 'Location added!', 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleRemoveLocation(url) {
  const statusEl = document.getElementById('identity-status');
  try {
    await removeLocation(url);
    await saveToIDB(pyodide, getWorkspacePath());
    showStatus(statusEl, 'Location removed!', 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleSaveSiteConfig() {
  const title = document.getElementById('site-title').value.trim();
  const accent = document.getElementById('theme-accent').value;
  const mode = document.getElementById('theme-mode').value;
  const statusEl = document.getElementById('identity-status');

  try {
    if (title) await setSiteConfig('user_post.page_title', title);
    await setSiteConfig('theme.accent', accent);
    await setSiteConfig('theme.mode', mode);
    await saveToIDB(pyodide, getWorkspacePath());

    // Apply and cache theme locally for instant boot
    applyTheme(accent, mode);
    localStorage.setItem(getThemeStorageKey(), JSON.stringify({ accent, mode }));

    showStatus(statusEl, 'Site settings saved!', 'success');
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function refreshIdentity() {
  const infoSection = document.getElementById('identity-info');
  const initSection = document.getElementById('identity-init');
  const statusEl = document.getElementById('identity-status');

  try {
    const info = await getIdentityInfo();

    if (info) {
      infoSection.classList.remove('hidden');
      initSection.classList.add('hidden');

      // Identity summary
      const avatarHtml = info.avatar_url
        ? `<img src="${escapeHtml(info.avatar_url)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover">`
        : '';
      document.getElementById('identity-details').innerHTML = `
        ${avatarHtml}
        <div><strong>Key ID:</strong> <code>${info.id}</code></div>
        <div><strong>Display Name:</strong> ${info.display_name || '<em>not set</em>'}</div>
      `;

      // Profile fields
      document.getElementById('display-name').value = info.display_name || '';
      document.getElementById('avatar-url').value = info.avatar_url || '';

      // Custom config
      const configEl = document.getElementById('config-fields');
      const reserved = new Set(['display_name', 'user.display_name', 'avatar_url']);
      const customKeys = Object.entries(info.config || {}).filter(([k]) => !reserved.has(k));
      if (customKeys.length > 0) {
        configEl.innerHTML = customKeys.map(([k, v]) =>
          `<div class="config-row">
            <span class="config-key">${escapeHtml(k)}</span>
            <span class="config-value">${escapeHtml(v)}</span>
            <button class="remove-btn" data-config-key="${escapeAttr(k)}">✕</button>
          </div>`
        ).join('');
        configEl.querySelectorAll('.remove-btn[data-config-key]').forEach(btn => {
          btn.addEventListener('click', () => handleRemoveConfig(btn.dataset.configKey));
        });
      } else {
        configEl.innerHTML = '<p style="color:var(--text-muted)">No custom config set</p>';
      }

      // Locations
      const locsEl = document.getElementById('locations-list');
      if (info.locations.length > 0) {
        locsEl.innerHTML = info.locations.map(loc =>
          `<div class="location-row">
            <a href="${escapeHtml(loc)}" target="_blank" rel="noopener">${escapeHtml(loc)}</a>
            <button class="remove-btn" data-location="${escapeAttr(loc)}">✕</button>
          </div>`
        ).join('');
        locsEl.querySelectorAll('.remove-btn[data-location]').forEach(btn => {
          btn.addEventListener('click', () => handleRemoveLocation(btn.dataset.location));
        });
      } else {
        locsEl.innerHTML = '<p style="color:var(--text-muted)">No locations set</p>';
      }

      // Keys
      const keysEl = document.getElementById('keys-list');
      const signingKeys = info.signing_keys || [];
      const encKeys = info.encryption_keys || [];
      let keysHtml = '';
      if (signingKeys.length > 0) {
        keysHtml += '<div><strong>Signing:</strong></div>';
        keysHtml += signingKeys.map(k => `<div class="key-row"><code>${k}</code></div>`).join('');
      }
      if (encKeys.length > 0) {
        keysHtml += '<div><strong>Encryption:</strong></div>';
        keysHtml += encKeys.map(k => `<div class="key-row"><code>${k}</code></div>`).join('');
      }
      keysEl.innerHTML = keysHtml || '<p style="color:var(--text-muted)">Default signing key only</p>';

      // Site config
      try {
        const siteConfig = await getSiteConfig();
        document.getElementById('site-title').value = siteConfig['user_post.page_title'] || '';
        const themeAccent = siteConfig['theme.accent'] || '#e94560';
        const themeMode = siteConfig['theme.mode'] || 'dark';
        document.getElementById('theme-accent').value = themeAccent;
        document.getElementById('theme-accent-hex').textContent = themeAccent;
        document.getElementById('theme-mode').value = themeMode;
      } catch {
        // ignore
      }

      // Danger zone
      const dangerEl = document.getElementById('danger-zone-content');
      const activeAccount = getActiveAccount();
      dangerEl.innerHTML = `
        <p>Permanently delete the <strong>${escapeHtml(activeAccount)}</strong> account and all its data.</p>
        <button id="btn-delete-account" class="danger-btn">Delete "${escapeHtml(activeAccount)}" Account</button>
      `;
      document.getElementById('btn-delete-account').addEventListener('click', () => handleDeleteAccount(activeAccount));
    } else {
      infoSection.classList.add('hidden');
      initSection.classList.remove('hidden');
    }
  } catch (e) {
    console.error('Failed to load identity:', e);
    infoSection.classList.add('hidden');
    initSection.classList.remove('hidden');
    showStatus(statusEl, `Error loading identity: ${e.message}`, 'error');
  }
}

// ── Sync ──
async function handleGitHubLookup() {
  const token = document.getElementById('github-token').value.trim();
  const statusEl = document.getElementById('github-auth-status');
  if (!token) {
    showStatus(statusEl, 'Enter a token first', 'error');
    return;
  }

  const btn = document.getElementById('btn-github-lookup');
  btn.disabled = true;
  btn.textContent = 'Looking up…';

  try {
    const username = await backend.fetchUser(token);
    if (username) {
      // Pre-fill repo field with username/feed
      const repoInput = document.getElementById('github-repo');
      if (!repoInput.value) {
        repoInput.value = `${username}/${username}.github.io`;
      }
      // Update "create on GitHub" link with pre-filled name
      const createLink = document.getElementById('github-create-repo-link');
      createLink.href = `https://github.com/new?name=${encodeURIComponent(username + '.github.io')}&description=${encodeURIComponent('My Coulomb feed')}`;
      showStatus(statusEl, `Token valid — GitHub user: ${username}`, 'success');
    } else {
      showStatus(statusEl, 'Invalid token or API error', 'error');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Look Up Username';
  }
}

async function handleGitHubCreateRepo() {
  const token = document.getElementById('github-token').value.trim();
  const statusEl = document.getElementById('github-auth-status');
  if (!token) {
    showStatus(statusEl, 'Enter a token first (step 1)', 'error');
    return;
  }

  const username = await backend.fetchUser(token);
  if (!username) {
    showStatus(statusEl, 'Invalid token', 'error');
    return;
  }

  const repoName = `${username}.github.io`;
  showStatus(statusEl, `Creating ${username}/${repoName}…`, 'success');

  const result = await backend.createRepo(token, repoName, 'My Coulomb feed');
  if (result.success) {
    document.getElementById('github-repo').value = result.full_name;
    showStatus(statusEl, `Created ${result.full_name}!`, 'success');
  } else {
    if (result.error && result.error.includes('already exists')) {
      document.getElementById('github-repo').value = `${username}/${repoName}`;
      showStatus(statusEl, `${username}/${repoName} already exists — using it`, 'success');
    } else {
      showStatus(statusEl, `Failed to create repo: ${result.error}`, 'error');
    }
  }
}

async function handleGitHubConnect() {
  const token = document.getElementById('github-token').value.trim();
  const repo = document.getElementById('github-repo').value.trim();
  const branch = document.getElementById('github-branch').value.trim() || 'main';
  const pathPrefix = document.getElementById('github-path-prefix').value.trim();

  const statusEl = document.getElementById('github-auth-status');

  const result = await backend.connect({ token, repo, branch, pathPrefix });
  if (result.success) {
    backend.saveToken(token);

    // Check permissions and show warnings
    const perms = await backend.checkPermissions();
    const permEl = document.getElementById('github-permissions-status');
    if (perms) {
      const warnings = [];
      if (!perms.contents) warnings.push('Contents');
      if (!perms.pages) warnings.push('Pages');
      if (warnings.length > 0) {
        permEl.innerHTML = `⚠️ Token may lack <strong>${warnings.join(', ')}</strong> permission(s)`;
        permEl.style.color = 'var(--accent, #e94560)';
      } else {
        permEl.textContent = '✓ Token permissions OK';
        permEl.style.color = 'var(--text-muted)';
      }
    }

    showStatus(statusEl, 'Connected!', 'success');
    await refreshSync();
  } else {
    showStatus(statusEl, `Connection failed: ${result.error}`, 'error');
  }
}

async function handleGitHubDisconnect() {
  await backend.disconnect();
  await refreshSync();
}

async function handlePublish() {
  const btn = document.getElementById('btn-publish');
  const statusEl = document.getElementById('sync-status');

  btn.disabled = true;
  btn.textContent = 'Publishing…';
  // Remove stale location prompt from prior publish
  document.getElementById('add-location-prompt')?.remove();

  try {
    if (!navigator.onLine) {
      showStatus(statusEl, 'You appear to be offline. Connect to the internet to publish.', 'error');
      return;
    }

    // Pull remote changes before rendering to merge in posts from other devices
    const sources = getPullSources();
    if (sources.length > 0) {
      showStatus(statusEl, 'Syncing remote changes…', 'success');
      const pullResult = await pullAllSources();
      if (pullResult.count > 0) {
        await saveToIDB(getPyodide(), getWorkspacePath());
      }
    }

    // Render static site before publishing so pages are up to date
    const initialized = await isInitialized();
    if (initialized) {
      showStatus(statusEl, 'Rendering site…', 'success');
      const includePwa = document.getElementById('publish-include-pwa').checked;
      await renderSite({ includePwa });
      await saveToIDB(pyodide, getWorkspacePath());
    }

    // Collect all files from the public directory (includes rendered HTML,
    // static assets, posts, identity — everything needed for the site)
    showStatus(statusEl, 'Collecting files…', 'success');
    const allPaths = await getAllPublicFiles();
    if (allPaths.length === 0) {
      showStatus(statusEl, 'Nothing to publish', 'success');
      return;
    }

    // Read file contents from Pyodide FS
    const files = [];
    for (const relPath of allPaths) {
      const content = readWorkspaceFile(relPath);
      if (content) {
        files.push({ path: relPath, content });
      }
    }

    const result = await backend.publish(files, `coulomb: publish`);

    if (result.success) {
      // Clear changelog after successful publish
      const pyodide = (await import('./pyodide-loader.js')).getPyodide();
      await clearChangelog(pyodide, getWorkspacePath());
      await saveToIDB(pyodide, getWorkspacePath());
      const skipped = result.skipped ? ` (${result.skipped} unchanged)` : '';
      showStatus(statusEl,
        `Published ${result.filesPublished} file(s)${skipped}! ${result.url ? `View at ${result.url}` : ''}`,
        'success'
      );

      // Offer to add Pages URL as a federation location if not already present
      if (result.url) {
        try {
          const info = await getIdentityInfo();
          if (info && !info.locations.some(loc => loc.startsWith(result.url))) {
            const pagesUrl = result.url + 'public';
            statusEl.insertAdjacentHTML('afterend',
              `<div id="add-location-prompt" class="status-msg" style="margin-top:0.5rem">
                <span>Add <strong>${pagesUrl}</strong> as a published location?</span>
                <button id="btn-add-pages-location" class="secondary-btn" style="margin-left:0.5rem">Add</button>
              </div>`
            );
            document.getElementById('btn-add-pages-location').addEventListener('click', async (e) => {
              e.target.disabled = true;
              await addLocation(pagesUrl);
              addPullSource(pagesUrl, 'GitHub Pages');
              document.getElementById('add-location-prompt').textContent = '✓ Location added!';
              await saveToIDB((await import('./pyodide-loader.js')).getPyodide(), getWorkspacePath());
            });
          }
        } catch { /* non-critical */ }
      }
    } else {
      showStatus(statusEl, `Publish failed: ${result.error}`, 'error');
    }

    await refreshSync();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Publish Changes';
  }
}

async function refreshSync() {
  // GitHub connection status
  const notConnected = document.getElementById('github-not-connected');
  const connected = document.getElementById('github-connected');

  if (backend.connected) {
    notConnected.classList.add('hidden');
    connected.classList.remove('hidden');
    document.getElementById('github-repo-display').textContent =
      `Connected to ${backend.repoDisplay}`;

    // Check if Pages URL is in identity locations
    const hintEl = document.getElementById('pages-location-hint');
    try {
      const info = await getIdentityInfo();
      const pagesBase = backend.pagesUrl;
      if (info && info.locations && !info.locations.some(loc => loc.startsWith(pagesBase))) {
        const pagesUrl = pagesBase + 'public';
        hintEl.innerHTML =
          `<p class="hint-banner">⚠️ <strong>${escapeHtml(pagesUrl)}</strong> is not in your published locations.
           <button id="btn-add-pages-loc" class="link-btn">Add it</button></p>`;
        hintEl.classList.remove('hidden');
        document.getElementById('btn-add-pages-loc').addEventListener('click', async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Adding…';
          await addLocation(pagesUrl);
          addPullSource(pagesUrl, 'GitHub Pages');
          await saveToIDB(getPyodide(), getWorkspacePath());
          hintEl.innerHTML = '<p class="hint-banner">✓ Location added!</p>';
          setTimeout(() => hintEl.classList.add('hidden'), 3000);
        });
      } else {
        hintEl.classList.add('hidden');
      }
    } catch { hintEl.classList.add('hidden'); }
  } else {
    notConnected.classList.remove('hidden');
    connected.classList.add('hidden');
  }

  // Pending changes
  try {
    const pending = await getPendingFiles();
    const pendingEl = document.getElementById('pending-changes');
    const publishBtn = document.getElementById('btn-publish');

    if (pending.length > 0) {
      pendingEl.textContent = `${pending.length} file(s) changed since last publish`;
    } else {
      pendingEl.textContent = 'No pending data changes';
    }
    publishBtn.disabled = !backend.connected;
  } catch (e) {
    console.error('Failed to check pending files:', e);
  }

  // Pull sources
  renderSources();
}

function renderSources() {
  const sources = getPullSources();
  const listEl = document.getElementById('source-list');
  const pullAllBtn = document.getElementById('btn-pull-all');

  pullAllBtn.disabled = sources.length === 0;

  if (sources.length === 0) {
    listEl.innerHTML = '<p class="help-text">No sources added yet.</p>';
    return;
  }

  listEl.innerHTML = sources.map(src => {
    const lastPulled = src.last_pulled
      ? new Date(src.last_pulled).toLocaleString()
      : 'never';
    return `<div class="source-item" data-url="${escapeAttr(src.url)}">
      <div class="source-info">
        <span class="source-label">${escapeHtml(src.label)}</span>
        <span class="source-meta">Last pulled: ${lastPulled}</span>
      </div>
      <div class="source-btns">
        <button class="secondary-btn source-pull-btn" title="Pull">↓</button>
        <button class="secondary-btn source-rm-btn" title="Remove">✕</button>
      </div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.source-pull-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.closest('.source-item').dataset.url;
      await handlePullOne(url);
    });
  });

  listEl.querySelectorAll('.source-rm-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = btn.closest('.source-item').dataset.url;
      removePullSource(url);
      renderSources();
    });
  });
}

function handleAddSource() {
  const input = document.getElementById('source-url');
  const url = input.value.trim();
  if (!url) return;
  addPullSource(url);
  input.value = '';
  renderSources();
}

async function handlePullOne(url) {
  const statusEl = document.getElementById('pull-status');
  statusEl.textContent = `Pulling from ${url}…`;
  statusEl.classList.remove('hidden');
  try {
    const count = await pullFromSource(url);
    statusEl.textContent = count > 0 ? `Pulled ${count} new item(s)` : 'Already up to date';
    await saveToIDB(pyodide, getWorkspacePath());
    renderSources();
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
}

async function handlePullAll() {
  const statusEl = document.getElementById('pull-status');
  const btn = document.getElementById('btn-pull-all');

  if (!navigator.onLine) {
    showStatus(statusEl, 'You appear to be offline.', 'error');
    return;
  }

  statusEl.textContent = 'Pulling all sources…';
  statusEl.classList.remove('hidden');
  btn.disabled = true;
  try {
    const result = await pullAllSources();
    if (result.failed > 0) {
      statusEl.textContent = `Pulled ${result.count} new item(s), ${result.failed} source(s) failed`;
      statusEl.className = 'status-msg error';
    } else {
      statusEl.textContent = result.count > 0 ? `Pulled ${result.count} new item(s) total` : 'All sources up to date';
    }
    await saveToIDB(pyodide, getWorkspacePath());
    renderSources();
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Sidebar ──

function closeSidebar() {
  document.getElementById('sidebar-toggle').checked = false;
}

async function refreshSidebar() {
  const container = document.getElementById('sidebar-accounts');
  const accounts = await listAccounts();
  const active = getActiveAccount();
  const profiles = getAccountProfiles();

  let liveInfo = null;
  try {
    const info = await getIdentityInfo();
    if (info) {
      liveInfo = { author_id: info.id, display_name: info.display_name, avatar_url: info.avatar_url };
      updateAccountProfile(active, liveInfo);
    }
  } catch {}

  container.innerHTML = accounts.map(name => {
    const isActive = name === active;
    const profile = isActive && liveInfo ? liveInfo : (profiles[name] || {});
    const authorId = profile.author_id || '';
    const displayName = profile.display_name || '';
    const avatarUrl = profile.avatar_url || '';

    let avatarHtml;
    if (avatarUrl) {
      avatarHtml = `<img src="${escapeHtml(avatarUrl)}" alt="">`;
    } else if (authorId) {
      avatarHtml = generateIdenticonSVG(authorId, 40);
    } else {
      avatarHtml = `<svg viewBox="0 0 40 40" width="40" height="40"><circle cx="20" cy="20" r="20" fill="var(--surface-2)"/><text x="20" y="24" text-anchor="middle" fill="var(--text-muted)" font-size="14">${escapeHtml(name[0].toUpperCase())}</text></svg>`;
    }

    return `<div class="sidebar-account ${isActive ? 'active' : ''}" data-account="${escapeAttr(name)}">
      <div class="sidebar-account-avatar">${avatarHtml}</div>
      <div class="sidebar-account-info">
        <span class="sidebar-account-profile">${escapeHtml(name)}</span>
        ${displayName ? `<span class="sidebar-account-display">${escapeHtml(displayName)}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.sidebar-account').forEach(el => {
    el.addEventListener('click', (e) => {
      const name = el.dataset.account;
      if (name !== active) handleSwitchAccount(name);
    });
  });
}

async function refreshCurrentView() {
  switch (currentView) {
    case 'feed': return refreshFeed();
    case 'identity': return refreshIdentity();
    case 'sync': return refreshSync();
  }
}

// ── Accounts ──

async function handleCreateAccount() {
  const nameEl = document.getElementById('sidebar-new-account');
  const name = nameEl.value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) return;

  try {
    await createAccount(name);
    await switchAccount(name);
    await restoreFromIDB(getPyodide(), getWorkspacePath());
    loadAndApplyTheme();
    nameEl.value = '';
    closeSidebar();
    await refreshSidebar();
    // New account needs identity init — go to Identity tab
    showView('identity');
    await refreshIdentity();
  } catch (e) {
    alert(`Error creating account: ${e.message}`);
  }
}

async function handleSwitchAccount(name) {
  try {
    await saveToIDB(pyodide, getWorkspacePath());
    await switchAccount(name);
    await restoreFromIDB(getPyodide(), getWorkspacePath());
    // Reset GitHub backend to the new account's config
    backend.setAccountScope(name);
    backend.tryRestore();
    loadAndApplyTheme();
    closeSidebar();
    await refreshSidebar();
    // If the account has no identity, go to Identity tab to initialize
    const initialized = await isInitialized();
    if (!initialized) {
      showView('identity');
      await refreshIdentity();
    } else {
      // Re-set view to update hash with new account
      showView(currentView);
      await refreshCurrentView();
    }
  } catch (e) {
    alert(`Error switching account: ${e.message}`);
  }
}

async function handleDeleteAccount(name) {
  if (!confirm(`Permanently delete account "${name}"? All posts, identity, and keys will be lost.`)) return;
  try {
    const accounts = await listAccounts();
    const isActive = name === getActiveAccount();
    const others = accounts.filter(a => a !== name);

    if (isActive && others.length > 0) {
      await switchAccount(others[0]);
      await restoreFromIDB(getPyodide(), getWorkspacePath());
      backend.setAccountScope(others[0]);
      backend.tryRestore();
      loadAndApplyTheme();
      await deleteAccount(name);
    } else if (isActive) {
      // Last account: force-delete, then create a fresh default
      await backend.disconnect();
      await deleteAccount(name, { force: true });
      await createAccount('default');
      await switchAccount('default');
      backend.setAccountScope('default');
      backend.tryRestore();
    } else {
      await deleteAccount(name);
    }

    await deleteFromIDB(`/accounts/${name}`);
    localStorage.removeItem(`coulomb_theme_${name}`);
    localStorage.removeItem(`coulomb_pull_sources_${name}`);
    GitHubPagesBackend.removeAccountConfig(name);
    closeSidebar();
    await refreshSidebar();
    showView('identity');
    await refreshCurrentView();
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

// ── Data Portability ──

async function handleExport() {
  const statusEl = document.getElementById('data-status');
  const includeKeys = document.getElementById('export-include-keys').checked;

  try {
    showStatus(statusEl, 'Exporting…', 'success');
    const blob = await exportWorkspace(getPyodide(), getWorkspacePath(), { includePrivate: includeKeys });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `coulomb-${getActiveAccount()}-${date}.tar.gz`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus(statusEl, 'Export downloaded!', 'success');
  } catch (e) {
    showStatus(statusEl, `Export failed: ${e.message}`, 'error');
  }
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('data-status');
  if (!confirm('Import will replace the current workspace. Continue?')) {
    e.target.value = '';
    return;
  }

  try {
    showStatus(statusEl, 'Importing…', 'success');
    await importWorkspace(getPyodide(), file, getWorkspacePath());
    await saveToIDB(getPyodide(), getWorkspacePath(), { force: true });
    showStatus(statusEl, 'Import complete!', 'success');
    await refreshCurrentView();
  } catch (err) {
    showStatus(statusEl, `Import failed: ${err.message}`, 'error');
  }
  e.target.value = '';
}

// ── Device Provisioning ──

// ── Device Provisioning (ephemeral key exchange) ──

// Emoji fingerprint for visual MITM verification.
// Both devices derive the same pattern from the ephemeral public key.
const EMOJI_ALPHABET = [
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼',
  '🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔',
  '🐧','🐦','🦅','🦆','🦉','🐴','🦄','🐝',
  '🐛','🦋','🐌','🐞','🐙','🦀','🐠','🐳',
];

async function emojiFingerprint(base64Pub) {
  const raw = atob(base64Pub.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash.slice(0, 4), b => EMOJI_ALPHABET[b % EMOJI_ALPHABET.length]).join('');
}

// Step 1: New device generates ephemeral X25519 keypair, shows public key as QR/URL
async function handleRequestKey() {
  const statusEl = document.getElementById('request-status');
  const resultEl = document.getElementById('request-key-result');

  try {
    showStatus(statusEl, 'Generating request…', 'success');

    const result = await runPy(`
import json, base64
import nacl.public

# Generate ephemeral Curve25519 keypair
ephemeral = nacl.public.PrivateKey.generate()
ephemeral_pub = bytes(ephemeral.public_key)
ephemeral_priv = bytes(ephemeral)

_bridge_out = json.dumps({
    'pub': base64.urlsafe_b64encode(ephemeral_pub).decode(),
    'priv': base64.urlsafe_b64encode(ephemeral_priv).decode(),
})
`);

    const data = JSON.parse(result);

    // Store ephemeral keys in sessionStorage for step 3
    sessionStorage.setItem('coulomb-provision-ephemeral', data.priv);
    sessionStorage.setItem('coulomb-provision-ephemeral-pub', data.pub);

    const requestUrl = `${location.origin}${location.pathname}#provision/request/${data.pub}`;

    resultEl.classList.remove('hidden');
    try {
      const qrSvg = await generateQRCodeSVG(requestUrl);
      document.getElementById('request-qr').innerHTML =
        `<p class="help-text">Show this to the source device:</p>${qrSvg}`;
    } catch (e) {
      document.getElementById('request-qr').innerHTML =
        `<p class="help-text">QR generation failed. Use the link below.</p>`;
    }

    document.getElementById('request-url-display').innerHTML =
      `<p class="help-text">Or copy this link:</p>
       <code class="provision-url" id="request-url">${escapeHtml(requestUrl)}</code>`;
    document.getElementById('request-url').addEventListener('click', () => {
      navigator.clipboard.writeText(requestUrl);
      showToast('Link copied!');
    });

    const emoji = await emojiFingerprint(data.pub);
    showStatus(statusEl, `Verification pattern: <span class="emoji-fingerprint">${emoji}</span> — confirm this matches on the source device`, 'success', { timeout: 0 });
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

// Step 2: Source device encrypts signing key to the new device's ephemeral public key
async function handleProvisionSend() {
  const statusEl = document.getElementById('provision-status');
  const resultEl = document.getElementById('provision-result');
  const input = document.getElementById('provision-request-input').value.trim();

  // Extract ephemeral public key from URL or raw base64
  let ephemeralPub;
  const match = input.match(/#provision\/request\/([A-Za-z0-9_-]+={0,2})/);
  if (match) {
    ephemeralPub = match[1];
  } else if (input.match(/^[A-Za-z0-9_-]+={0,2}$/)) {
    ephemeralPub = input;
  } else {
    showStatus(statusEl, 'Paste the request link from the new device', 'error');
    return;
  }

  try {
    showStatus(statusEl, 'Generating and encrypting key…', 'success');

    const result = await runPy(`
import os, glob, json, base64
import nacl.signing, nacl.public, cbor2

os.chdir('${getWorkspacePath()}')

# Decode the new device's ephemeral public key
target_pub_bytes = base64.urlsafe_b64decode(${JSON.stringify(ephemeralPub)})
target_pub = nacl.public.PublicKey(target_pub_bytes)

# Generate new signing key
key = nacl.signing.SigningKey.generate()
key_id = bytes(key.verify_key).hex()
seed = bytes(key)  # 32 bytes

# Save signing key locally
private_key = dict(id=key_id, signing=seed, api='pynacl')
key_path = '${getWorkspacePath()}/private/signing.' + key_id + '.cbor'
with open(key_path, 'wb') as f:
    cbor2.dump(private_key, f, canonical=True)

# Add to identity
identity_files = glob.glob('${getWorkspacePath()}/public/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Initialize first.")

with open(identity_files[0], 'rb') as f:
    identity_cbor = f.read()
    f.seek(0)
    entry = cbor2.load(f)
author_id = entry['content']['author']['id']

all_sig_files = glob.glob('${getWorkspacePath()}/private/private_identity.*.cbor') + glob.glob('${getWorkspacePath()}/private/signing.*.cbor')

from coulomb.identity import add_key
with open('${getWorkspacePath()}/changelog', 'a') as _cl:
    add_key(
        identity='${getWorkspacePath()}/public/identity/' + author_id,
        change_log=_cl,
        signatures=all_sig_files,
        key_files=[key_path]
    )

# Re-read identity after adding the new key
with open(identity_files[0], 'rb') as f:
    identity_cbor = f.read()

# Bundle seed + public identity into a CBOR payload
bundle = cbor2.dumps({'seed': seed, 'identity': identity_cbor, 'author_id': author_id})

# Encrypt using NaCl SealedBox (anonymous encryption to target's public key)
sealed_box = nacl.public.SealedBox(target_pub)
encrypted = sealed_box.encrypt(bundle)

payload = base64.urlsafe_b64encode(encrypted).decode()

_bridge_out = json.dumps({
    'key_id': key_id,
    'payload': payload,
})
`);

    const data = JSON.parse(result);
    await saveToIDB(getPyodide(), getWorkspacePath());

    const responseUrl = `${location.origin}${location.pathname}#provision/respond/${data.payload}`;

    resultEl.classList.remove('hidden');

    try {
      const qrSvg = await generateQRCodeSVG(responseUrl);
      document.getElementById('provision-qr').innerHTML =
        `<p class="help-text">Show this to the new device:</p>${qrSvg}`;
    } catch (e) {
      document.getElementById('provision-qr').innerHTML =
        `<p class="help-text">QR generation failed. Use the link below.</p>`;
    }

    document.getElementById('provision-url-display').innerHTML =
      `<p class="help-text">Or copy this link:</p>
       <code class="provision-url" id="provision-url">${escapeHtml(responseUrl)}</code>`;
    document.getElementById('provision-url').addEventListener('click', () => {
      navigator.clipboard.writeText(responseUrl);
      showToast('Link copied!');
    });

    const emoji = await emojiFingerprint(ephemeralPub);
    showStatus(statusEl, `Verification pattern: <span class="emoji-fingerprint">${emoji}</span> — confirm this matches on the new device. Key ${data.key_id.slice(0, 12)}… created.`, 'success', { timeout: 0 });
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

// Step 3: New device decrypts the signing key using its ephemeral private key
async function handleProvisionReceive(payloadOverride) {
  const statusEl = document.getElementById('receive-status');
  let payload;

  if (typeof payloadOverride === 'string') {
    payload = payloadOverride;
  } else {
    const input = document.getElementById('provision-response-input').value.trim();
    const match = input.match(/#provision\/respond\/([A-Za-z0-9_-]+={0,2})/);
    if (match) {
      payload = match[1];
    } else if (input.match(/^[A-Za-z0-9_-]+={0,2}$/)) {
      payload = input;
    } else {
      showStatus(statusEl, 'Paste the response link from the source device', 'error');
      return;
    }
  }

  const ephemeralPriv = sessionStorage.getItem('coulomb-provision-ephemeral');
  if (!ephemeralPriv) {
    showStatus(statusEl, 'No pending key request. Run Step 1 first on this device.', 'error');
    return;
  }

  try {
    showStatus(statusEl, 'Decrypting key…', 'success');

    const result = await runPy(`
import base64, json, os
import nacl.public, nacl.signing, cbor2

# Recover ephemeral private key
ephemeral_priv_bytes = base64.urlsafe_b64decode(${JSON.stringify(ephemeralPriv)})
ephemeral_priv = nacl.public.PrivateKey(ephemeral_priv_bytes)

# Decrypt sealed box
encrypted = base64.urlsafe_b64decode(${JSON.stringify(payload)})
unseal = nacl.public.SealedBox(ephemeral_priv)
decrypted = unseal.decrypt(encrypted)

# Try new bundle format (CBOR with seed + identity), fall back to raw seed
try:
    bundle = cbor2.loads(decrypted)
    seed = bundle['seed']
    identity_cbor = bundle.get('identity')
    author_id = bundle.get('author_id')
except Exception:
    seed = decrypted
    identity_cbor = None
    author_id = None

# Reconstruct signing key
key = nacl.signing.SigningKey(seed)
key_id = bytes(key.verify_key).hex()

# Save to private directory
os.makedirs('${getWorkspacePath()}/private', exist_ok=True)
private_key = dict(id=key_id, signing=bytes(key), api='pynacl')
key_path = '${getWorkspacePath()}/private/signing.' + key_id + '.cbor'
with open(key_path, 'wb') as f:
    cbor2.dump(private_key, f, canonical=True)

# Write identity CBOR if included in bundle
_has_identity = False
_locations = []
if identity_cbor and author_id:
    identity_dir = '${getWorkspacePath()}/public/identity/' + author_id
    os.makedirs(identity_dir, exist_ok=True)

    # Write latest.cbor
    latest_path = os.path.join(identity_dir, 'latest.cbor')
    with open(latest_path, 'wb') as f:
        f.write(identity_cbor)

    # Extract locations for pull source setup
    _id_entry = cbor2.loads(identity_cbor)
    _author = _id_entry.get('content', {}).get('author', {})
    _locations = _author.get('locations', [])

    # Write versioned identity file (same as write_updated_identity)
    from coulomb.TimeArchive import IdentityArchive
    archive = IdentityArchive(prefix=identity_dir)
    versioned_path = os.path.join(identity_dir, archive.get_path().path)
    os.makedirs(os.path.dirname(versioned_path), exist_ok=True)
    with open(versioned_path, 'wb') as f:
        f.write(identity_cbor)

    # Log both to changelog
    public_dir = '${getWorkspacePath()}/public'
    changelog_path = '${getWorkspacePath()}/changelog'
    with open(changelog_path, 'a') as cl:
        cl.write(os.path.relpath(latest_path, public_dir) + '\\n')
        cl.write(os.path.relpath(versioned_path, public_dir) + '\\n')

    _has_identity = True

_bridge_out = json.dumps({'key_id': key_id, 'has_identity': _has_identity, 'locations': _locations})
`);

    const data = JSON.parse(result);
    await saveToIDB(getPyodide(), getWorkspacePath());
    const ephemeralPub = sessionStorage.getItem('coulomb-provision-ephemeral-pub');
    sessionStorage.removeItem('coulomb-provision-ephemeral');
    sessionStorage.removeItem('coulomb-provision-ephemeral-pub');
    location.hash = '';

    const emoji = ephemeralPub ? await emojiFingerprint(ephemeralPub) : '';
    const emojiHtml = emoji ? ` Verification: <span class="emoji-fingerprint">${emoji}</span>` : '';

    if (data.has_identity) {
      showStatus(statusEl, `Key and identity imported! Syncing posts…${emojiHtml}`, 'success', { timeout: 0 });
      await refreshSidebar();

      // Auto-add identity locations as pull sources and sync post history
      const locations = data.locations || [];
      let pullCount = 0;
      for (const loc of locations) {
        try {
          addPullSource(loc, 'Auto-added from identity');
          const n = await pullFromSource(loc);
          pullCount += n;
        } catch (e) {
          console.warn('Pull from', loc, 'failed:', e);
        }
      }
      if (pullCount > 0) {
        await saveToIDB(getPyodide(), getWorkspacePath());
      }

      showStatus(statusEl, `Identity imported! ${pullCount} post(s) synced.${emojiHtml}`, 'success', { timeout: 0 });
      showView('identity');
      await refreshIdentity();
    } else {
      showStatus(statusEl, `Key imported. Set up a pull source to sync your identity.${emojiHtml}`, 'success', { timeout: 0 });
    }
  } catch (e) {
    showStatus(statusEl, `Import failed: ${e.message}`, 'error');
  }
}

// Check for provisioning URL fragments at boot
async function checkKeyImport() {
  const hash = location.hash;

  if (hash.startsWith('#provision/respond/')) {
    const payload = hash.slice('#provision/respond/'.length);
    // Clear sensitive payload from browser history immediately
    history.replaceState(null, '', location.pathname);
    // Auto-fill step 3 input and attempt import if ephemeral key exists
    const input = document.getElementById('provision-response-input');
    if (input) input.value = payload;
    if (sessionStorage.getItem('coulomb-provision-ephemeral')) {
      await handleProvisionReceive(payload);
    }
    return true;
  }

  if (hash.startsWith('#provision/request/')) {
    // Clear sensitive payload from browser history immediately
    const reqPayload = hash.slice('#provision/request/'.length);
    history.replaceState(null, '', location.pathname);
    // Auto-fill step 2 input on source device
    const input = document.getElementById('provision-request-input');
    if (input) input.value = reqPayload;
    return true;
  }

  // Legacy: handle old #import/ URLs gracefully
  if (hash.startsWith('#import/')) {
    alert('This import link uses an older format that is no longer supported. Please use the new provisioning flow.');
    location.hash = '';
    return false;
  }

  return false;
}

// Need runPy accessible for provisioning
async function runPy(code) {
  const pyodide = getPyodide();
  pyodide.runPython('_bridge_out = None');
  await pyodide.runPythonAsync(code);
  const out = pyodide.globals.get('_bridge_out');
  pyodide.runPython('_bridge_out = None');
  return out === undefined || out === null ? null : out;
}

// ── Helpers ──
function showStatus(el, msg, type, { timeout = 5000, html = false } = {}) {
  if (type === 'error' && !html) {
    el.textContent = msg;
  } else {
    el.innerHTML = msg;
  }
  el.className = `status-msg ${type}`;
  el.classList.remove('hidden');
  if (timeout > 0) setTimeout(() => el.classList.add('hidden'), timeout);
}

// Transient floating toast — doesn't clobber persistent status messages
function showToast(msg, { type = 'success', timeout = 2500 } = {}) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  // Trigger entrance animation on next frame
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    toast.addEventListener('transitionend', () => toast.remove());
    // Fallback removal if transitionend doesn't fire
    setTimeout(() => toast.remove(), 500);
  }, timeout);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
