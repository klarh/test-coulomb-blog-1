import argparse
import collections


class SubcommandHandler:
    SubcommandInfo = collections.namedtuple(
        'SubcommandInfo', ['names', 'arg_function', 'help']
    )

    def __init__(self):
        self.subcommands = {}
        self.key_map = {}

    def register_subcommand(self, *names, help=None):
        names = tuple(names)

        def decorator(f):
            cmd_info = self.SubcommandInfo(names, f, help)
            for name in names:
                self.key_map[name] = names
            self.subcommands[names] = cmd_info
            return f

        return decorator

    def __getitem__(self, key):
        if isinstance(key, str):
            key = self.key_map[key]
        return self.subcommands[key]


DEFAULT_HANDLER = SubcommandHandler()

register_subcommand = DEFAULT_HANDLER.register_subcommand


class CommonArgs:
    @classmethod
    def add(cls, parser, *arg_names):
        callables = []
        for name in arg_names:
            try:
                callables.append(getattr(cls, name))
            except AttributeError:
                raise ValueError('Unknown common arg {}'.format(name))

        for c in callables:
            c(parser)

    change_log = lambda p: p.add_argument(
        '-c', '--change-log', help='Changelog file to append to'
    )
    identity = lambda p: p.add_argument('identity', help='Root of identity directory')
    private = lambda p: p.add_argument('private', help='Root of private directory')
    public = lambda p: p.add_argument('public', help='Root of public directory')
    signatures = lambda p: p.add_argument(
        '-s', '--signatures', nargs='*', default=[], help='Keys to use to sign'
    )
