
import os
import sqlite3
from posixpath import join as urljoin

import cbor2

from .cmd import register_subcommand
from .index_walker import IndexWalker, load_index_bytes, BaseQueries



@register_subcommand('pull', help='Import external post repositories')
def add_parser_args(parser):
    parser.add_argument('root', help='Root (target) directory for posts')
    parser.add_argument(
        'cache_file', help='Cache file (sqlite3 db) for tracking smart updates'
    )
    parser.add_argument(
        'sources', nargs='+', help='Source locations to draw additional posts'
    )
    parser.add_argument(
        '-x', '--hash-name', default='sha512', help='Hash function to use'
    )
    parser.add_argument('--change-log', help='Changelog file to write to')


class Queries:
    create_sources = ' '.join(
        [
            'CREATE TABLE IF NOT EXISTS sources',
            '(location TEXT UNIQUE ON CONFLICT IGNORE)',
        ]
    )
    create_hashes = ' '.join(
        [
            'CREATE TABLE IF NOT EXISTS source_hashes (',
            'source_id INTEGER, path TEXT, hash BLOB, hash_name TEXT,',
            'UNIQUE(source_id, path) ON CONFLICT REPLACE)',
        ]
    )

    init = ';'.join([create_sources, create_hashes])

    insert_location = 'INSERT INTO sources VALUES (?)'

    lookup_location = 'SELECT ROWID from sources WHERE location = ?'

    insert_hash = 'INSERT INTO source_hashes VALUES (?, ?, ?, ?)'

    get_hash = ' '.join(
        [
            'SELECT hash FROM source_hashes WHERE',
            'source_id = ? AND path = ? AND hash_name = ?',
        ]
    )


def _url_fetcher(location):
    import urllib.request

    with urllib.request.urlopen(location) as f:
        return f.read()


def _local_fetcher(location):
    with open(location, 'rb') as f:
        return f.read()


class PullCache(IndexWalker):
    def __init__(self, root, filename, hash_name, fetcher=None, change_log=None):
        super().__init__(hash_name)
        self.root = root
        self.filename = filename
        self.connection = sqlite3.connect(filename)
        self._fetcher = fetcher or _url_fetcher
        self.change_log = change_log
        self.imported_count = 0
        self._location = None
        self._remote_id = None

        self.init()

    def init(self):
        with self.connection as conn:
            conn.executescript(Queries.init)

    def get(self, location):
        return self._fetcher(location)

    def _log_change(self, relpath):
        if self.change_log:
            self.change_log.write(relpath + '\n')

    # IndexWalker interface

    def get_index(self, path):
        if path == '.':
            url = urljoin(self._location, 'index.cbor')
        else:
            url = urljoin(self._location, path, 'index.cbor')
        try:
            index_bytes = self.get(url)
        except IOError:
            return None
        return load_index_bytes(index_bytes)

    def get_stored_hash(self, path):
        with self.connection as conn:
            for (last_hash,) in conn.execute(
                Queries.get_hash, (self._remote_id, path, self.hash_name)
            ):
                return last_hash
        return None

    def store_hash(self, path, hash_value):
        with self.connection as conn:
            conn.execute(
                Queries.insert_hash, (self._remote_id, path, hash_value, self.hash_name)
            )

    def on_entry(self, dirpath, entry, hashval):
        # Tag references are derived data, regenerated locally after import
        if entry['type'] == 'ref':
            return
        sub_filename = os.path.join(dirpath, entry['filename'])
        if dirpath == '.':
            sub_filename = entry['filename']
        self._import_post(
            self._location,
            self._remote_id,
            sub_filename,
            hashval,
            entry['type'],
            entry['id'],
        )

    def on_identity(self, dirpath, filename, hashval):
        sub_filename = os.path.join(dirpath, filename)
        if dirpath == '.':
            sub_filename = filename
        self._import_identity(
            self._location, self._remote_id, sub_filename, hashval, dirpath
        )

    # Pull-specific logic

    def stale_check(self, location):
        self._location = location
        self._remote_id = None
        with self.connection as conn:
            conn.execute(Queries.insert_location, (location,))
            for (location_id,) in conn.execute(Queries.lookup_location, (location,)):
                self._remote_id = location_id

        self.walk('.')

    def _import_post(
        self, location, remote_id, filename, hashval, entry_type, entry_id
    ):
        with self.connection as conn:
            last_hash = None
            for (last_hash,) in conn.execute(
                Queries.get_hash, (remote_id, filename, self.hash_name)
            ):
                pass

            if last_hash == hashval:
                return

        entry_bytes = self.get(urljoin(location, filename))
        full_dest = os.path.join(self.root, filename)

        if not os.path.exists(full_dest):
            os.makedirs(os.path.dirname(full_dest), exist_ok=True)
            with open(full_dest, 'wb') as f:
                f.write(entry_bytes)
            self._log_change(filename)
            self.imported_count += 1

            # Regenerate tag reference files for imported posts
            self._regenerate_tag_refs(full_dest, filename)

        with self.connection as conn:
            conn.execute(
                Queries.insert_hash, (remote_id, filename, hashval, self.hash_name)
            )

    def _regenerate_tag_refs(self, full_path, rel_path):
        """Create tag reference files for an imported post."""
        from .tags import extract_tags
        from .util import write_cbor

        try:
            with open(full_path, 'rb') as f:
                entry = cbor2.load(f)
        except (cbor2.CBORDecodeError, OSError):
            return

        content = entry.get('content', {})
        text = content.get('text', '')
        tags = extract_tags(text)
        if not tags:
            return

        post_id = content.get('id', '')
        author_id = content.get('author', {}).get('id', '')
        timestamp = content.get('time', '')

        for tag in tags:
            tag_dir = os.path.join(self.root, 'tags', tag['type'], tag['value'])
            ref_fname = os.path.join(tag_dir, 'ref.{}.cbor'.format(post_id))
            if os.path.exists(ref_fname):
                continue
            os.makedirs(tag_dir, exist_ok=True)
            ref = dict(
                author=author_id,
                post_id=post_id,
                post_path=rel_path,
                timestamp=timestamp,
            )
            write_cbor({ref_fname: ref})
            self._log_change(os.path.relpath(ref_fname, self.root))

    def _import_identity(self, location, remote_id, filename, hashval, remote_subdir):
        with self.connection as conn:
            last_hash = None
            for (last_hash,) in conn.execute(
                Queries.get_hash, (remote_id, filename, self.hash_name)
            ):
                pass

            if last_hash == hashval:
                return

        entry_bytes = self.get(urljoin(location, filename))

        # Preserve the identity directory structure: identity/<key_id>/...
        dest_path = filename
        full_dest = os.path.join(self.root, dest_path)

        os.makedirs(os.path.dirname(full_dest), exist_ok=True)
        with open(full_dest, 'wb') as f:
            f.write(entry_bytes)
        self._log_change(dest_path)
        self.imported_count += 1

        with self.connection as conn:
            conn.execute(
                Queries.insert_hash, (remote_id, filename, hashval, self.hash_name)
            )


def main(root, cache_file, sources, hash_name, change_log, fetcher=None):
    import contextlib

    change_log_fh = None
    if isinstance(change_log, str):
        change_log_fh = open(change_log, 'a')
    elif change_log is not None:
        change_log_fh = change_log

    cache = PullCache(
        root, cache_file, hash_name, fetcher=fetcher, change_log=change_log_fh
    )

    try:
        for src in sources:
            cache.stale_check(src)
    finally:
        if isinstance(change_log, str) and change_log_fh:
            change_log_fh.close()

    return cache.imported_count
