import sanitize from 'sanitize-html';

const LINK_RELS: ReadonlySet<string> = new Set([
  'noopener',
  'noreferrer',
  'nofollow',
  'ugc',
]);

// What rich-text editors produce, and nothing that runs: no scripts, event
// handlers, styles, forms, frames, or URLs other than the schemes below.
const OPTIONS: sanitize.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'br',
    'hr',
    'div',
    'span',
    'blockquote',
    'pre',
    'code',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'strike',
    'del',
    'ins',
    'sub',
    'sup',
    'mark',
    'small',
    'abbr',
    'ul',
    'ol',
    'li',
    'a',
    'img',
    'figure',
    'figcaption',
    'table',
    'caption',
    'colgroup',
    'col',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    abbr: ['title'],
    ol: ['start', 'reversed'],
    li: ['value'],
    col: ['span'],
    colgroup: ['span'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
  },
  // Code blocks keep their language, for syntax highlighting.
  allowedClasses: { code: ['language-*'], pre: ['language-*'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowedStyles: {},
  disallowedTagsMode: 'discard',
  transformTags: {
    // Links may open a new tab, from which they cannot reach back into the page.
    a: (tagName, { target, rel, ...attribs }) => {
      const tokens = new Set(
        (rel ?? '').split(/\s+/).filter((token) => LINK_RELS.has(token)),
      );
      if (target === '_blank') tokens.add('noopener').add('noreferrer');
      return {
        tagName,
        attribs: {
          ...attribs,
          ...(target === '_blank' && { target }),
          ...(tokens.size > 0 && { rel: [...tokens].join(' ') }),
        },
      };
    },
  },
};

/** The deepest element nesting accepted, as in Chromium's HTML parser. */
export const MAX_HTML_DEPTH = 512;

const TOO_DEEP = Symbol('too deep');

/**
 * HTML reduced to the rich-text allowlist, safe to render as is, or null when
 * its elements nest deeper than MAX_HTML_DEPTH.
 */
export function sanitizeHtml(html: string): string | null {
  // The parser's cost per tag grows with the open elements, so deep nesting
  // makes parsing quadratic. The hooks see every open and close, implied ones
  // too, so the count tracks the parser's stack and stops it early.
  let depth = 0;
  try {
    return sanitize(html, {
      ...OPTIONS,
      onOpenTag: () => {
        if (++depth > MAX_HTML_DEPTH) throw TOO_DEEP;
      },
      onCloseTag: () => {
        depth--;
      },
    });
  } catch (e) {
    if (e === TOO_DEEP) return null;
    throw e;
  }
}
