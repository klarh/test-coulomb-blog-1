import { loadPyodideRuntime, getPyodide } from './pyodide-loader.js';
import { saveToIDB, restoreFromIDB, deleteFromIDB, getChangelog, clearChangelog, exportWorkspace, importWorkspace } from './fs-sync.js';
import {
  ensureWorkspace, isInitialized, initialize, getIdentityInfo,
  setDisplayName, setAvatarUrl, setIdentityConfig,
  addLocation, removeLocation,
  createPost, listRecentPosts, getPendingFiles, getAllPublicFiles,
  readWorkspaceFile, renderSite,
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
      if (oldRestored > 0) {
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
        console.log(`Migrated ${oldRestored} files from legacy /workspace`);
      }
      localStorage.setItem('coulomb_migrated_workspace', '1');
    }

    progress.value = 95;
    const restored = await restoreFromIDB(pyodide, getWorkspacePath());
    if (restored > 0) {
      console.log(`Restored ${restored} files from IndexedDB`);
    }

    // Migrate any old global GitHub config to the active account
    GitHubPagesBackend.migrateGlobalConfig(getActiveAccount());
    backend.setAccountScope(getActiveAccount());
    backend.tryRestore();

    // Apply saved theme for active account
    loadAndApplyTheme();

    document.getElementById('loading-screen').classList.add('hidden');
    showView('feed');
    bindEvents();

    // Check for key import via URL fragment
    await checkKeyImport();

    await refreshSidebar();
    await refreshCurrentView();
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    console.error('Boot failed:', e);
  }
}

// ── Navigation ──
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.remove('hidden');
  document.getElementById(`nav-${name}`).classList.add('active');
  currentView = name;
}

// ── Event Binding ──
function bindEvents() {
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

  // Accounts
  document.getElementById('btn-sidebar-create-account').addEventListener('click', handleCreateAccount);

  // Data portability
  document.getElementById('btn-export').addEventListener('click', handleExport);
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', handleImport);

  // Device provisioning
  document.getElementById('btn-provision-device').addEventListener('click', handleProvisionDevice);

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
  try {
    const posts = await listRecentPosts(50);
    const container = document.getElementById('feed-container');
    renderFeed(container, posts, {
      onReply: (post) => setReplyTarget(post),
    });
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
  statusEl.textContent = 'Pulling all sources…';
  statusEl.classList.remove('hidden');
  btn.disabled = true;
  try {
    const count = await pullAllSources();
    statusEl.textContent = count > 0 ? `Pulled ${count} new item(s) total` : 'All sources up to date';
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

async function handleProvisionDevice() {
  const statusEl = document.getElementById('provision-status');
  const resultEl = document.getElementById('provision-result');

  try {
    showStatus(statusEl, 'Generating key…', 'success');

    // Generate a PIN (6 digits)
    const pin = String(Math.floor(100000 + Math.random() * 900000));

    // Generate a new signing key and add it to the identity, then encrypt with PIN
    const result = await runPy(`
import os, glob, json, hashlib, secrets
os.chdir('${getWorkspacePath()}')

import nacl.signing, nacl.secret, nacl.utils, cbor2

# Generate new signing key
key = nacl.signing.SigningKey.generate()
key_id = bytes(key.verify_key).hex()
seed = bytes(key)  # 32 bytes

# Save as signing key file
private_key = dict(id=key_id, signing=seed, api='pynacl')
key_path = '${getWorkspacePath()}/private/signing.' + key_id + '.cbor'
with open(key_path, 'wb') as f:
    cbor2.dump(private_key, f, canonical=True)

# Add to identity
identity_files = glob.glob('${getWorkspacePath()}/public/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Initialize first.")

with open(identity_files[0], 'rb') as f:
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

# Encrypt seed with PIN using NaCl secretbox
pin_str = ${JSON.stringify(pin)}
salt = secrets.token_bytes(16)
# Derive key from PIN + salt using SHA-256 (simple but sufficient for a 6-digit PIN protecting an ephemeral transfer)
dk = hashlib.pbkdf2_hmac('sha256', pin_str.encode(), salt, 100000)
box = nacl.secret.SecretBox(dk)
encrypted = box.encrypt(seed)  # nonce + ciphertext

import base64
payload = base64.urlsafe_b64encode(salt + encrypted).decode()

_bridge_out = json.dumps({
    'key_id': key_id,
    'payload': payload,
})
`);

    const data = JSON.parse(result);
    await saveToIDB(getPyodide(), getWorkspacePath());

    // Show result
    resultEl.classList.remove('hidden');
    document.getElementById('provision-pin').textContent = pin;

    // Generate QR code SVG
    const importUrl = `${location.origin}${location.pathname}#import/${data.payload}`;
    try {
      const qrSvg = await generateQRCodeSVG(importUrl);
      document.getElementById('provision-qr').innerHTML =
        `<p class="help-text">Scan this QR code on the new device:</p>${qrSvg}`;
    } catch (e) {
      document.getElementById('provision-qr').innerHTML =
        `<p class="help-text">QR generation failed (${escapeHtml(e.message)}). Use the URL below instead.</p>`;
    }

    document.getElementById('provision-url-display').innerHTML =
      `<p class="help-text">Or copy this URL:</p>
       <code class="provision-url" id="provision-url">${escapeHtml(importUrl)}</code>`;
    document.getElementById('provision-url').addEventListener('click', () => {
      navigator.clipboard.writeText(importUrl);
      showStatus(statusEl, 'URL copied!', 'success');
    });

    showStatus(statusEl, `Key ${data.key_id.slice(0, 12)}… created and added to identity`, 'success');
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

// Check for key import URL fragment at boot
async function checkKeyImport() {
  const hash = location.hash;
  if (!hash.startsWith('#import/')) return false;

  const payload = hash.slice('#import/'.length);
  const pin = prompt('Enter the PIN from the source device:');
  if (!pin) return false;

  try {
    await runPy(`
import base64, hashlib, json, os
import nacl.secret, nacl.signing, cbor2

payload = base64.urlsafe_b64decode(${JSON.stringify(payload)})
salt = payload[:16]
encrypted = payload[16:]

pin_str = ${JSON.stringify(pin)}
dk = hashlib.pbkdf2_hmac('sha256', pin_str.encode(), salt, 100000)
box = nacl.secret.SecretBox(dk)
seed = box.decrypt(encrypted)

# Reconstruct key
key = nacl.signing.SigningKey(seed)
key_id = bytes(key.verify_key).hex()

# Save to private directory
os.makedirs('${getWorkspacePath()}/private', exist_ok=True)
private_key = dict(id=key_id, signing=bytes(key), api='pynacl')
key_path = '${getWorkspacePath()}/private/signing.' + key_id + '.cbor'
with open(key_path, 'wb') as f:
    cbor2.dump(private_key, f, canonical=True)

_bridge_out = json.dumps({'key_id': key_id})
`);

    await saveToIDB(getPyodide(), getWorkspacePath());
    location.hash = '';
    alert('Key imported successfully! You can now sign posts with this device.');
    return true;
  } catch (e) {
    alert(`Key import failed: ${e.message}`);
    return false;
  }
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
function showStatus(el, msg, type) {
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
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
