import argparse

import cbor2
import nacl.signing

from .cmd import register_subcommand
from .util import read_cbor


@register_subcommand('verify', help='Verify signatures')
def add_parser_args(parser):
    parser.add_argument('target', help='Target filename to verify')


def main(target):
    entry = read_cbor(target)
    content = entry['content']
    author = content['author']
    usable_keys = set(author['signing_keys'])
    content_bytes = cbor2.dumps(content, canonical=True)

    assert usable_keys.intersection(
        entry['signatures']
    ), 'No author-endorsed signatures found'

    for key_id, signature in entry['signatures'].items():
        if key_id in usable_keys:
            key = nacl.signing.VerifyKey(bytes.fromhex(key_id))
            assert key.verify(content_bytes, signature)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    add_parser_args(parser)
    main(**vars(parser.parse_args()))
