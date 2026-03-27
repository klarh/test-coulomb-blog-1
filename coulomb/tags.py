"""Extract and manage tags from post text.

Supports typed tags with a pluggable syntax:
  - ``#hashtag`` or ``#hyphenated-tag`` → type='hashtag'
  - Future: ``@mention`` → type='mention'

Tags are stored lowercase.  Hyphens are preserved in storage but
converted to spaces for display.
"""

import re

# Matches #word or #hyphenated-words.  Must be preceded by whitespace or
# start-of-string.  The tag body is one or more alphanumeric/hyphen/underscore
# segments, but cannot start or end with a hyphen.
_HASHTAG_RE = re.compile(
    r'(?:^|(?<=\s))#([\w][\w-]*[\w]|[\w])',
    re.UNICODE,
)


def extract_hashtags(text):
    """Return a list of unique hashtag values found in *text* (lowercase)."""
    seen = set()
    tags = []
    for m in _HASHTAG_RE.finditer(text):
        value = m.group(1).lower()
        if value not in seen:
            seen.add(value)
            tags.append(value)
    return tags


def extract_tags(text):
    """Return a list of ``{type, value}`` dicts for all tags in *text*.

    Currently only hashtags are extracted.  The architecture supports
    additional types (mention, topic, …) by extending this function.
    """
    tags = []
    for value in extract_hashtags(text):
        tags.append({'type': 'hashtag', 'value': value})
    return tags


def display_tag(value):
    """Format a tag value for display (hyphens → spaces)."""
    return value.replace('-', ' ')
