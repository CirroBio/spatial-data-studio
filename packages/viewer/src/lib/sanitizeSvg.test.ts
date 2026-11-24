// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from './sanitizeSvg';

// The shape of what matplotlib's SVG backend writes: a doctype, RDF metadata, a CDATA-free
// style block, clip paths and glyphs in <defs> referenced by local id, a hatch pattern,
// an embedded raster, and Gouraud shading's gradient + filter.
const MATPLOTLIB = `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"
  "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="648pt" height="216pt" viewBox="0 0 648 216" xmlns="http://www.w3.org/2000/svg" version="1.1">
 <metadata>
  <rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
   <cc:Work>
    <dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/>
    <dc:creator><cc:Agent><dc:title>Matplotlib v3.11.0, https://matplotlib.org/</dc:title></cc:Agent></dc:creator>
   </cc:Work>
  </rdf:RDF>
 </metadata>
 <defs>
  <style type="text/css">*{stroke-linejoin: round; stroke-linecap: butt}</style>
 </defs>
 <g id="figure_1">
  <g id="patch_1">
   <path d="M 0 216 L 648 216 L 648 0 L 0 0 z" style="fill: #ffffff"/>
  </g>
  <g clip-path="url(#p1a2b)">
   <image xlink:href="data:image/png;base64,iVBORw0KGgo=" id="image1" transform="scale(1 -1)" x="10" y="-5" width="4" height="4"/>
   <path d="M 1 1 L 2 2" style="fill: url(#h9f); stroke: #1f77b4; stroke-width: 1.5"/>
   <g filter="url(#colorMat)"><path d="M 0 0 L 1 1 L 1 0 z" fill="url(#GRd0)" shape-rendering="crispEdges"/></g>
  </g>
  <g id="text_1">
   <defs><path id="DejaVuSans-30" d="M 2034 4250 z" transform="scale(0.015625)"/></defs>
   <use xlink:href="#DejaVuSans-30"/>
   <text x="5" y="5" style="font: 10px 'DejaVu Sans'"><tspan>axis</tspan></text>
  </g>
 </g>
 <defs>
  <clipPath id="p1a2b"><rect x="81" y="26" width="140" height="166"/></clipPath>
  <pattern id="h9f" patternUnits="userSpaceOnUse" x="0" y="0" width="72" height="72"><rect x="0" y="0" width="73" height="73" fill="#1f77b4"/></pattern>
  <linearGradient id="GRd0" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="1"><stop offset="1" stop-color="#440154"/></linearGradient>
  <filter id="colorMat"><feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 1 1 1 1 0"/></filter>
 </defs>
</svg>`;

const parse = (text: string) => new DOMParser().parseFromString(text, 'image/svg+xml');
// Every element with its attributes, in document order — what the figure draws with.
const drawn = (text: string) => Array.from(parse(text).getElementsByTagName('*'), (element) =>
  [element.tagName, ...Array.from(element.attributes, (a) => `${a.name}=${a.value}`).sort()].join(' '));

describe('sanitizeSvg', () => {
  it('leaves a matplotlib figure as it was drawn', () => {
    const cleaned = sanitizeSvg(MATPLOTLIB);
    expect(drawn(cleaned)).toEqual(drawn(MATPLOTLIB));
    expect(cleaned).toContain('*{stroke-linejoin: round; stroke-linecap: butt}');
    expect(cleaned).toContain('Matplotlib v3.11.0');
    expect(cleaned).not.toContain('<!DOCTYPE');
  });

  it('removes what could run script or reach outside the file', () => {
    const cleaned = sanitizeSvg(`<?xml version="1.0"?>
<?xml-stylesheet type="text/xsl" href="https://evil.example/x.xsl"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:h="http://www.w3.org/1999/xhtml" onload="alert(1)" viewBox="0 0 10 10">
 <script>alert(document.cookie)</script>
 <script xlink:href="https://evil.example/x.js"/>
 <h:script>alert(2)</h:script>
 <metadata><h:iframe src="https://evil.example/"/><h:script>alert(3)</h:script></metadata>
 <foreignObject><h:body><h:img src="x" onerror="alert(4)"/></h:body></foreignObject>
 <?xml-stylesheet href="https://evil.example/y.css"?>
 <style>@import url(https://evil.example/z.css);</style>
 <a href="javascript:alert(5)" id="js-link"><rect id="kept" width="5" height="5" onclick="alert(6)" OnMouseOver="alert(7)"/></a>
 <a xlink:href="https://evil.example/" id="out-link"><circle r="1"/></a>
 <use xlink:href="https://evil.example/sprite.svg#a" id="out-use"/>
 <image href="https://evil.example/pixel.png" id="out-image"/>
 <image href="data:image/svg+xml;base64,PHN2Zy8+" id="svg-image"/>
 <rect id="css" style="fill: url(https://evil.example/paint)" width="1" height="1"/>
 <set attributeName="href" to="javascript:alert(8)"/>
 <animate xlink:href="#js-link" attributeName="href" values="javascript:alert(9)"/>
 <unknownFutureElement/>
</svg>`);

    for (const gone of ['script', 'alert', 'evil.example', 'javascript:', 'foreignObject', 'iframe',
      'xml-stylesheet', '@import', 'onload', 'onclick', 'OnMouseOver', 'animate', '<set',
      'unknownFutureElement', 'data:image/svg']) {
      expect(cleaned).not.toContain(gone);
    }
    const document = parse(cleaned);
    // What was only mislinked stays in the drawing, without the link.
    for (const id of ['js-link', 'kept', 'out-link', 'out-use', 'out-image', 'svg-image', 'css']) {
      const element = document.getElementById(id);
      expect(element, id).not.toBeNull();
      expect(element?.getAttribute('href'), id).toBeNull();
      expect(element?.getAttribute('xlink:href'), id).toBeNull();
    }
    expect(document.getElementById('kept')?.getAttribute('width')).toBe('5');
    expect(document.getElementById('css')?.getAttribute('style')).toBeNull();
  });

  it('judges a CSS address by where it points, however it is spelled', () => {
    const cleaned = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg">
 <style id="escaped-url">svg{background-image:\\75 rl(https://evil.example/a.png)}</style>
 <style id="escaped-import">@\\69mport 'https://evil.example/a.css';</style>
 <rect id="image-set" style="background-image:image-set('https://evil.example/a.png' 1x)"/>
 <rect id="quoted" clip-path='url("#c")' fill="url( #g)"/>
</svg>`);
    expect(cleaned).not.toContain('evil.example');
    const document = parse(cleaned);
    expect(document.getElementById('escaped-url')).toBeNull();
    expect(document.getElementById('escaped-import')).toBeNull();
    expect(document.getElementById('image-set')?.getAttribute('style')).toBeNull();
    expect(document.getElementById('quoted')?.getAttribute('clip-path')).toBe('url("#c")');
    expect(document.getElementById('quoted')?.getAttribute('fill')).toBe('url( #g)');
  });

  it('refuses what is not an SVG document', () => {
    expect(() => sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>')).toThrow(/not a well-formed SVG/);
    expect(() => sanitizeSvg('<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'))
      .toThrow(/not a well-formed SVG/);
    expect(() => sanitizeSvg('<svg><script>alert(1)</script></svg>')).toThrow(/not a well-formed SVG/);
  });
});
