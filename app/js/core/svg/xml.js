/**
 * A minimal XML reader.
 *
 * The browser has `DOMParser` and Node does not. Using it would mean the
 * importer behaves one way in production and another under test — the two
 * places where agreement matters most. A small parser of our own runs
 * identically in both, so a test that passes means the browser does the same
 * thing.
 *
 * This handles the subset SVG documents actually use: elements, attributes,
 * self-closing tags, comments, CDATA, processing instructions and doctypes.
 * It is not a general XML processor — no entity definitions, no validation,
 * no namespace resolution beyond stripping prefixes.
 */

/** Node produced for the synthetic document root. */
export const ROOT_TAG = '#document';

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Expand the entity references that appear in attribute values. */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);

      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }

    return NAMED_ENTITIES[body] ?? match;
  });
}

const isNameChar = (ch) => /[^\s/>=]/.test(ch);
const isSpace = (ch) => /\s/.test(ch);

/** Skip a doctype, including an internal subset in square brackets. */
function skipDoctype(src, i) {
  let depth = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '>' && depth <= 0) return i + 1;
    i++;
  }

  return i;
}

/**
 * Read an opening tag starting at `<`.
 *
 * Scans character by character rather than searching for the closing `>`,
 * because an attribute value may legally contain one.
 */
function readTag(src, i) {
  i++; // past '<'

  let name = '';
  while (i < src.length && isNameChar(src[i])) name += src[i++];

  const attrs = {};

  while (i < src.length) {
    while (i < src.length && isSpace(src[i])) i++;

    if (src[i] === '/' && src[i + 1] === '>') {
      return { name, attrs, selfClosing: true, next: i + 2 };
    }
    if (src[i] === '>') {
      return { name, attrs, selfClosing: false, next: i + 1 };
    }
    if (i >= src.length) break;

    let attrName = '';
    while (i < src.length && isNameChar(src[i])) attrName += src[i++];

    // A malformed attribute would otherwise spin here forever.
    if (attrName === '') {
      i++;
      continue;
    }

    while (i < src.length && isSpace(src[i])) i++;

    let value = '';
    if (src[i] === '=') {
      i++;
      while (i < src.length && isSpace(src[i])) i++;

      const quote = src[i];
      if (quote === '"' || quote === "'") {
        i++;
        const end = src.indexOf(quote, i);
        const stop = end === -1 ? src.length : end;
        value = src.slice(i, stop);
        i = stop + 1;
      } else {
        while (i < src.length && !isSpace(src[i]) && src[i] !== '>') {
          value += src[i++];
        }
      }
    }

    attrs[attrName] = decodeEntities(value);
  }

  return { name, attrs, selfClosing: false, next: i };
}

/** Drop a namespace prefix: `svg:rect` and `rect` should behave alike. */
function localName(name) {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function createNode(tag, attrs) {
  return { tag, attrs, children: [], text: '' };
}

/**
 * Parse an XML document into a tree of `{tag, attrs, children, text}`.
 *
 * Unbalanced or stray closing tags are tolerated rather than thrown on: real
 * SVG exports are not always clean, and refusing to draw anything is a worse
 * outcome for the user than importing what is legible.
 */
export function parseXml(source) {
  const root = createNode(ROOT_TAG, {});
  const stack = [root];
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf('<', i);

    if (lt === -1) {
      stack[stack.length - 1].text += source.slice(i);
      break;
    }

    if (lt > i) stack[stack.length - 1].text += source.slice(i, lt);
    i = lt;

    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i);
      i = end === -1 ? source.length : end + 3;
    } else if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i);
      const stop = end === -1 ? source.length : end;
      stack[stack.length - 1].text += source.slice(i + 9, stop);
      i = end === -1 ? source.length : end + 3;
    } else if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i);
      i = end === -1 ? source.length : end + 2;
    } else if (source.startsWith('<!', i)) {
      i = skipDoctype(source, i);
    } else if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i);
      if (stack.length > 1) stack.pop();
      i = end === -1 ? source.length : end + 1;
    } else {
      const { name, attrs, selfClosing, next } = readTag(source, i);
      const node = createNode(localName(name), attrs);

      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
      i = next;
    }
  }

  return root;
}

/** First descendant with the given tag, depth first, or null. */
export function find(node, tag) {
  for (const child of node.children) {
    if (child.tag === tag) return child;
    const found = find(child, tag);
    if (found) return found;
  }
  return null;
}

/** Every descendant, depth first, excluding the node itself. */
export function* descendants(node) {
  for (const child of node.children) {
    yield child;
    yield* descendants(child);
  }
}
