import argparse
import os
import shutil

import cbor2
import nacl.signing

from .cmd import register_subcommand
from .util import read_cbor, write_cbor
from .TimeArchive import UserPostArchive


@register_subcommand('post', help='Make a post')
def add_parser_args(parser):
    parser.add_argument('root', help='Root directory for posts')
    parser.add_argument('author', help='Source file containing author info')
    parser.add_argument('-t', '--text', help='Text content of message')
    parser.add_argument(
        '-f',
        '--files',
        nargs='+',
        default=[],
        help='Additional files to store and link',
    )
    parser.add_argument(
        '-s', '--signatures', nargs='*', default=[], help='Keys to use to sign'
    )
    parser.add_argument(
        '-c',
        '--changelogs',
        nargs='*',
        default=[],
        help='Changelog file to record changes to',
    )
    parser.add_argument('--reply', help='If given, reply to the given post file')


def main(root, author, text, files, signatures, changelogs, reply):
    author_info = read_cbor(author)['content']['author']

    sign_keys = {}
    for s in signatures:
        key = read_cbor(s)['signing']
        key = nacl.signing.SigningKey(key)
        name = bytes(key.verify_key).hex()
        sign_keys[name] = key

    filenames = files
    assert not any(
        os.path.basename(f) == 'index.cbor' for f in filenames
    ), 'Can not link a file named index.cbor'
    assert len({os.path.basename(f) for f in filenames}) == len(
        filenames
    ), 'Files must have unique names'
    files = []

    for name in sorted(set(filenames)):
        target_name = os.path.basename(name)
        entry = dict(name=target_name)
        assert os.path.isfile(name)
        with open(name, 'rb') as f:
            b = f.read()
        entry['signatures'] = {k: s.sign(b).signature for k, s in sign_keys.items()}
        files.append(entry)

    extra_post_fields = {}
    archive_kwargs = dict(user_id=author_info['id'])
    if reply is not None:
        reply_target = read_cbor(reply)['content']
        reply_author = reply_target['author']['id']
        assert reply_author.isalnum()
        reply_id = reply_target['id']

        archive_kwargs['entry_format'] = (
            'replies/{reply_author}/{target_id}/reply.{{id}}.cbor'.format(
                reply_author=reply_author, target_id=reply_id
            )
        )
        extra_post_fields['reply_to'] = dict(
            author=reply_author,
            post_id=reply_id,
        )

    archive = UserPostArchive(**archive_kwargs)

    done = False
    while not done:
        archive_entry = archive.get_path()

        post_fname = os.path.join(root, archive_entry.path)
        if os.path.exists(post_fname):
            continue

        post_id = archive_entry.id

        post = dict(
            author=author_info,
            files=files,
            id=post_id,
            text=text,
            time=archive_entry.timestamp.isoformat(),
            **extra_post_fields,
        )

        post_enc = cbor2.dumps(post, canonical=True)
        entry = dict(
            content=post,
            signatures={k: s.sign(post_enc).signature for k, s in sign_keys.items()},
        )

        target_dir = os.path.dirname(post_fname)
        changed_files = [post_fname]

        if files:
            media_dir = os.path.join(target_dir, post_id, 'files')
            os.makedirs(media_dir)
            for fname in filenames:
                shutil.copy(fname, media_dir)

                changed_files.append(os.path.join(media_dir, os.path.basename(fname)))

        os.makedirs(target_dir, exist_ok=True)
        write_cbor({post_fname: entry})

        done = True

    for logname in changelogs:
        with open(logname, 'a') as f:
            for filename in changed_files:
                filename = os.path.relpath(filename, root)
                f.write('{}\n'.format(filename))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    add_parser_args(parser)
    main(**vars(parser.parse_args()))
