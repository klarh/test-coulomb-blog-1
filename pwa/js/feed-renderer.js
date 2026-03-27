/**
 * Feed renderer — builds a threaded post feed as native DOM.
 *
 * Used in the PWA for interactive authoring (reply buttons, threading).
 * The published static site uses render.py/Jinja2 for a no-JS version.
 */

import { generateIdenticonSVG } from './identicon.js';

/**
 * Build a thread tree from a flat post array.
 * Posts with reply_to are nested under their parent.
 * @param {Array} posts - flat array with .path, .reply_to, etc.
 * @returns {Array} top-level posts with .children arrays
 */
export function buildThreadTree(posts) {
  const byPath = new Map();
  for (const p of posts) {
    p.children = [];
    byPath.set(p.path, p);
    // Also index by relative path for reply_to matching
    if (p.rel_path) byPath.set(p.rel_path, p);
  }

  const roots = [];
  for (const p of posts) {
    let parent = null;
    if (p.reply_to) {
      // reply_to has { author, post_id } — try to find the parent post
      // Parent path pattern: posts/{author}/{post_id}/*.cbor
      for (const [key, candidate] of byPath) {
        if (candidate === p) continue;
        if (p.reply_to.author && candidate.author_id === p.reply_to.author &&
            p.reply_to.post_id && key.includes(p.reply_to.post_id)) {
          parent = candidate;
          break;
        }
      }
    }
    if (parent) {
      parent.children.push(p);
    } else {
      roots.push(p);
    }
  }

  // Sort: newest first at each level
  const sortByTime = arr => arr.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  sortByTime(roots);
  for (const p of posts) sortByTime(p.children);

  return roots;
}

/**
 * Render a threaded feed into a container element.
 * @param {HTMLElement} container
 * @param {Array} posts - flat post array from listRecentPosts
 * @param {object} opts
 * @param {Function} opts.onReply - callback(post) when reply button clicked
 * @param {Function} opts.onVerify - callback(post, btn, statusEl) when verify button clicked
 * @param {Function} opts.onOpenFile - callback(post, filename) → Uint8Array|null
 */
export function renderFeed(container, posts, { onReply, onVerify, onOpenFile } = {}) {
  container.innerHTML = '';
  if (posts.length === 0) {
    container.innerHTML = '<p class="feed-empty">No posts yet. Write your first post above!</p>';
    return;
  }

  const tree = buildThreadTree(posts);
  const frag = document.createDocumentFragment();
  for (const post of tree) {
    frag.appendChild(renderPostNode(post, 0, onReply, onVerify, onOpenFile));
  }
  container.appendChild(frag);
}

function renderPostNode(post, depth, onReply, onVerify, onOpenFile) {
  const el = document.createElement('div');
  el.className = 'feed-post';
  if (depth > 0) el.classList.add('feed-reply');
  el.style.marginLeft = `${Math.min(depth, 4) * 1.25}rem`;

  const displayName = post.display_name || `@${post.author_id.slice(0, 12)}…`;
  const identicon = generateIdenticonSVG(post.author_id, 40);
  const badge = generateIdenticonSVG(post.author_id, 16);
  const timeStr = formatTime(post.time);

  const replyToHtml = post.reply_to && depth === 0
    ? `<div class="feed-reply-badge">↩ Reply to ${post.reply_to.author?.slice(0, 8) || '?'}…</div>`
    : '';

  const sigLabel = post.sig_count > 0
    ? `🔏 Verify (${post.sig_count})`
    : '⚠️ No sigs';

  el.innerHTML = `
    <div class="feed-post-header">
      <div class="feed-avatar">${identicon}</div>
      <div class="feed-meta">
        <span class="feed-author">${badge} ${escapeHtml(displayName)}</span>
        <span class="feed-time">${timeStr}</span>
      </div>
    </div>
    ${replyToHtml}
    <div class="feed-text">${escapeHtml(post.text)}</div>
    <div class="feed-attachments"></div>
    <div class="feed-actions">
      <button class="feed-reply-btn" title="Reply">↩ Reply</button>
      <button class="feed-verify-btn" title="Verify signatures">${sigLabel}</button>
      <span class="feed-verify-status"></span>
    </div>
  `;

  // Render file attachments
  if (post.file_count > 0 && post.files_dir) {
    const attachEl = el.querySelector('.feed-attachments');
    for (const fname of post.files) {
      const isImage = /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(fname);
      const fileEl = document.createElement('div');
      fileEl.className = 'feed-file';

      if (isImage && onOpenFile) {
        // Show image inline with lazy loading
        fileEl.innerHTML = `<div class="feed-image-placeholder" data-filename="${escapeHtml(fname)}">📷 ${escapeHtml(fname)} <span class="load-hint">(tap to load)</span></div>`;
        fileEl.querySelector('.feed-image-placeholder').addEventListener('click', async function() {
          this.textContent = 'Loading…';
          try {
            const data = await onOpenFile(post, fname);
            if (data) {
              const blob = new Blob([data], { type: guessMime(fname) });
              const url = URL.createObjectURL(blob);
              this.innerHTML = `<img src="${url}" alt="${escapeHtml(fname)}" class="feed-image" loading="lazy">`;
            } else {
              this.textContent = `❌ ${fname} not found`;
            }
          } catch (e) {
            this.textContent = `❌ ${e.message}`;
          }
        });
      } else if (onOpenFile) {
        // Non-image: download link
        fileEl.innerHTML = `<a class="feed-file-link" href="#">📎 ${escapeHtml(fname)}</a>`;
        fileEl.querySelector('a').addEventListener('click', async (e) => {
          e.preventDefault();
          try {
            const data = await onOpenFile(post, fname);
            if (data) {
              const blob = new Blob([data], { type: guessMime(fname) });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = fname;
              a.click();
              URL.revokeObjectURL(url);
            }
          } catch (err) {
            console.error('Download failed:', err);
          }
        });
      } else {
        fileEl.innerHTML = `<span class="feed-file-name">📎 ${escapeHtml(fname)}</span>`;
      }
      attachEl.appendChild(fileEl);
    }
  }

  if (onReply) {
    el.querySelector('.feed-reply-btn').addEventListener('click', () => onReply(post));
  }

  if (onVerify) {
    const verifyBtn = el.querySelector('.feed-verify-btn');
    const statusSpan = el.querySelector('.feed-verify-status');
    verifyBtn.addEventListener('click', () => onVerify(post, verifyBtn, statusSpan));
  }

  // Render children (replies)
  for (const child of post.children || []) {
    el.appendChild(renderPostNode(child, depth + 1, onReply, onVerify, onOpenFile));
  }

  return el;
}

const MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  pdf: 'application/pdf', txt: 'text/plain', json: 'application/json',
  mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav',
};

function guessMime(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString();
  } catch {
    return isoStr;
  }
}

function escapeHtml(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}
