// An SVG read out of a store somebody else chose is shown from a same-origin blob URL.
// As an <img> it is inert, but the same URL opened as a document ("open image in new
// tab") is a page of this origin, and any script in it would run with the app's
// storage and its Cirro session. So nothing that can run script, or reach outside the
// file, survives the reading.
//
// An allowlist rather than a list of known-bad names: it covers the drawing elements
// matplotlib writes (and the gradients, patterns and filters it uses for shading and
// hatches), and everything else in the SVG namespace — script, foreignObject, the
// animation elements that can rewrite an href, whatever is added to SVG next — goes.

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'a', 'switch',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'image',
  'text', 'tspan', 'textPath',
  'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'stop',
  'filter', 'style', 'title', 'desc', 'metadata',
]);
// The filter primitives (feColorMatrix, feComposite, ...) — matplotlib's Gouraud shading.
const FILTER_PRIMITIVE = /^fe[A-Z][A-Za-z]*$/;

// The only link targets kept: another node of the same file, and — on <image> alone —
// a raster embedded in it. Not `data:image/svg+xml`, which is a second document.
const LOCAL_REFERENCE = /^\s*#/;
const EMBEDDED_RASTER = /^\s*data:image\/(png|jpeg|gif|webp);base64,/i;
// A CSS `url(...)` to anything but a node of the same file, a stylesheet import, or
// `image-set()`, which takes an address as a bare string. A backslash is refused
// outright: CSS escapes can spell any of those (`\75 rl(`), and no figure needs one.
// The lookahead excludes quotes and spaces so that backtracking over the optional
// ones before it cannot make a quoted `url("#id")` look external.
const EXTERNAL_CSS = /\\|image-set\(|@import|url\(\s*['"]?\s*(?![#\s'"])/i;

const PROCESSING_INSTRUCTION = 7;

function isKeptElement(element: Element): boolean {
  if (element.namespaceURI === SVG_NS) {
    return SVG_ELEMENTS.has(element.localName) || FILTER_PRIMITIVE.test(element.localName);
  }
  // The RDF/Dublin Core description matplotlib writes sits in <metadata> in its own
  // namespaces and is never rendered. Anywhere else a foreign element has no business
  // in a figure, and XHTML — where <script> and <iframe> are live — is kept nowhere.
  return element.namespaceURI !== 'http://www.w3.org/1999/xhtml'
    && element.parentElement?.closest('metadata')?.namespaceURI === SVG_NS;
}

function isKeptAttribute(element: Element, attribute: Attr): boolean {
  const name = attribute.localName.toLowerCase();
  if (name.startsWith('on')) return false;
  const isLink = name === 'href' && (attribute.namespaceURI === null || attribute.namespaceURI === XLINK_NS);
  if (isLink) {
    return LOCAL_REFERENCE.test(attribute.value)
      || (element.localName === 'image' && EMBEDDED_RASTER.test(attribute.value));
  }
  // `style`, and the presentation attributes that take a paint server or a clip path.
  return !EXTERNAL_CSS.test(attribute.value);
}

/** `text` with everything that could run script or load a resource from outside the
 * file removed. What a figure draws with is untouched, so one the app saved looks the
 * same after as before. Throws when `text` is not an SVG document at all. */
export function sanitizeSvg(text: string): string {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = parsed.documentElement;
  if (parsed.getElementsByTagName('parsererror').length > 0
      || root.namespaceURI !== SVG_NS || root.localName !== 'svg') {
    throw new Error('The figure is not a well-formed SVG document.');
  }

  // Collected first: removing a node while walking would skip its next sibling. The
  // walk starts on the root itself — `nextNode()` alone would begin at its first
  // descendant and leave the root's own attributes (an `onload`) unread.
  const walker = parsed.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_PROCESSING_INSTRUCTION);
  const dropped: Node[] = [];
  for (let node: Node | null = root; node; node = walker.nextNode()) {
    if (node.nodeType === PROCESSING_INSTRUCTION) {
      dropped.push(node);
      continue;
    }
    const element = node as Element;
    if (!isKeptElement(element)) {
      dropped.push(element);
      continue;
    }
    if (element.localName === 'style' && EXTERNAL_CSS.test(element.textContent ?? '')) {
      dropped.push(element);
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (!isKeptAttribute(element, attribute)) element.removeAttributeNode(attribute);
    }
  }
  for (const node of dropped) node.parentNode?.removeChild(node);

  // Only the root is written back, which leaves behind the doctype (and any entity
  // declarations in it, already expanded by the parse) and whatever precedes the root —
  // an `<?xml-stylesheet?>` there could turn the file into a different document.
  return `<?xml version="1.0" encoding="utf-8"?>\n${new XMLSerializer().serializeToString(root)}`;
}
