import collections
import datetime
import os

UTC = datetime.timezone.utc


class TimeArchive:
    PathResult = collections.namedtuple(
        'PathResult', ['path', 'subdirectory', 'filename', 'id', 'timestamp']
    )

    ENTRY_FORMAT = 'entry.{id}.cbor'
    PREFIX = None
    SUBDIR_FORMAT = '%Y/%m%d/%H%M'
    ID_FORMAT = '%Y%m%d%H%M%S%f'

    def __init__(
        self,
        entry_format=None,
        prefix=None,
        user_id=None,
        subdir_format=None,
        id_format=None,
    ):
        self.entry_format = entry_format or self.ENTRY_FORMAT
        self.prefix = prefix if prefix is not None else self.PREFIX
        self.user_id = user_id
        self.subdir_format = subdir_format or self.SUBDIR_FORMAT
        self.id_format = id_format or self.ID_FORMAT

        prefix_bits = [self.prefix, self.user_id]
        self.prefix_components = [v for v in prefix_bits if v]
        self.prefix_subdir = '/'.join(self.prefix_components) or None

    def get_path(self, timestamp=None):
        if timestamp is None:
            timestamp = datetime.datetime.now(UTC)
        else:
            timestamp = timestamp.astimezone(UTC)

        subdir = timestamp.strftime(self.subdir_format)
        if self.prefix_subdir:
            subdir = os.path.join(self.prefix_subdir, subdir)

        identity = timestamp.strftime(self.id_format)
        fname = self.entry_format.format(id=identity)

        relpath = os.path.join(subdir, fname)
        return self.PathResult(relpath, subdir, fname, identity, timestamp)


class UserPostArchive(TimeArchive):
    ENTRY_FORMAT = 'post.{id}.cbor'
    PREFIX = 'posts'


class IdentityArchive(TimeArchive):
    ENTRY_FORMAT = 'identity.{id}.cbor'
    PREFIX = 'identity'


class ConfigArchive(TimeArchive):
    ENTRY_FORMAT = 'config.{id}.cbor'
    PREFIX = 'config'
