/**
 * Abstract storage backend interface.
 * All storage adapters implement this contract.
 */
export class StorageBackend {
  constructor(config = {}) {
    this.config = config;
  }

  /** Human-readable name for this backend */
  get name() { return 'abstract'; }

  /** Whether this backend is currently connected/authenticated */
  get connected() { return false; }

  /**
   * Upload a file to the backend.
   * @param {string} path - Relative path (e.g. "posts/2025/0629/1200/post.xxx.cbor")
   * @param {Uint8Array} content - File content
   * @returns {Promise<void>}
   */
  async upload(path, content) { throw new Error('Not implemented'); }

  /**
   * Download a file from the backend.
   * @param {string} path - Relative path
   * @returns {Promise<Uint8Array|null>} File content, or null if not found
   */
  async download(path) { throw new Error('Not implemented'); }

  /**
   * List files under a path prefix.
   * @param {string} prefix - Directory prefix
   * @returns {Promise<string[]>} Array of relative file paths
   */
  async list(prefix) { throw new Error('Not implemented'); }

  /**
   * Delete a file from the backend.
   * @param {string} path - Relative path
   * @returns {Promise<void>}
   */
  async delete(path) { throw new Error('Not implemented'); }

  /**
   * Publish a batch of changed files.
   * Implementations may optimize this (e.g. single git commit for multiple files).
   * @param {Array<{path: string, content: Uint8Array}>} files - Files to publish
   * @param {string} message - Commit/deploy message
   * @returns {Promise<{success: boolean, url?: string, error?: string}>}
   */
  async publish(files, message) { throw new Error('Not implemented'); }

  /**
   * Connect/authenticate to the backend.
   * @param {object} credentials - Backend-specific credentials
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async connect(credentials) { throw new Error('Not implemented'); }

  /** Disconnect from the backend */
  async disconnect() { throw new Error('Not implemented'); }

  /**
   * Serialize connection config for persistence (no secrets).
   * @returns {object}
   */
  toJSON() { return { type: this.name, config: this.config }; }
}
