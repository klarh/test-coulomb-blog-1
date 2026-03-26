import argparse
import os

import cbor2

from .cmd import register_subcommand, CommonArgs
from .util import read_cbor, write_cbor, get_signatures
from .TimeArchive import ConfigArchive


@register_subcommand('config', help='Manage repository configuration')
def add_parser_args(parser):
    CommonArgs.add(parser, 'identity', 'change_log', 'signatures')
    parser.add_argument(
        '-t',
        '--text',
        nargs=2,
        action='append',
        default=[],
        help='(key, value) pair of config values to set',
    )
    parser.add_argument(
        '-d',
        '--delete',
        nargs='*',
        default=[],
        help='Config keys to delete',
    )


def main(identity, change_log, signatures, text, delete):
    # identity path points to identity/<key_id>, derive public root
    public = os.path.join(identity, '..', '..')
    public = os.path.normpath(public)
    key_id = os.path.basename(identity)

    # Load existing config from latest.cbor if it exists
    config_dir = os.path.join(public, 'config', key_id)
    latest = os.path.join(config_dir, 'latest.cbor')
    try:
        existing = read_cbor(latest)
        config = dict(existing['content']['config'])
    except (FileNotFoundError, KeyError):
        config = {}

    # Apply changes
    for k, v in text:
        config[k] = v
    for k in delete:
        config.pop(k, None)

    # Build the signed entry
    archive = ConfigArchive(user_id=key_id)
    archive_entry = archive.get_path()

    content = dict(config=config)
    content_enc = cbor2.dumps(content, canonical=True)
    entry = dict(
        content=content,
        signatures=get_signatures(content_enc, signatures),
    )

    # Write timestamped archive entry + latest.cbor
    config_fname = os.path.join(public, archive_entry.path)
    os.makedirs(os.path.dirname(config_fname), exist_ok=True)
    os.makedirs(config_dir, exist_ok=True)
    write_cbor(
        {
            config_fname: entry,
            latest: entry,
        }
    )

    # Record in changelog
    if change_log is not None:
        with open(change_log, 'a') as f:
            for fname in (config_fname, latest):
                f.write('{}\n'.format(os.path.relpath(fname, public)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    add_parser_args(parser)
    main(**vars(parser.parse_args()))
