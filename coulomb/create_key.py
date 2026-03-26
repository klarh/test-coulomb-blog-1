import argparse
import os

import cbor2
import nacl.public
import nacl.signing

from .cmd import register_subcommand, SubcommandHandler, CommonArgs
from .util import read_cbor, write_cbor, get_signatures

CreateKeySubcommand = SubcommandHandler()


@CreateKeySubcommand.register_subcommand('encryption', help='Add an encryption key')
def add_key_parser_args(parser):
    CommonArgs.add(parser, 'private')
    parser.add_argument(
        '-p',
        '--print',
        dest='print_',
        default='id',
        help='Quantity to print (id, filename)',
    )


@CreateKeySubcommand.register_subcommand('signing', help='Add a signing key')
def add_key_parser_args(parser):
    CommonArgs.add(parser, 'private')
    parser.add_argument(
        '-p',
        '--print',
        dest='print_',
        default='id',
        help='Quantity to print (id, filename)',
    )


@register_subcommand('create_key', 'create-key', help='Create new cryptographic keys')
def add_parser_args(parser):
    subparsers = parser.add_subparsers(dest='sub2cmd', required=True, help='Action')
    for names, cmd_info in CreateKeySubcommand.subcommands.items():
        name = names[0]
        subparser = subparsers.add_parser(name, aliases=names[1:], help=cmd_info.help)
        subparser.description = cmd_info.help
        cmd_info.arg_function(subparser)


def signing(private, print_):
    key = nacl.signing.SigningKey.generate()
    key_id = bytes(key.verify_key).hex()

    private_key = dict(
        id=key_id,
        signing=bytes(key),
        api='pynacl',
    )

    filename = os.path.join(private, 'signing.{}.cbor'.format(key_id))
    write_cbor({filename: private_key})
    if print_ == 'filename':
        print(filename)
    else:
        print(key_id)


def encryption(private, print_='id'):
    key = nacl.public.PrivateKey.generate()
    key_id = bytes(key.public_key).hex()

    private_key = dict(
        id=key_id,
        encryption=bytes(key),
        api='pynacl',
    )

    filename = os.path.join(private, 'encryption.{}.cbor'.format(key_id))
    write_cbor({filename: private_key})
    if print_ == 'filename':
        print(filename)
    else:
        print(key_id)


def main(sub2cmd, **kwargs):
    globals()[CreateKeySubcommand[sub2cmd].names[0]](**kwargs)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    add_parser_args(parser)
    main(**vars(parser.parse_args()))
