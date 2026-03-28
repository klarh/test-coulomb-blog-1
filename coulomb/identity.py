import argparse
import os

import cbor2
import nacl.public
import nacl.signing

from .cmd import register_subcommand, SubcommandHandler, CommonArgs
from .util import read_cbor, write_cbor, get_signatures
from .TimeArchive import IdentityArchive

IdentitySubcommand = SubcommandHandler()


@IdentitySubcommand.register_subcommand(
    'add_key', 'addkey', 'add-key', help='Add a key'
)
def add_key_parser_args(parser):
    CommonArgs.add(parser, 'identity', 'change_log', 'signatures')
    parser.add_argument('-k', '--key-files', nargs='*', help='Key file(s) to store')


@IdentitySubcommand.register_subcommand(
    'rm_key', 'rmkey', 'remove-key', help='Remove a key'
)
def remove_key_parser_args(parser):
    CommonArgs.add(parser, 'identity', 'change_log', 'signatures')
    parser.add_argument('-k', '--key-ids', nargs='*', help='Key id(s) to remove')


@IdentitySubcommand.register_subcommand(
    'set_config', 'set-config', 'config', help='Set configuration options'
)
def set_config_parser_args(parser):
    CommonArgs.add(parser, 'identity', 'change_log', 'signatures')
    parser.add_argument(
        '-t',
        '--text',
        nargs=2,
        action='append',
        default=[],
        help='(key, value) pair of text quantitites to set',
    )


@IdentitySubcommand.register_subcommand(
    'add_location', 'add-location', help='Add a published location'
)
def add_location_parser_args(parser):
    CommonArgs.add(parser, 'identity', 'change_log', 'signatures')
    parser.add_argument('location', help='Location/URL to add')
    parser.add_argument(
        '-i', '--index', type=int, help='Index in list to add new location'
    )


@IdentitySubcommand.register_subcommand(
    'rm_location', 'rm-location', help='Add a published location'
)
def rm_location_parser_args(parser):
    CommonArgs.add(parser, 'identity', 'change_log', 'signatures')
    parser.add_argument('location', help='Location/URL to remove')


@register_subcommand('identity', 'id', help='Update author identity')
def add_parser_args(parser):
    subparsers = parser.add_subparsers(dest='sub2cmd', required=True, help='Action')
    for names, cmd_info in IdentitySubcommand.subcommands.items():
        name = names[0]
        subparser = subparsers.add_parser(name, aliases=names[1:], help=cmd_info.help)
        subparser.description = cmd_info.help
        cmd_info.arg_function(subparser)


def write_updated_identity(author, identity, change_log, signatures):
    post = dict(author=author)
    post_encoded = cbor2.dumps(post, canonical=True)
    entry = dict(content=post, signatures=get_signatures(post_encoded, signatures))

    archive = IdentityArchive(prefix=identity)
    public = os.path.join(identity, '..', '..')
    targets = [
        os.path.join(identity, 'latest.cbor'),
        os.path.join(identity, archive.get_path().path),
    ]
    for fname in targets:
        dirpath = os.path.dirname(fname)
        os.makedirs(dirpath, exist_ok=True)
        write_cbor({fname: entry})

        if change_log is not None:
            change_log.write('{}\n'.format(os.path.relpath(fname, public)))


def add_key(identity, change_log, signatures, key_files):
    author = read_cbor(os.path.join(identity, 'latest.cbor'))['content']['author']

    for key in key_files:
        key_dict = read_cbor(key)

        if 'signing' in key_dict:
            signing_key = nacl.signing.SigningKey(key_dict['signing'])
            key_id = bytes(signing_key.verify_key).hex()
            author.setdefault('signing_keys', []).append(key_id)
        if 'encryption' in key_dict:
            encryption_key = nacl.public.PrivateKey(key_dict['encryption'])
            key_id = bytes(encryption_key.public_key).hex()
            author.setdefault('encryption_keys', []).append(key_id)

    write_updated_identity(author, identity, change_log, signatures)


def rm_key(identity, change_log, signatures, key_ids):
    author = read_cbor(os.path.join(identity, 'latest.cbor'))['content']['author']

    signing_keys = set(author.get('signing_keys', []))
    encryption_keys = set(author.get('encryption_keys', []))
    for key in key_ids:
        signing_keys.discard(key)
        encryption_keys.discard(key)

    author['signing_keys'] = list(sorted(signing_keys))
    author['encryption_keys'] = list(sorted(encryption_keys))

    write_updated_identity(author, identity, change_log, signatures)


def set_config(identity, change_log, signatures, text):
    author = read_cbor(os.path.join(identity, 'latest.cbor'))['content']['author']
    config = author.setdefault('config', {})

    for k, v in text:
        config[k] = v

    write_updated_identity(author, identity, change_log, signatures)


def add_location(identity, change_log, signatures, location, index):
    author = read_cbor(os.path.join(identity, 'latest.cbor'))['content']['author']
    locations = author.setdefault('locations', [])

    # Normalize: strip trailing slashes for comparison
    normalized = location.rstrip('/')
    if any(loc.rstrip('/') == normalized for loc in locations):
        return  # already present

    index = index if index is not None else len(locations)
    locations.insert(index, location)

    write_updated_identity(author, identity, change_log, signatures)


def rm_location(identity, change_log, signatures, location):
    author = read_cbor(os.path.join(identity, 'latest.cbor'))['content']['author']
    locations = author.setdefault('locations', [])

    locations.remove(location)

    write_updated_identity(author, identity, change_log, signatures)


def dedup_locations(identity, change_log, signatures):
    """Remove duplicate locations, keeping the first occurrence."""
    author = read_cbor(os.path.join(identity, 'latest.cbor'))['content']['author']
    locations = author.setdefault('locations', [])

    seen = set()
    unique = []
    for loc in locations:
        normalized = loc.rstrip('/')
        if normalized not in seen:
            seen.add(normalized)
            unique.append(loc)

    if len(unique) < len(locations):
        author['locations'] = unique
        write_updated_identity(author, identity, change_log, signatures)
        return len(locations) - len(unique)
    return 0


def main(sub2cmd, **kwargs):
    globals()[IdentitySubcommand[sub2cmd].names[0]](**kwargs)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    add_parser_args(parser)
    main(**vars(parser.parse_args()))
