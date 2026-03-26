import argparse
import contextlib
import os
import shutil

import cbor2
import nacl.signing

from .cmd import register_subcommand, CommonArgs
from .util import write_cbor
from .TimeArchive import IdentityArchive


@register_subcommand('init', help='Initialize a repository')
def add_parser_args(parser):
    CommonArgs.add(parser, 'public', 'private', 'change_log')
    parser.add_argument('-s', '--source', help='Source template directory')
    parser.add_argument(
        '-p',
        '--print',
        dest='print_',
        default='id',
        help='Quantity to print (id, private_key_path)',
    )


def main(public, private, source, change_log, print_):
    assert not os.path.exists(public)
    assert os.path.realpath(public) != os.path.realpath(private)

    if source is None:
        script_dir = os.path.dirname(__file__)
        source = os.path.join(script_dir, '..', 'template')

    assert os.path.exists(source)

    with contextlib.ExitStack() as stack:
        if change_log is not None:
            change_log = stack.enter_context(open(change_log, 'a'))

        identity_key = nacl.signing.SigningKey.generate()
        key_id = bytes(identity_key.verify_key).hex()

        private_key = dict(
            id=key_id,
            signing=bytes(identity_key),
            api='pynacl',
        )

        os.makedirs(private, exist_ok=True)
        private_key_fname = os.path.join(
            private, 'private_identity.{}.cbor'.format(key_id)
        )
        write_cbor({private_key_fname: private_key})

        author = dict(
            id=key_id,
            signing_keys=[key_id],
        )
        post = dict(author=author)
        post_encoded = cbor2.dumps(post, canonical=True)
        entry = dict(
            content=post,
            signatures={key_id: identity_key.sign(post_encoded).signature},
        )

        archive = IdentityArchive(prefix=os.path.join('identity', key_id))
        targets = [
            os.path.join(public, archive.prefix, 'latest.cbor'),
            os.path.join(public, archive.get_path().path),
        ]
        for fname in targets:
            dirpath = os.path.dirname(fname)
            os.makedirs(dirpath, exist_ok=True)
            write_cbor({fname: entry})

            if change_log is not None:
                change_log.write('{}\n'.format(os.path.relpath(fname, public)))

        for dirpath, _, fnames in os.walk(source):
            reldir = os.path.relpath(dirpath, source)
            target_dir = os.path.join(public, reldir)
            os.makedirs(target_dir, exist_ok=True)
            for fname in fnames:
                shutil.copy(os.path.join(dirpath, fname), target_dir)
                if change_log is not None:
                    change_log.write('{}\n'.format(os.path.join(reldir, fname)))

    if print_ == 'private_key_path':
        print(private_key_fname)
    else:
        print(key_id)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    add_parser_args(parser)
    main(**vars(parser.parse_args()))
