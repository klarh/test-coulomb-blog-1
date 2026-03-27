"""Render Markdown text to sanitized HTML.

Used by both the static-site renderer (render.py / Jinja2) and the PWA
bridge (coulomb-bridge.js → Pyodide).  A single rendering path keeps
output identical across CLI and browser.
"""

import re

import markdown as _markdown

# HTML elements allowed in rendered output.
ALLOWED_TAGS = frozenset(
    {
        'p',
        'br',
        'strong',
        'em',
        'del',
        'a',
        'ul',
        'ol',
        'li',
        'code',
        'pre',
        'blockquote',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'hr',
        'img',
        'sup',
        'sub',
    }
)

# Attributes allowed per element.  Everything else is stripped.
ALLOWED_ATTRS = {
    'a': {'href', 'title'},
    'img': {'src', 'alt', 'title'},
    'td': {'align'},
    'th': {'align'},
}

_EXTENSIONS = [
    'tables',
    'fenced_code',
    'sane_lists',
    'smarty',
]

_TAG_RE = re.compile(r'</?\w+[^>]*/?>', re.DOTALL)
_TAG_NAME_RE = re.compile(r'<(/?)(\w+)')
_ATTR_RE = re.compile(
    r'\s([\w-]+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|(\S+))'
)
_DANGEROUS_URL_RE = re.compile(r'^\s*javascript\s*:', re.IGNORECASE)
_URL_ATTRS = {'href', 'src'}


def _sanitize_html(html):
    """Strip tags and attributes not on the allow-lists."""

    def _replace_tag(match):
        full = match.group(0)
        m = _TAG_NAME_RE.match(full)
        if not m:
            return ''
        is_closing = m.group(1) == '/'
        tag = m.group(2).lower()
        if tag not in ALLOWED_TAGS:
            return ''
        if is_closing:
            return '</{}>'.format(tag)
        allowed = ALLOWED_ATTRS.get(tag, set())
        attrs = []
        for am in _ATTR_RE.finditer(full):
            name = am.group(1).lower()
            if name not in allowed:
                continue
            val = am.group(2) or am.group(3) or am.group(4) or ''
            if name in _URL_ATTRS and _DANGEROUS_URL_RE.match(val):
                continue
            attrs.append(' {}="{}"'.format(name, val))
        attr_str = ''.join(attrs)
        if full.rstrip().endswith('/>'):
            return '<{}{} />'.format(tag, attr_str)
        return '<{}{}>'.format(tag, attr_str)

    return _TAG_RE.sub(_replace_tag, html)


def render_markdown(text):
    """Convert *text* from Markdown to sanitised HTML."""
    raw = _markdown.markdown(text, extensions=_EXTENSIONS)
    return _sanitize_html(raw)
