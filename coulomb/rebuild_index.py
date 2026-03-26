import argparse
import collections
import datetime
import hashlib
import os
import shutil

import cbor2
import nacl.signing

from .cmd import register_subcommand


@register_subcommand(
    'rebuild_index',
    'rebuild-index',
    'reindex',
    help='Rebuild indices for updated posts',
)
def add_parser_args(parser):
    parser.add_argument('root', help='Root directory for posts')
    parser.add_argument(
        '-x', '--hashes', nargs='*', default=[], help='Hash functions to use'
    )
    parser.add_argument(
        '-c', '--changelog', help='Changelog file to use, otherwise manually stat files'
    )
    parser.add_argument(
        '-f',
        '--filter',
        nargs='*',
        dest='filter_',
        help='Path fragments to require when rebuilding indices',
    )


def main(root, hashes, changelog, filter_):
    hashes = hashes or ['sha512']

    rebuild_directories = collections.defaultdict(set)
    if changelog is None:
        for dirpath, _, fnames in os.walk(root):
            reldir = os.path.relpath(dirpath, root)

            if filter_ and not any(f in reldir for f in filter_):
                continue

            bits = tuple(reldir.split('/'))
            for i in range(len(bits)):
                rebuild_directories[bits[:i]].add(bits[i])
            rebuild_directories[bits].update(fnames)
    else:
        with open(changelog, 'r') as f:
            for line in f:
                line = line.strip()

                if filter_ and not any(f in line for f in filter_):
                    continue

                bits = tuple(line.split('/'))
                for i in range(len(bits)):
                    rebuild_directories[bits[:i]].add(bits[i])

    changelog_pieces = [
        (-len(ds), ds, list(fs)) for (ds, fs) in rebuild_directories.items()
    ]
    changelog_pieces.sort()

    for _, dirbits, fnames in changelog_pieces:
        dirname = os.path.join(root, *dirbits)
        index_name = os.path.join(dirname, 'index.cbor')

        try:
            with open(index_name, 'rb') as f:
                index = cbor2.load(f)
        except FileNotFoundError:
            index = {}

        new_filenames, new_dirnames = [], []
        for fname in fnames:
            if os.path.isdir(os.path.join(dirname, fname)):
                new_dirnames.append(fname)
            else:
                new_filenames.append(fname)

        filenames = set(index.get('filenames', []))
        filenames.update(new_filenames)
        index['filenames'] = list(filenames)
        dirnames = set(index.get('dirnames', []))
        dirnames.update(new_dirnames)
        index['dirnames'] = list(dirnames)

        index.setdefault('child_hashes', {})
        index.setdefault('self_hashes', {})

        for hname in hashes:
            current_hashes = index['child_hashes'].setdefault(hname, {})

            for fname in new_filenames:
                full_fname = os.path.join(dirname, fname)
                with open(full_fname, 'rb') as f:
                    current_hashes[fname] = hashlib.file_digest(f, hname).digest()
            for dname in new_dirnames:
                child_index_name = os.path.join(dirname, dname, 'index.cbor')
                with open(child_index_name, 'rb') as f:
                    child_index = cbor2.load(f)
                current_hashes[dname] = child_index['self_hashes'][hname]

            child_hash_bytes = cbor2.dumps(current_hashes, canonical=True)
            index['self_hashes'][hname] = getattr(hashlib, hname)(
                child_hash_bytes
            ).digest()

        with open(index_name, 'wb') as f:
            cbor2.dump(index, f, canonical=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    add_parser_args(parser)
    main(**vars(parser.parse_args()))
