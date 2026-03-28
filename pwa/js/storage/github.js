import { StorageBackend } from './adapter.js';

const GITHUB_API = 'https://api.github.com';

/**
 * GitHub Pages storage adapter.
 * Uses the Git Data API for efficient batch commits.
 */
export class GitHubPagesBackend extends StorageBackend {
  #token = null;
  #owner = '';
  #repo = '';
  #branch = 'main';
  #pathPrefix = '';
  #connected = false;
  #accountScope = 'default';

  get name() { return 'github'; }
  get connected() { return this.#connected; }

  // Set the account scope for per-account config storage.
  // Must be called before tryRestore() when switching accounts.
  setAccountScope(name) {
    this.#accountScope = name;
  }

  get #configKey() { return `coulomb-github-config_${this.#accountScope}`; }
  get #tokenKey() { return `coulomb-github-token_${this.#accountScope}`; }

  async connect(credentials) {
    const { token, repo, branch, pathPrefix } = credentials;
    if (!token || !repo) {
      return { success: false, error: 'Token and repository are required' };
    }

    const [owner, repoName] = repo.split('/');
    if (!owner || !repoName) {
      return { success: false, error: 'Repository must be in owner/repo format' };
    }

    this.#token = token;
    this.#owner = owner;
    this.#repo = repoName;
    this.#branch = branch || 'main';
    this.#pathPrefix = pathPrefix ? pathPrefix.replace(/\/$/, '') + '/' : '';

    // Verify access
    try {
      const resp = await this.#api(`/repos/${this.#owner}/${this.#repo}`);
      if (!resp.ok) {
        const err = await resp.json();
        return { success: false, error: err.message || 'Failed to access repository' };
      }
      this.#connected = true;

      // Persist config (not the token) to localStorage
      localStorage.setItem(this.#configKey, JSON.stringify({
        owner: this.#owner,
        repo: this.#repo,
        branch: this.#branch,
        pathPrefix: this.#pathPrefix,
      }));

      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async disconnect() {
    this.#token = null;
    this.#connected = false;
    localStorage.removeItem(this.#configKey);
    // Token is stored separately so user must re-enter it
    sessionStorage.removeItem(this.#tokenKey);
  }

  async upload(path, content) {
    const fullPath = this.#pathPrefix + path;
    const base64 = uint8ToBase64(content);

    // Check if file exists to get its SHA (needed for updates)
    let sha;
    try {
      const existing = await this.#api(
        `/repos/${this.#owner}/${this.#repo}/contents/${fullPath}?ref=${this.#branch}`
      );
      if (existing.ok) {
        const data = await existing.json();
        sha = data.sha;
      }
    } catch { /* file doesn't exist yet */ }

    const body = {
      message: `coulomb: update ${path}`,
      content: base64,
      branch: this.#branch,
    };
    if (sha) body.sha = sha;

    const resp = await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/${fullPath}`,
      { method: 'PUT', body: JSON.stringify(body) }
    );

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(`Upload failed: ${err.message}`);
    }
  }

  async download(path) {
    const fullPath = this.#pathPrefix + path;
    const resp = await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/${fullPath}?ref=${this.#branch}`
    );
    if (!resp.ok) return null;

    const data = await resp.json();
    return base64ToUint8(data.content);
  }

  async list(prefix) {
    const fullPath = this.#pathPrefix + prefix;
    const results = [];
    await this.#listRecursive(fullPath, results);
    return results.map(p => {
      if (this.#pathPrefix && p.startsWith(this.#pathPrefix)) {
        return p.slice(this.#pathPrefix.length);
      }
      return p;
    });
  }

  async delete(path) {
    const fullPath = this.#pathPrefix + path;
    const existing = await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/${fullPath}?ref=${this.#branch}`
    );
    if (!existing.ok) return;

    const data = await existing.json();
    await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/${fullPath}`,
      {
        method: 'DELETE',
        body: JSON.stringify({
          message: `coulomb: delete ${path}`,
          sha: data.sha,
          branch: this.#branch,
        }),
      }
    );
  }

  /**
   * Publish multiple files in a single git commit using the Git Data API.
   * Only uploads files whose content has changed (compared via git blob SHA).
   */
  async publish(files, message = 'coulomb: publish') {
    if (!this.#connected) {
      return { success: false, error: 'Not connected to GitHub' };
    }

    if (files.length === 0) {
      return { success: true, url: this.pagesUrl };
    }

    try {
      // 1. Get the current commit SHA for the branch (may not exist yet)
      let latestCommitSha = null;
      let baseTreeSha = null;

      const refResp = await this.#api(
        `/repos/${this.#owner}/${this.#repo}/git/ref/heads/${this.#branch}`
      );
      if (refResp.ok) {
        const refData = await refResp.json();
        latestCommitSha = refData.object.sha;

        // 2. Get the tree SHA from the latest commit
        const commitResp = await this.#api(
          `/repos/${this.#owner}/${this.#repo}/git/commits/${latestCommitSha}`
        );
        if (!commitResp.ok) throw new Error('Failed to get commit');
        const commitData = await commitResp.json();
        baseTreeSha = commitData.tree.sha;
      } else {
        await this.#bootstrap();
        const retry = await this.#api(
          `/repos/${this.#owner}/${this.#repo}/git/ref/heads/${this.#branch}`
        );
        if (!retry.ok) throw new Error('Failed to initialize repository');
        const retryData = await retry.json();
        latestCommitSha = retryData.object.sha;

        const commitResp = await this.#api(
          `/repos/${this.#owner}/${this.#repo}/git/commits/${latestCommitSha}`
        );
        if (!commitResp.ok) throw new Error('Failed to get commit');
        const commitData = await commitResp.json();
        baseTreeSha = commitData.tree.sha;
      }

      // 3. Fetch existing tree to find unchanged files
      const existingShas = await this.#getTreeShas(baseTreeSha);

      // 4. Filter to only changed files by comparing git blob SHAs
      const shaResults = await Promise.all(
        files.map(async (file) => ({
          file,
          sha: await gitBlobSha(file.content),
          fullPath: this.#pathPrefix + file.path,
        }))
      );
      const changedFiles = shaResults
        .filter(({ sha, fullPath }) => existingShas.get(fullPath) !== sha)
        .map(({ file }) => file);

      if (changedFiles.length === 0) {
        return {
          success: true,
          url: this.pagesUrl,
          filesPublished: 0,
          skipped: files.length,
        };
      }

      // 5. Create blobs in parallel batches
      const BATCH_SIZE = 10;
      const treeEntries = [];
      for (let i = 0; i < changedFiles.length; i += BATCH_SIZE) {
        const batch = changedFiles.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (file) => {
          const blobResp = await this.#api(
            `/repos/${this.#owner}/${this.#repo}/git/blobs`,
            {
              method: 'POST',
              body: JSON.stringify({
                content: uint8ToBase64(file.content),
                encoding: 'base64',
              }),
            }
          );
          if (!blobResp.ok) {
            const err = await blobResp.json().catch(() => ({}));
            throw new Error(`Failed to create blob for ${file.path}: ${err.message || blobResp.status}`);
          }
          const blobData = await blobResp.json();
          return {
            path: this.#pathPrefix + file.path,
            mode: '100644',
            type: 'blob',
            sha: blobData.sha,
          };
        }));
        treeEntries.push(...batchResults);
      }

      // 6. Create a new tree
      const treeResp = await this.#api(
        `/repos/${this.#owner}/${this.#repo}/git/trees`,
        {
          method: 'POST',
          body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
        }
      );
      if (!treeResp.ok) {
        const err = await treeResp.json().catch(() => ({}));
        throw new Error(`Failed to create tree: ${err.message || treeResp.status}`);
      }
      const treeData = await treeResp.json();

      // 7. Create a new commit
      const newCommitResp = await this.#api(
        `/repos/${this.#owner}/${this.#repo}/git/commits`,
        {
          method: 'POST',
          body: JSON.stringify({
            message: `${message} (${changedFiles.length}/${files.length} changed)`,
            tree: treeData.sha,
            parents: [latestCommitSha],
          }),
        }
      );
      if (!newCommitResp.ok) throw new Error('Failed to create commit');
      const newCommitData = await newCommitResp.json();

      // 8. Update the branch ref
      const updateRefResp = await this.#api(
        `/repos/${this.#owner}/${this.#repo}/git/refs/heads/${this.#branch}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ sha: newCommitData.sha, force: true }),
        }
      );
      if (!updateRefResp.ok) {
        const err = await updateRefResp.json().catch(() => ({}));
        throw new Error(`Failed to update ref: ${err.message || updateRefResp.status}`);
      }

      // Ensure GitHub Pages is enabled for this branch
      await this.#ensurePages();

      return {
        success: true,
        url: this.pagesUrl,
        commitSha: newCommitData.sha,
        filesPublished: changedFiles.length,
        skipped: files.length - changedFiles.length,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Restore connection from saved config + session token.
  // Resets to disconnected state if no config exists for the current account scope.
  tryRestore() {
    const configStr = localStorage.getItem(this.#configKey);
    const token = sessionStorage.getItem(this.#tokenKey);
    if (configStr && token) {
      const config = JSON.parse(configStr);
      this.#owner = config.owner;
      this.#repo = config.repo;
      this.#branch = config.branch;
      this.#pathPrefix = config.pathPrefix;
      this.#token = token;
      this.#connected = true;
      return true;
    }
    // No saved config for this account — reset to disconnected
    this.#token = null;
    this.#owner = '';
    this.#repo = '';
    this.#branch = 'main';
    this.#pathPrefix = '';
    this.#connected = false;
    return false;
  }

  // Save token to session storage (not localStorage for security)
  saveToken(token) {
    sessionStorage.setItem(this.#tokenKey, token);
  }

  get repoDisplay() {
    return `${this.#owner}/${this.#repo} (${this.#branch})`;
  }

  get pagesUrl() {
    return `https://${this.#owner}.github.io/${this.#repo}/`;
  }

  // Fetch the authenticated user's login name.
  async fetchUser(token) {
    const resp = await fetch(`${GITHUB_API}/user`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.login;
  }

  // Create a new repository for the authenticated user.
  async createRepo(token, name, description = '') {
    const resp = await fetch(`${GITHUB_API}/user/repos`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, description, auto_init: false }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return { success: false, error: err.message || resp.status };
    }
    const data = await resp.json();
    return { success: true, full_name: data.full_name };
  }

  // Check token permissions by probing key API endpoints.
  async checkPermissions() {
    if (!this.#connected) return null;
    const checks = {};

    // Contents (needed for bootstrap + file operations)
    const contentsResp = await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/.nojekyll?ref=${this.#branch}`
    );
    checks.contents = contentsResp.ok || contentsResp.status === 404;

    // Pages
    try {
      const pagesResp = await this.#api(`/repos/${this.#owner}/${this.#repo}/pages`);
      checks.pages = pagesResp.ok || pagesResp.status === 404;
    } catch {
      checks.pages = false;
    }

    return checks;
  }

  // Bootstrap an empty repo by creating .nojekyll via the Contents API,
  // which works on uninitialized repos (the Git Data API does not).
  async #bootstrap() {
    const path = this.#pathPrefix + '.nojekyll';
    const resp = await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/${path}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          message: 'coulomb: initialize repository',
          content: '',
          branch: this.#branch,
        }),
      }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Failed to initialize repository: ${err.message || resp.status}`);
    }
  }

  // Enable GitHub Pages if not already enabled. Silently ignored if the
  // token lacks pages permission or Pages is already configured.
  async #ensurePages() {
    try {
      const check = await this.#api(`/repos/${this.#owner}/${this.#repo}/pages`);
      if (check.ok) return; // already enabled

      await this.#api(`/repos/${this.#owner}/${this.#repo}/pages`, {
        method: 'POST',
        body: JSON.stringify({
          source: { branch: this.#branch, path: '/' },
        }),
      });
    } catch { /* best-effort */ }
  }

  // Fetch the full recursive tree and return a Map of path → blob SHA.
  async #getTreeShas(treeSha) {
    const shas = new Map();
    const resp = await this.#api(
      `/repos/${this.#owner}/${this.#repo}/git/trees/${treeSha}?recursive=1`
    );
    if (!resp.ok) return shas;
    const data = await resp.json();
    if (data.tree) {
      for (const entry of data.tree) {
        if (entry.type === 'blob') {
          shas.set(entry.path, entry.sha);
        }
      }
    }
    return shas;
  }

  async #api(path, options = {}) {
    return fetch(`${GITHUB_API}${path}`, {
      ...options,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${this.#token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  }

  async #listRecursive(path, results) {
    const resp = await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/${path}?ref=${this.#branch}`
    );
    if (!resp.ok) return;

    const items = await resp.json();
    if (!Array.isArray(items)) return;

    for (const item of items) {
      if (item.type === 'file') {
        results.push(item.path);
      } else if (item.type === 'dir') {
        await this.#listRecursive(item.path, results);
      }
    }
  }

  toJSON() {
    return {
      type: 'github',
      config: {
        owner: this.#owner,
        repo: this.#repo,
        branch: this.#branch,
        pathPrefix: this.#pathPrefix,
      },
    };
  }

  // Remove persisted config for a specific account (used on account delete).
  static removeAccountConfig(accountName) {
    localStorage.removeItem(`coulomb-github-config_${accountName}`);
    sessionStorage.removeItem(`coulomb-github-token_${accountName}`);
  }

  // Migrate old global config key to a scoped per-account key.
  static migrateGlobalConfig(accountName) {
    const old = localStorage.getItem('coulomb-github-config');
    if (old && !localStorage.getItem(`coulomb-github-config_${accountName}`)) {
      localStorage.setItem(`coulomb-github-config_${accountName}`, old);
    }
    localStorage.removeItem('coulomb-github-config');

    const oldToken = sessionStorage.getItem('coulomb-github-token');
    if (oldToken && !sessionStorage.getItem(`coulomb-github-token_${accountName}`)) {
      sessionStorage.setItem(`coulomb-github-token_${accountName}`, oldToken);
    }
    sessionStorage.removeItem('coulomb-github-token');
  }
}

function uint8ToBase64(uint8) {
  let binary = '';
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64) {
  const clean = base64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Compute the git blob SHA-1 for a Uint8Array.
 * Git hashes: SHA-1("blob {size}\0{content}")
 */
async function gitBlobSha(content) {
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const combined = new Uint8Array(header.length + content.length);
  combined.set(header);
  combined.set(content, header.length);
  const hash = await crypto.subtle.digest('SHA-1', combined);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
