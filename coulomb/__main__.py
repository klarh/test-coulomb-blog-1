import argparse
import importlib

from . import cmd
from . import config
from . import create_key
from . import identity
from . import init
from . import post
from . import pull
from . import rebuild_index
from . import render
from . import verify

parser = argparse.ArgumentParser(description='Invoke a coulomb command')
subparsers = parser.add_subparsers(dest='subcmd', required=True, help='Subcommand')

for names, cmd_info in cmd.DEFAULT_HANDLER.subcommands.items():
    name = names[0]
    subparser = subparsers.add_parser(name, aliases=names[1:], help=cmd_info.help)
    subparser.description = cmd_info.help
    cmd_info.arg_function(subparser)

if __name__ == '__main__':
    args = vars(parser.parse_args())
    subcmd = cmd.DEFAULT_HANDLER[args.pop('subcmd')]
    globals()[subcmd.names[0]].main(**args)
