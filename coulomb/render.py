import argparse
import collections
import contextlib
import datetime
import enum
import hashlib
import math
import os
import shutil
import sqlite3

import cbor2
import jinja2
from markupsafe import Markup

from .cmd import register_subcommand
from .index_walker import IndexWalker, load_index, parse_entry
from .markdown_render import render_markdown


def _cubehelix_rgb(lam, s=0, r=1, h=1.2, gamma=1):
    """Evaluate cubehelix at a single lambda value.

    Returns (R, G, B) each in [0, 1]. As lambda increases, the color
    spirals through hues along the RGB cube diagonal — so different
    lambda values give both different lightness AND different hue.

    See Green 2011: http://adsabs.harvard.edu/abs/2011BASI...39..289G
    """
    lam = max(0.0, min(1.0, lam))
    lam_g = lam**gamma
    phi = 2 * math.pi * (s / 3 + r * lam)
    a = h * lam_g * (1 - lam_g) * 0.5
    cos_phi = math.cos(phi)
    sin_phi = math.sin(phi)
    return (
        max(0, min(1, lam_g + a * (-0.14861 * cos_phi + 1.78277 * sin_phi))),
        max(0, min(1, lam_g + a * (-0.29227 * cos_phi - 0.90649 * sin_phi))),
        max(0, min(1, lam_g + a * (1.97294 * cos_phi))),
    )


def _rgb_hex(r, g, b):
    return f'#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}'


def generate_identicon_svg(id_string, size=80):
    """Generate a symmetry-based identicon SVG from an ID string.

    Uses Fourier harmonics at multiples of N to create naturally N-fold
    symmetric curves, with multiple concentric rings for a mandala effect.
    Colors use cubehelix so each ring gets a genuinely different hue
    (not just lighter/darker) as lightness varies along the helix.
    """
    h = id_string
    while len(h) < 64:
        h += h

    # Cubehelix start hue from ID (0–3 covers full rotation)
    ch_start = int(h[:2], 16) / 256 * 3
    # Hue rotation rate from ID (0–1)
    ch_rot = int(h[2], 16) / 15
    n = [3, 4, 5, 6, 8][int(h[3], 16) % 5]
    cx, cy = size / 2, size / 2
    max_r = size * 0.45
    num_rings = 2 + int(h[4], 16) % 2

    # Ring lambdas spread across the cubehelix — each gets a different
    # lightness AND hue due to the helical path through RGB space
    ring_lambdas = [
        0.35 + 0.25 * ring / max(num_rings - 1, 1) for ring in range(num_rings)
    ]

    # Draw outermost ring first so inner rings layer on top,
    # revealing each ring's distinct cubehelix color
    paths = ''
    for ring in reversed(range(num_rings)):
        base_r = max_r * (ring + 1) / num_rings * 0.8
        ring_points = []

        for s in range(64):
            theta = s / 64 * 2 * math.pi
            r = base_r
            for k in range(1, 4):
                idx = 5 + ring * 8 + k * 2
                amp = int(h[idx % len(h)], 16) / 15.0 * base_r * 0.4
                phase = int(h[(idx + 1) % len(h)], 16) / 15.0 * 2 * math.pi
                r += amp * math.cos(n * k * theta + phase)
            r = max(0, min(max_r, r))
            x = cx + r * math.cos(theta)
            y = cy + r * math.sin(theta)
            ring_points.append(f'{x:.1f},{y:.1f}')

        rgb = _cubehelix_rgb(ring_lambdas[ring], s=ch_start, r=ch_rot, h=1.4)
        fill = _rgb_hex(*rgb)
        d = 'M ' + ' L '.join(ring_points) + ' Z'
        paths += f'<path d="{d}" fill="{fill}"/>'

    bg_rgb = _cubehelix_rgb(0.08, s=ch_start, r=ch_rot, h=0.6)
    bg = _rgb_hex(*bg_rgb)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{size}" height="{size}" viewBox="0 0 {size} {size}">'
        f'<circle cx="{cx}" cy="{cy}" r="{size/2}" fill="{bg}"/>'
        f'{paths}</svg>'
    )


def identicon_data_uri(id_string, size=80):
    """Return an identicon as a data: URI for use in img src."""
    import base64

    svg = generate_identicon_svg(id_string, size)
    b64 = base64.b64encode(svg.encode()).decode()
    return f'data:image/svg+xml;base64,{b64}'


@register_subcommand('render', help='Render HTML views of posts')
def add_parser_args(parser):
    parser.add_argument('root', help='Root directory for posts')
    parser.add_argument(
        '-c', '--cache-file', help='Cache file (sqlite3 db) for tracking smart rebuilds'
    )
    parser.add_argument(
        '-x', '--hash-name', default='sha512', help='Hash function to use'
    )
    parser.add_argument('-t', '--template-dir', help='Template directory')
    parser.add_argument('--change-log', help='Changelog file to write to')
    parser.add_argument(
        '-p',
        '--post-dirs',
        nargs='*',
        default=['posts'],
        help='Subdirectories containing post content',
    )
    parser.add_argument(
        '--html-dir', default='pages', help='Subdirectory for rendered HTML'
    )
    parser.add_argument(
        '--pwa-dir',
        help='Directory containing PWA files to bundle into the output',
    )


TEMPLATES = dict(
    post="""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ text_config.get('user_post.page_title', 'Posts')|e }}</title>
    <link rel="stylesheet" type="text/css" href="{{root_path}}/static/global/style.css">
    {% if text_config.get('theme.accent') or text_config.get('theme.mode') %}
    <style>
      :root {
        {% if text_config.get('theme.accent') %}--accent: {{ text_config['theme.accent'] }};{% endif %}
        {% if text_config.get('theme.accent') %}--accent-hover: {{ text_config['theme.accent'] }};{% endif %}
      }
      {% if text_config.get('theme.mode') == 'dark' %}
      :root {
        --bg: #15202b;
        --surface: #192734;
        --surface-hover: #1e2d3d;
        --text: #d9d9d9;
        --text-muted: #8899a6;
        --border: #38444d;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #15202b;
          --surface: #192734;
          --surface-hover: #1e2d3d;
          --text: #d9d9d9;
          --text-muted: #8899a6;
          --border: #38444d;
        }
      }
      {% elif text_config.get('theme.mode') == 'light' %}
      :root {
        --bg: #f5f8fa;
        --surface: #ffffff;
        --surface-hover: #f5f8fa;
        --text: #14171a;
        --text-muted: #657786;
        --border: #e1e8ed;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #f5f8fa;
          --surface: #ffffff;
          --surface-hover: #f5f8fa;
          --text: #14171a;
          --text-muted: #657786;
          --border: #e1e8ed;
        }
      }
      {% endif %}
    </style>
    {% endif %}
</head>
<body>
    <div class="feed">
    {% if tag_name is defined %}
    <div style="padding: 1rem; display: flex; align-items: center; gap: 0.75rem;">
        <a href="{{ root_path }}/{{ html_dir }}/tags/index.html" class="page-btn" style="font-size: 0.85em;">← All tags</a>
        <h2 style="margin: 0; font-size: 1.2em;">#{{ tag_name }}</h2>
    </div>
    {% endif %}
    {% for post in posts %}
        <article class="post-card">
            <div class="post-header">
                {% set avatar_url = post.author.get('config', {}).get('avatar_url', '') %}
                {% set display_name = post.author.get('config', {}).get('display_name', '') or post.author.get('config', {}).get('user.display_name', '') %}
                {% if avatar_url %}
                <img class="avatar" src="{{ avatar_url }}" alt="">
                {% else %}
                <img class="avatar" src="{{ post.author.id | identicon }}" alt="">
                {% endif %}
                <div class="post-meta">
                    <span class="display-name">{{ (display_name or 'User ' ~ post.author.id[:8] ~ '…')|e }}</span>
                    <img class="identicon-badge" src="{{ post.author.id | identicon(16) }}" alt="" title="{{ post.author.id[:16] }}…">
                </div>
                <a class="post-time" href="{{ post.direct_link }}">{{ post.time[:16] }}</a>
            </div>
            <div class="post-body md-content">{{ post.text|markdown }}</div>
            {% if post.get('tags') %}
            <div class="post-tags">
                {% for tag in post.tags %}<a href="{{ root_path }}/{{ html_dir }}/tags/{{ tag.type }}/{{ tag.value }}/latest.html" class="post-tag">#{{ tag.value|display_tag }}</a> {% endfor %}
            </div>
            {% endif %}
            {% for reply in post.get('replies', []) %}
            <div class="reply-card">
                <div class="post-header">
                    {% set r_avatar = reply.author.get('config', {}).get('avatar_url', '') %}
                    {% set r_name = reply.author.get('config', {}).get('display_name', '') or reply.author.get('config', {}).get('user.display_name', '') %}
                    {% if r_avatar %}
                    <img class="avatar avatar-sm" src="{{ r_avatar }}" alt="">
                    {% else %}
                    <img class="avatar avatar-sm" src="{{ reply.author.id | identicon(32) }}" alt="">
                    {% endif %}
                    <div class="post-meta">
                        <span class="display-name">{{ (r_name or 'User ' ~ reply.author.id[:8] ~ '…')|e }}</span>
                        <img class="identicon-badge" src="{{ reply.author.id | identicon(16) }}" alt="" title="{{ reply.author.id[:16] }}…">
                    </div>
                    {% if reply.direct_link %}
                    <a class="post-time" href="{{ reply.direct_link }}">{{ reply.time[:16] }}</a>
                    {% else %}
                    <span class="post-time">{{ reply.time[:16] }}</span>
                    {% endif %}
                </div>
                <div class="post-body md-content">{{ reply.text|markdown }}</div>
                {% if reply.get('tags') %}
                <div class="post-tags">
                    {% for tag in reply.tags %}<a href="{{ root_path }}/{{ html_dir }}/tags/{{ tag.type }}/{{ tag.value }}/latest.html" class="post-tag">#{{ tag.value|display_tag }}</a> {% endfor %}
                </div>
                {% endif %}
            </div>
            {% endfor %}
        </article>
    {% endfor %}
    </div>
    <nav class="pagination">
    {% if previous_page %}
        <a href="{{ previous_page }}" class="page-btn">← Older</a>
    {% endif %}
        <a href="{{ root_path }}/{{ html_dir }}/tags/index.html" class="page-btn">#Tags</a>
    {% if next_page %}
        <a href="{{ next_page }}" class="page-btn">Newer →</a>
    {% endif %}
    </nav>
</body>
    """,
    tag_index="""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Tags</title>
    <link rel="stylesheet" type="text/css" href="{{root_path}}/static/global/style.css">
    {% if text_config.get('theme.accent') or text_config.get('theme.mode') %}
    <style>
      :root {
        {% if text_config.get('theme.accent') %}--accent: {{ text_config['theme.accent'] }};{% endif %}
        {% if text_config.get('theme.accent') %}--accent-hover: {{ text_config['theme.accent'] }};{% endif %}
      }
    </style>
    {% endif %}
</head>
<body>
    <div class="feed">
        <h1 style="padding: 1rem; font-size: 1.4em;">Tags</h1>
        <div style="padding: 0 1rem 1rem; display: flex; flex-wrap: wrap; gap: 0.5rem;">
        {% for tag in tags %}
            <a href="{{ tag.url }}" class="page-btn" style="font-size: 0.85em;">
                #{{ tag.display }} ({{ tag.count }})
            </a>
        {% endfor %}
        </div>
    </div>
</body>
    """,
)


class EntryType(enum.Enum):
    directory = 0
    post = 1
    reply = 2
    tag_ref = 3


class BuildCache:
    class Queries:
        create_page_dependencies = ' '.join(
            [
                'CREATE TABLE IF NOT EXISTS page_dependencies (',
                'target_path TEXT,',
                'source_file TEXT UNIQUE ON CONFLICT REPLACE,',
                'timestamp TEXT)',
            ]
        )
        create_last_build = ' '.join(
            [
                'CREATE TABLE IF NOT EXISTS last_build (',
                'path TEXT UNIQUE ON CONFLICT REPLACE,',
                'hash BLOB, hash_name TEXT)',
            ]
        )
        create_pending_changes = ' '.join(
            [
                'CREATE TABLE IF NOT EXISTS pending_changes (',
                'path TEXT UNIQUE ON CONFLICT REPLACE,',
                'hash BLOB, hash_name TEXT, entry_type INTEGER,',
                'timestamp TEXT)',
            ]
        )
        create_reply = ' '.join(
            [
                'CREATE TABLE IF NOT EXISTS replies (',
                'target_user TEXT, target_id TEXT,',
                'source_file TEXT UNIQUE ON CONFLICT IGNORE)',
            ]
        )
        create_post_paths = ' '.join(
            [
                'CREATE TABLE IF NOT EXISTS post_paths (',
                'author TEXT, post_id TEXT,',
                'source_file TEXT,',
                'UNIQUE(author, post_id) ON CONFLICT REPLACE)',
            ]
        )
        create_dependency_index = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS dependency_index ON',
                'page_dependencies (target_path, source_file)',
            ]
        )
        create_dependency_source = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS dependency_source ON',
                'page_dependencies (source_file)',
            ]
        )
        create_dependency_pathtime = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS dependency_path_time ON',
                'page_dependencies (target_path, timestamp)',
            ]
        )
        create_pending_entrytime = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS pending_type_time ON',
                'pending_changes (entry_type, timestamp)',
            ]
        )
        create_replies_target = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS replies_target ON',
                'replies (target_user, target_id)',
            ]
        )
        create_post_paths_lookup = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS post_paths_lookup ON',
                'post_paths (author, post_id)',
            ]
        )
        create_pending_path = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS pending_path ON',
                'pending_changes (path)',
            ]
        )
        create_last_build_lookup = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS last_build_lookup ON',
                'last_build (path, hash_name)',
            ]
        )
        create_dependency_target_nonnull = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS dependency_target_nonnull ON',
                'page_dependencies (target_path) WHERE target_path IS NOT NULL',
            ]
        )

        # ── Tag page tables ──
        create_tag_page_deps = ' '.join(
            [
                'CREATE TABLE IF NOT EXISTS tag_page_deps (',
                'tag_type TEXT,',
                'tag_value TEXT,',
                'target_path TEXT,',
                'source_file TEXT,',
                'post_path TEXT,',
                'timestamp TEXT,',
                'UNIQUE(tag_value, source_file) ON CONFLICT REPLACE)',
            ]
        )
        create_tag_page_deps_index = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS tag_page_deps_tag ON',
                'tag_page_deps (tag_value, target_path)',
            ]
        )

        init = ';'.join(
            [
                create_page_dependencies,
                create_last_build,
                create_pending_changes,
                create_reply,
                create_post_paths,
                create_dependency_index,
                create_dependency_source,
                create_dependency_pathtime,
                create_pending_entrytime,
                create_replies_target,
                create_post_paths_lookup,
                create_pending_path,
                create_last_build_lookup,
                create_dependency_target_nonnull,
                create_tag_page_deps,
                create_tag_page_deps_index,
            ]
        )

        select_stale_hash = (
            'SELECT hash FROM last_build WHERE path = ? and hash_name = ?'
        )

        insert_stale_check = 'INSERT INTO pending_changes VALUES (?, ?, ?, ?, ?)'

        insert_reply = 'INSERT INTO replies VALUES (?, ?, ?)'

        insert_post_path = 'INSERT INTO post_paths VALUES (?, ?, ?)'

        insert_repage = ' '.join(
            [
                'INSERT INTO page_dependencies (source_file, timestamp)',
                'SELECT pending_changes.path, pending_changes.timestamp',
                'FROM pending_changes LEFT JOIN page_dependencies ON ',
                'page_dependencies.source_file = pending_changes.path ',
                'WHERE page_dependencies.target_path IS NULL AND '
                f'pending_changes.entry_type = {EntryType.post.value}',
                'ORDER BY pending_changes.timestamp',
            ]
        )

        select_repage = ' '.join(
            [
                'SELECT ROWID, source_file FROM page_dependencies WHERE',
                'target_path IS NULL ORDER BY timestamp LIMIT ?',
            ]
        )

        update_repage = 'UPDATE page_dependencies SET target_path = ? WHERE ROWID = ?'

        insert_replies_repage = ' '.join(
            [
                'WITH RECURSIVE reply_roots(target_path, reply_file, reply_timestamp) AS (',
                '  SELECT parent.target_path, pending.path, pending.timestamp',
                '  FROM pending_changes AS pending',
                '  JOIN replies ON replies.source_file = pending.path',
                '  JOIN post_paths ON post_paths.author = replies.target_user',
                '  AND post_paths.post_id = replies.target_id',
                '  JOIN page_dependencies AS parent ON',
                '  parent.source_file = post_paths.source_file',
                f'  WHERE pending.entry_type = {EntryType.reply.value}',
                '  AND parent.target_path IS NOT NULL',
                '  UNION',
                '  SELECT rr.target_path, pending.path, pending.timestamp',
                '  FROM pending_changes AS pending',
                '  JOIN replies ON replies.source_file = pending.path',
                '  JOIN post_paths ON post_paths.author = replies.target_user',
                '  AND post_paths.post_id = replies.target_id',
                '  JOIN reply_roots rr ON rr.reply_file = post_paths.source_file',
                f'  WHERE pending.entry_type = {EntryType.reply.value}',
                ')',
                'INSERT INTO page_dependencies (target_path, source_file, timestamp)',
                'SELECT target_path, reply_file, reply_timestamp FROM reply_roots',
            ]
        )

        select_prev_page = ' '.join(
            [
                'SELECT target_path FROM page_dependencies WHERE',
                'target_path < ? AND target_path IS NOT NULL',
                'ORDER BY target_path DESC LIMIT 1',
            ]
        )

        select_next_page = ' '.join(
            [
                'SELECT target_path FROM page_dependencies WHERE',
                'target_path > ? AND target_path IS NOT NULL',
                'ORDER BY target_path LIMIT 1',
            ]
        )

        select_pending_dependencies = ' '.join(
            [
                'SELECT DISTINCT target_path FROM page_dependencies',
                'INNER JOIN pending_changes ON',
                'page_dependencies.source_file = pending_changes.path',
                'WHERE target_path IS NOT NULL',
            ]
        )

        select_source_pending = ' '.join(
            [
                'SELECT source_file FROM page_dependencies',
                'WHERE target_path = ? ORDER BY timestamp DESC',
            ]
        )

        select_null_dependency = ' '.join(
            [
                'WITH RECURSIVE latest_tree(source_file) AS (',
                '  SELECT source_file FROM page_dependencies WHERE target_path IS NULL',
                '  UNION',
                '  SELECT r.source_file FROM latest_tree lt',
                '  INNER JOIN post_paths pp ON pp.source_file = lt.source_file',
                '  INNER JOIN replies r ON r.target_user = pp.author',
                '  AND r.target_id = pp.post_id',
                ')',
                'SELECT source_file FROM latest_tree',
            ]
        )

        select_prev_page_nonnull = ' '.join(
            [
                'SELECT target_path FROM page_dependencies',
                'WHERE target_path IS NOT NULL ORDER BY target_path DESC LIMIT 1',
            ]
        )

        insert_build_update = ' '.join(
            [
                'INSERT INTO last_build (path, hash, hash_name) SELECT',
                'path, hash, hash_name FROM pending_changes',
            ]
        )

        delete_after_update = ' '.join(
            [
                'DELETE FROM pending_changes WHERE EXISTS (',
                '  SELECT 1 FROM page_dependencies WHERE',
                '  page_dependencies.source_file = pending_changes.path)',
                'OR EXISTS (',
                '  SELECT 1 FROM tag_page_deps WHERE',
                '  tag_page_deps.source_file = pending_changes.path)',
            ]
        )

        # ── Tag queries ──

        # Insert a new tag ref (called from Python with parsed values)
        insert_tag_ref = ' '.join(
            [
                'INSERT OR IGNORE INTO tag_page_deps',
                '(tag_type, tag_value, target_path, source_file, post_path, timestamp)',
                'VALUES (?, ?, NULL, ?, NULL, ?)',
            ]
        )

        # Select unpaged tag refs grouped by tag
        select_tag_unpaged = ' '.join(
            [
                'SELECT ROWID, tag_type, tag_value, source_file, timestamp',
                'FROM tag_page_deps WHERE target_path IS NULL',
                'ORDER BY tag_value, timestamp',
            ]
        )

        update_tag_repage = (
            'UPDATE tag_page_deps SET target_path = ?, post_path = ?'
            ' WHERE ROWID = ?'
        )

        # Count existing entries on a tag's latest page
        select_tag_latest_count = ' '.join(
            [
                'SELECT COUNT(*) FROM tag_page_deps',
                "WHERE tag_value = ? AND target_path LIKE '%/latest.html'",
            ]
        )

        # Get all pending tag pages (tags with changed content)
        select_pending_tag_pages = ' '.join(
            [
                'SELECT DISTINCT tag_page_deps.tag_type,',
                'tag_page_deps.tag_value,',
                'tag_page_deps.target_path',
                'FROM tag_page_deps',
                'INNER JOIN pending_changes ON',
                'tag_page_deps.source_file = pending_changes.path',
                'WHERE tag_page_deps.target_path IS NOT NULL',
            ]
        )

        # Get source files for a specific tag page
        select_tag_page_sources = ' '.join(
            [
                'SELECT source_file, post_path FROM tag_page_deps',
                'WHERE tag_value = ? AND target_path = ?',
                'ORDER BY timestamp DESC',
            ]
        )

        # Freeze: rename latest → permanent page
        update_tag_freeze_page = ' '.join(
            [
                'UPDATE tag_page_deps SET target_path = ?',
                'WHERE tag_value = ? AND target_path = ?',
            ]
        )

        # Previous tag page (for pagination links)
        select_tag_prev_page = ' '.join(
            [
                'SELECT target_path FROM tag_page_deps',
                'WHERE tag_value = ? AND target_path < ?',
                'AND target_path IS NOT NULL',
                'ORDER BY target_path DESC LIMIT 1',
            ]
        )

        # All distinct tags (for tag index)
        select_all_tags = ' '.join(
            [
                'SELECT tag_type, tag_value, COUNT(*) AS cnt',
                'FROM tag_page_deps GROUP BY tag_type, tag_value',
                'ORDER BY tag_value',
            ]
        )

    def __init__(self, root, filename, hash_name, subdir):
        self.root = root
        self.filename = filename
        self.hash_name = hash_name
        self.subdir = subdir
        self.connection = sqlite3.connect(filename)
        self._walker = None

        self.init()

    def init(self):
        with self.connection as conn:
            conn.executescript(self.Queries.init)
            # Migrate tag_page_deps: add tag_type column if missing
            cols = {
                row[1]
                for row in conn.execute(
                    "PRAGMA table_info(tag_page_deps)"
                )
            }
            if cols and 'tag_type' not in cols:
                conn.execute("DROP TABLE tag_page_deps")
                conn.execute(self.Queries.create_tag_page_deps)

    def stale_check(self, directory):
        with self.connection as conn:
            walker = _BuildWalker(self, conn)
            walker.walk(directory)

    def stale_check_(self, curs, directory):
        """Legacy interface — delegates to IndexWalker."""
        walker = _BuildWalker(self, curs)
        walker.walk(directory)

    def parse_reply(self, curs, relpath):
        bits = relpath.split('/')
        try:
            target_author = bits[-3]
            target_id = bits[-2]
        except IndexError:
            return None

        if not target_author.isalnum():
            return None
        elif not target_id.isalnum():
            return None

        query = self.Queries.insert_reply
        qargs = (target_author, target_id, relpath)
        return curs.execute(query, qargs)

    def repage(self, pagination=10):
        # place all pending changes posts into page_dependencies
        for _ in self.connection.execute(self.Queries.insert_repage):
            pass

        # assign page targets if a page's worth of unpaged posts exist
        select_query = self.Queries.select_repage
        insert_query = self.Queries.update_repage
        rows = pagination * [None]
        while len(rows) >= pagination:
            rows = list(self.connection.execute(select_query, (pagination,)))
            if len(rows) >= pagination:
                target_file = rows[-1][1]
                target_bits = target_file.split('/')
                target_bits[0] = self.subdir
                index = target_bits[-1].split('.')[1]
                target_bits[-1] = 'page.{}.html'.format(index)
                target_file = '/'.join(target_bits)

                for rowid, _ in rows:
                    insert_qargs = (target_file, rowid)
                    self.connection.execute(insert_query, insert_qargs)

        # add replies to the dependency graph of any pages that exist
        for _ in self.connection.execute(self.Queries.insert_replies_repage):
            pass

        self.connection.commit()

    def repage_tags(self, pagination=10):
        """Paginate tag references.  Mirrors ``repage()`` but per-tag."""
        # 1. Insert pending tag_ref entries into tag_page_deps (unpaged)
        pending = list(
            self.connection.execute(
                'SELECT path, timestamp FROM pending_changes'
                f' WHERE entry_type = {EntryType.tag_ref.value}'
            )
        )
        for path, timestamp in pending:
            # path = "tags/hashtag/{value}/ref.{id}.cbor"
            parts = path.split('/')
            if len(parts) < 4 or parts[0] != 'tags':
                continue
            tag_type = parts[1]
            tag_value = parts[2]
            self.connection.execute(
                self.Queries.insert_tag_ref, (tag_type, tag_value, path, timestamp)
            )

        # 2. For each tag, resolve post_path from the ref CBOR
        unpaged = list(
            self.connection.execute(self.Queries.select_tag_unpaged)
        )
        for rowid, tag_type, tag_value, source_file, timestamp in unpaged:
            ref_path = os.path.join(self.root, source_file)
            try:
                with open(ref_path, 'rb') as f:
                    ref = cbor2.load(f)
                post_path = ref.get('post_path', '')
            except (FileNotFoundError, OSError):
                post_path = ''

            # Check how many items are on this tag's latest page
            latest_target = os.path.join(
                self.subdir, 'tags', tag_type, tag_value, 'latest.html'
            )
            (count,) = self.connection.execute(
                self.Queries.select_tag_latest_count, (tag_value,)
            ).fetchone()

            if count >= pagination:
                # Freeze the current latest page
                frozen_name = os.path.join(
                    self.subdir, 'tags', tag_type, tag_value,
                    'page.{}.html'.format(timestamp),
                )
                self.connection.execute(
                    self.Queries.update_tag_freeze_page,
                    (frozen_name, tag_value, latest_target),
                )

            self.connection.execute(
                self.Queries.update_tag_repage,
                (latest_target, post_path, rowid),
            )

        self.connection.commit()

    def get_pending_tag_pages(self):
        """Return tag pages that need re-rendering.

        Returns ``{target_path: {tag_type, tag_value, files: [(ref_file, post_path)],
        previous_page?}}``.
        """
        rows = list(
            self.connection.execute(self.Queries.select_pending_tag_pages)
        )
        groups = {}
        for tag_type, tag_value, target_path in rows:
            if target_path in groups:
                continue
            desc = groups[target_path] = {
                'tag_type': tag_type, 'tag_value': tag_value, 'files': [],
            }
            for source, post_path in self.connection.execute(
                self.Queries.select_tag_page_sources,
                (tag_value, target_path),
            ):
                desc['files'].append((source, post_path))

            # Pagination link
            for (prev,) in self.connection.execute(
                self.Queries.select_tag_prev_page,
                (tag_value, target_path),
            ):
                desc['previous_page'] = prev

        return groups

    def get_all_tags(self):
        """Return list of (tag_type, tag_value, count) for the tag index page."""
        return list(self.connection.execute(self.Queries.select_all_tags))

    def get_pending_pages(self):
        """Return pages that need re-rendering."""
        prev_query = self.Queries.select_prev_page
        next_query = self.Queries.select_next_page

        query = self.Queries.select_pending_dependencies
        paths = list(self.connection.execute(query))
        query = self.Queries.select_source_pending

        description = {}
        groups = {}
        path = None
        for (path,) in paths:
            description = groups[path] = {}
            files = groups[path].setdefault('files', [])
            for (filename,) in self.connection.execute(query, (path,)):
                files.append(filename)

            for (nextpath,) in self.connection.execute(next_query, (path,)):
                description['next_page'] = nextpath
            for (prevpath,) in self.connection.execute(prev_query, (path,)):
                description['previous_page'] = prevpath

        latest_page_name = os.path.join(self.subdir, 'latest.html')
        description['next_page'] = latest_page_name

        description = groups[latest_page_name] = {}
        prev_query = self.Queries.select_prev_page_nonnull
        for (prevpath,) in self.connection.execute(prev_query):
            description['previous_page'] = prevpath
        files = groups[latest_page_name].setdefault('files', [])
        query = self.Queries.select_null_dependency
        for (filename,) in self.connection.execute(query):
            files.append(filename)
        if not files:
            groups[path].pop('next_page', None)
            description = groups[latest_page_name] = dict(groups[path])

        return groups

    def update_built_files(self):
        self.connection.execute(self.Queries.insert_build_update)
        self.connection.execute(self.Queries.delete_after_update)
        self.connection.commit()


class _BuildWalker(IndexWalker):
    """IndexWalker that feeds BuildCache's pending_changes table."""

    def __init__(self, cache, cursor):
        super().__init__(cache.hash_name)
        self.cache = cache
        self.cursor = cursor

    def get_index(self, path):
        index_path = os.path.join(path, 'index.cbor')
        return load_index(index_path)

    def get_stored_hash(self, path):
        reldir = os.path.relpath(path, self.cache.root)
        for (last_hash,) in self.cursor.execute(
            BuildCache.Queries.select_stale_hash, (reldir, self.hash_name)
        ):
            return last_hash
        return None

    def store_hash(self, path, hash_value):
        # BuildCache stores hashes via pending_changes + update_built_files
        pass

    def on_directory(self, dirpath, index):
        reldir = os.path.relpath(dirpath, self.cache.root)
        self.cursor.execute(
            BuildCache.Queries.insert_stale_check,
            (
                reldir,
                index['self_hashes'][self.hash_name],
                self.hash_name,
                EntryType.directory.value,
                None,
            ),
        )

    def on_entry(self, dirpath, entry, hashval):
        reldir = os.path.relpath(dirpath, self.cache.root)
        relpath = os.path.join(reldir, entry['filename'])
        entry_type_name = 'tag_ref' if entry['type'] == 'ref' else entry['type']
        self.cursor.execute(
            BuildCache.Queries.insert_stale_check,
            (
                relpath,
                hashval,
                self.hash_name,
                EntryType[entry_type_name].value,
                entry['timestamp'],
            ),
        )

        path_parts = relpath.split('/')
        if len(path_parts) >= 2 and path_parts[1].isalnum():
            self.cursor.execute(
                BuildCache.Queries.insert_post_path,
                (path_parts[1], entry['id'], relpath),
            )

        if entry['type'] == 'reply':
            self.cache.parse_reply(self.cursor, relpath)

    def walk(self, directory):
        """Walk starting from an absolute directory path."""
        self._walk(directory)

    def _walk(self, dirpath):
        index_path = os.path.join(dirpath, 'index.cbor')
        try:
            index = load_index(index_path)
        except FileNotFoundError:
            return

        reldir = os.path.relpath(dirpath, self.cache.root)
        stored = None
        for (last_hash,) in self.cursor.execute(
            BuildCache.Queries.select_stale_hash, (reldir, self.hash_name)
        ):
            stored = last_hash

        current = index['self_hashes'][self.hash_name]
        if stored is not None and stored == current:
            return

        self.on_directory(dirpath, index)

        for filename, hashval in index['child_hashes'][self.hash_name].items():
            entry = parse_entry(filename)
            if entry:
                self.on_entry(dirpath, entry, hashval)

        for subdir in index.get('dirnames', []):
            self._walk(os.path.join(dirpath, subdir))


def write_page_html(
    templates, root, target_filename, description, change_log, text_config
):
    print('writing', description, 'to', target_filename)
    target_filename = os.path.join(root, target_filename)
    dirname = os.path.dirname(target_filename)

    entries = []
    for fname in description['files']:
        full_fname = os.path.join(root, fname)
        with open(full_fname, 'rb') as f:
            entries.append(cbor2.load(f))

        post_bits = fname.split('/')
        post_bits[0] = 'posts'
        index = post_bits[-1].split('.')[1]
        post_bits[-1] = 'post.{}.html'.format(index)
        post_file = '/'.join(post_bits)
        post_file = os.path.join(root, post_file)
        post_dir = os.path.dirname(post_file)

        template_args = dict(
            entries=entries[-1:],
            posts=[entries[-1]['content']],
            root_path=os.path.relpath(root, post_dir),
            parent_path=os.path.relpath(target_filename, os.path.dirname(post_file)),
            text_config=text_config,
        )
        os.makedirs(post_dir, exist_ok=True)
        with open(post_file, 'w') as f:
            f.write(templates['post'].render(**template_args))
        entries[-1]['direct_link'] = os.path.relpath(post_file, dirname)
        entries[-1]['content']['direct_link'] = entries[-1]['direct_link']
        if change_log is not None:
            change_log.write('{}\n'.format(os.path.relpath(post_file, root)))

    os.makedirs(dirname, exist_ok=True)
    for name in ('next_page', 'previous_page'):
        if name in description:
            description[name] = os.path.relpath(
                os.path.join(root, description[name]), dirname
            )
    selected_posts = [entry['content'] for entry in entries]

    make_key = lambda p: (p['author']['id'], p['id'])
    post_index = {}
    roots = {}
    posts = []
    pending = []
    for p in selected_posts:
        key = make_key(p)
        post_index[key] = p
        if 'reply_to' in p:
            key = (p['reply_to']['author'], p['reply_to']['post_id'])
            pending.append((key, p))
        else:
            posts.append(p)
            roots[key] = p

    while pending:
        progress = False
        pending.sort(key=lambda x: x[0] in roots)
        while pending and pending[-1][0] in roots:
            progress = True
            parent_key, child = pending.pop()
            roots[make_key(child)] = roots[parent_key]
        if not progress:
            print('WARNING: child graph traversal issue')
            break

    for k, root_post in roots.items():
        # skip root-level posts
        if k == make_key(root_post):
            continue

        root_post.setdefault('replies', []).append(post_index[k])

    for p in post_index.values():
        if 'replies' in p:
            p['replies'].sort(key=lambda x: x['time'])

    posts.sort(key=lambda x: x['time'], reverse=True)

    template_args = dict(
        entries=entries,
        posts=posts,
        **description,
        root_path=os.path.relpath(root, dirname),
        text_config=text_config,
    )

    with open(target_filename, 'w') as f:
        f.write(templates['post'].render(**template_args))
    if change_log is not None:
        change_log.write('{}\n'.format(os.path.relpath(target_filename, root)))


def _load_repo_config(root):
    """Load config from config/*/latest.cbor in the repo."""
    config_dir = os.path.join(root, 'config')
    for name in os.listdir(config_dir):
        latest = os.path.join(config_dir, name, 'latest.cbor')
        if os.path.isfile(latest):
            with open(latest, 'rb') as f:
                entry = cbor2.load(f)
            return entry['content'].get('config', {})
    raise FileNotFoundError('No config found')


def render_tag_pages(cache, templates, text_config, change_log=None):
    """Render only the tag pages that have new content.

    Uses ``cache.repage_tags()`` for O(1)-per-post pagination and
    ``cache.get_pending_tag_pages()`` to re-render only changed pages.
    """
    from .tags import display_tag

    root = cache.root
    html_dir = cache.subdir

    tag_pages = cache.get_pending_tag_pages()

    for target_path, desc in tag_pages.items():
        tag_value = desc['tag_value']
        entries = []
        for _ref_file, post_path in desc['files']:
            if not post_path:
                continue
            try:
                with open(os.path.join(root, post_path), 'rb') as f:
                    entries.append(cbor2.load(f))
            except (FileNotFoundError, OSError):
                continue

        if not entries:
            continue

        posts = [e['content'] for e in entries]
        posts.sort(key=lambda p: p.get('time', ''), reverse=True)

        target = os.path.join(root, target_path)
        dirname = os.path.dirname(target)
        os.makedirs(dirname, exist_ok=True)

        description = {}
        if 'previous_page' in desc:
            description['previous_page'] = os.path.relpath(
                os.path.join(root, desc['previous_page']), dirname
            )

        template_args = dict(
            entries=entries,
            posts=posts,
            tag_name=display_tag(tag_value),
            tag_value=tag_value,
            root_path=os.path.relpath(root, dirname),
            text_config=text_config,
            **description,
        )

        with open(target, 'w') as f:
            f.write(templates['post'].render(**template_args))
        if change_log is not None:
            change_log.write('{}\n'.format(os.path.relpath(target, root)))

    # Re-render tag index if any tag pages changed
    all_tags = cache.get_all_tags()
    if all_tags and tag_pages:
        tag_summaries = [
            dict(
                type=tt,
                value=tv,
                display=display_tag(tv),
                count=cnt,
                url='{}/{}/latest.html'.format(tt, tv),
            )
            for tt, tv, cnt in all_tags
        ]
        tag_index_file = os.path.join(root, html_dir, 'tags', 'index.html')
        os.makedirs(os.path.dirname(tag_index_file), exist_ok=True)
        template_args = dict(
            tags=tag_summaries,
            root_path=os.path.relpath(
                root, os.path.dirname(tag_index_file)
            ),
            text_config=text_config,
        )
        with open(tag_index_file, 'w') as f:
            f.write(templates['tag_index'].render(**template_args))
        if change_log is not None:
            change_log.write(
                '{}\n'.format(os.path.relpath(tag_index_file, root))
            )


def generate_pwa_manifest(root):
    """Scan the source tree and write ``pwa-manifest.json``.

    The manifest maps virtual Pyodide FS paths to fetch URLs (relative to
    ``pwa/``).  ``pyodide-loader.js`` reads this manifest so that adding
    new Python modules, templates, or static assets never requires
    updating a hardcoded list.
    """
    import json

    files = {}

    # Python package — every .py under coulomb/
    pkg_dir = os.path.join(root, 'coulomb')
    if os.path.isdir(pkg_dir):
        for fname in sorted(os.listdir(pkg_dir)):
            if fname.endswith('.py'):
                files['/coulomb/coulomb/' + fname] = '../coulomb/' + fname

    # Templates
    tpl_dir = os.path.join(root, 'template')
    if os.path.isdir(tpl_dir):
        for dirpath, _dirs, fnames in os.walk(tpl_dir):
            for fname in sorted(fnames):
                full = os.path.join(dirpath, fname)
                rel = os.path.relpath(full, root)
                files['/coulomb/' + rel] = '../' + rel

    manifest_path = os.path.join(root, 'pwa-manifest.json')
    with open(manifest_path, 'w') as f:
        json.dump(files, f, indent=2, sort_keys=True)


def main(
    root,
    cache_file,
    hash_name,
    template_dir,
    change_log,
    post_dirs,
    html_dir,
    pwa_dir=None,
):
    env = jinja2.Environment()
    env.filters['identicon'] = identicon_data_uri
    env.filters['markdown'] = lambda text: Markup(render_markdown(text))
    env.filters['display_tag'] = lambda v: v.replace('-', ' ')
    env.globals['html_dir'] = html_dir
    templates = {}
    if template_dir:
        with open(os.path.join(template_dir, 'post.jinja'), 'r') as f:
            templates['post'] = env.from_string(f.read())
    else:
        for k, v in TEMPLATES.items():
            templates[k] = env.from_string(v)

    try:
        text_config = _load_repo_config(root)
    except (FileNotFoundError, KeyError, StopIteration, OSError):
        text_config = {}

    cache = BuildCache(root, cache_file, hash_name, html_dir)
    for post_dir in post_dirs:
        cache.stale_check(os.path.join(root, post_dir))
    # Walk tags tree if it exists
    tags_dir = os.path.join(root, 'tags')
    if os.path.isdir(tags_dir):
        cache.stale_check(tags_dir)

    cache.repage()
    cache.repage_tags()
    file_groups = cache.get_pending_pages()

    with contextlib.ExitStack() as stack:
        if change_log is not None:
            change_log = stack.enter_context(open(change_log, 'a'))

        for target_html, description in file_groups.items():
            write_page_html(
                templates, root, target_html, description, change_log, text_config
            )

        render_tag_pages(cache, templates, text_config, change_log)

    cache.update_built_files()

    if pwa_dir and os.path.isdir(pwa_dir):
        dst = os.path.join(root, 'pwa')
        if os.path.exists(dst):
            shutil.rmtree(dst)
        shutil.copytree(pwa_dir, dst)
    generate_pwa_manifest(root)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    add_parser_args(parser)
    main(**vars(parser.parse_args()))
