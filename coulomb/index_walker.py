"""Shared index.cbor walking logic with hash-based change detection.

Both PullCache (pull.py) and BuildCache (render.py) walk index.cbor trees
comparing self_hashes to skip unchanged subtrees. This module extracts
that shared pattern into a reusable base class.
"""

import os
import sqlite3

import cbor2


class BaseQueries:
    """Minimal SQL for hash caching — subclasses extend with their own tables."""

    create_hash_cache = ' '.join(
        [
            'CREATE TABLE IF NOT EXISTS hash_cache (',
            'source_id INTEGER, path TEXT, hash BLOB, hash_name TEXT,',
            'UNIQUE(source_id, path) ON CONFLICT REPLACE)',
        ]
    )

    select_hash = ' '.join(
        [
            'SELECT hash FROM hash_cache',
            'WHERE source_id = ? AND path = ? AND hash_name = ?',
        ]
    )

    insert_hash = 'INSERT INTO hash_cache VALUES (?, ?, ?, ?)'


def load_index(path):
    """Load an index.cbor file from a local path."""
    with open(path, 'rb') as f:
        return cbor2.load(f)


def load_index_bytes(data):
    """Load an index.cbor from raw bytes."""
    return cbor2.loads(data)


def parse_entry(filename):
    """Parse a coulomb entry filename into its components.

    Returns dict with 'type', 'id', 'timestamp' or None if not a
    recognized entry format.

    Examples:
        'post.abc123.1719600000.cbor' → {type: 'post', id: 'abc123', timestamp: '1719600000'}
        'reply.def456.1719600001.cbor' → {type: 'reply', id: 'def456', timestamp: '1719600001'}
    """
    bits = filename.split('.')
    if len(bits) < 3 or not filename.endswith('cbor'):
        return None
    entry_type = bits[0]
    if entry_type not in ('post', 'reply'):
        return None
    return {
        'type': entry_type,
        'id': bits[1],
        'timestamp': bits[-2],
        'filename': filename,
    }


class IndexWalker:
    """Base class for walking index.cbor trees with hash-based skipping.

    Subclasses implement:
        - get_index(path)       → index dict (how to load the index)
        - get_stored_hash(path) → bytes or None (lookup cached hash)
        - store_hash(path, h)   → None (save hash after processing)
        - on_entry(path, entry, hashval) → None (process a post/reply entry)
        - on_directory(path)    → None (optional, called when entering a changed dir)

    The walk skips entire subtrees whose self_hash hasn't changed.
    """

    def __init__(self, hash_name='sha512'):
        self.hash_name = hash_name

    def get_index(self, path):
        """Load the index.cbor at the given path. Override for remote fetching."""
        raise NotImplementedError

    def get_stored_hash(self, path):
        """Return the previously stored self_hash for this path, or None."""
        raise NotImplementedError

    def store_hash(self, path, hash_value):
        """Store the self_hash for this path after processing."""
        raise NotImplementedError

    def on_entry(self, dirpath, entry, hashval):
        """Called for each post/reply entry in a changed directory.

        Args:
            dirpath: relative directory path (e.g. 'posts/2025/0625/1430')
            entry: parsed entry dict from parse_entry()
            hashval: the file's hash from child_hashes
        """
        pass

    def on_identity(self, dirpath, filename, hashval):
        """Called for identity files (latest.cbor, identity.*.cbor).

        Args:
            dirpath: relative directory path
            filename: the identity filename
            hashval: the file's hash from child_hashes
        """
        pass

    def on_directory(self, dirpath, index):
        """Called when entering a directory that has changed.

        Args:
            dirpath: relative directory path
            index: the loaded index dict
        """
        pass

    def walk(self, path):
        """Walk the index tree starting at path, skipping unchanged subtrees."""
        self._walk(path)

    def _walk(self, dirpath):
        index = self.get_index(dirpath)

        stored = self.get_stored_hash(dirpath)
        current = index['self_hashes'][self.hash_name]

        if stored is not None and stored == current:
            return  # Subtree unchanged

        self.on_directory(dirpath, index)

        # Process entries in this directory
        for filename, hashval in index['child_hashes'][self.hash_name].items():
            entry = parse_entry(filename)
            if entry:
                self.on_entry(dirpath, entry, hashval)
            elif filename == 'latest.cbor' or (
                filename.startswith('identity.') and filename.endswith('.cbor')
            ):
                self.on_identity(dirpath, filename, hashval)

        # Recurse into subdirectories
        for subdir in index.get('dirnames', []):
            if subdir == '.':
                continue
            child_path = os.path.join(dirpath, subdir) if dirpath != '.' else subdir
            self._walk(child_path)

        # Cache the current hash after processing
        self.store_hash(dirpath, current)
