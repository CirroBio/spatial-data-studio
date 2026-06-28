import type { CSSProperties, ReactNode } from 'react';

// squidpy/scanpy logging and rich emit ANSI SGR codes; render them as styled
// spans rather than showing raw escape sequences. Non-color escape sequences
// (cursor moves, tqdm line clears) and stray carriage returns are dropped.

const STD: Record<number, string> = {
  30: '#5c6370', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b',
  34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#abb2bf',
  90: '#7f848e', 91: '#ff7b72', 92: '#b5e890', 93: '#f2c26b',
  94: '#79c0ff', 95: '#d2a8ff', 96: '#76d3da', 97: '#ffffff',
};

function xterm256(n: number): string {
  if (n < 16) return STD[n < 8 ? 30 + n : 82 + n] ?? '#abb2bf';
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const conv = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  return `rgb(${conv(Math.floor(i / 36))},${conv(Math.floor((i % 36) / 6))},${conv(i % 6)})`;
}

function applySGR(style: CSSProperties, codes: number[]): CSSProperties {
  let s: CSSProperties = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) s = {};
    else if (c === 1) s.fontWeight = 'bold';
    else if (c === 2) s.opacity = 0.7;
    else if (c === 3) s.fontStyle = 'italic';
    else if (c === 4) s.textDecoration = 'underline';
    else if (c === 22) { delete s.fontWeight; delete s.opacity; }
    else if (c === 23) delete s.fontStyle;
    else if (c === 24) delete s.textDecoration;
    else if (c === 39) delete s.color;
    else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) s.color = STD[c];
    else if (c === 38) {
      if (codes[i + 1] === 5) { s.color = xterm256(codes[i + 2]); i += 2; }
      else if (codes[i + 1] === 2) { s.color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
    }
    // background (40-49, 100-107) and other attributes are ignored
  }
  return s;
}

// ANSI CSI: ESC '[' params letter. Built from an escape string to avoid a literal
// control character in source. SGR ('m') sets style; other CSI codes are dropped.
const CSI = new RegExp('\\u001b\\[([0-9;]*)([A-Za-z])', 'g');

export default function AnsiLog({ text, className }: { text: string; className?: string }) {
  const clean = text.replace(/\r\n/g, '\n').replace(/\r/g, '');
  const nodes: ReactNode[] = [];
  let style: CSSProperties = {};
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  CSI.lastIndex = 0;
  while ((m = CSI.exec(clean)) !== null) {
    if (m.index > last) nodes.push(<span key={key++} style={style}>{clean.slice(last, m.index)}</span>);
    if (m[2] === 'm') {
      const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
      style = applySGR(style, codes);
    }
    last = CSI.lastIndex;
  }
  if (last < clean.length) nodes.push(<span key={key++} style={style}>{clean.slice(last)}</span>);
  return <pre className={className}>{nodes}</pre>;
}
