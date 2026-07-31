#!/usr/bin/env node
// Fails the build if a tour anchor has no matching `data-tour` attribute in the
// source — catches an anchor being renamed or a UI element deleting its
// attribute before it surfaces as a broken tour in production.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const anchorsFile = readFileSync(join(SRC, 'tours', 'anchors.ts'), 'utf8');
const anchors = [...anchorsFile.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => ({
  key: m[1],
  value: m[2],
}));
if (anchors.length === 0) {
  console.error('check-tour-anchors: no anchors parsed from tours/anchors.ts');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const sources = walk(SRC)
  .filter((p) => !p.includes(join('tours', 'anchors.ts')))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

// An element carries an anchor as data-tour="literal" or, when the central const
// is used, data-tour={TourAnchors.Key}. A shared component may instead take the
// value as a prop and forward it onto the attribute (`data-tour={dataTour}` in
// PanelTabs), so treat every such forwarding prop — transitively — as another
// spelling that places an anchor. Forwarding via `{...rest}` spread is invisible
// here: a component that re-spreads props onto data-tour must name the prop.
const attrs = new Set(['data-tour']);
for (let grew = true; grew; ) {
  grew = false;
  for (const attr of [...attrs]) {
    for (const [, prop] of sources.matchAll(new RegExp(`(?<![\\w-])${attr}=\\{(\\w+)\\}`, 'g'))) {
      if (!attrs.has(prop)) {
        attrs.add(prop);
        grew = true;
      }
    }
  }
}

const placed = ({ key, value }) =>
  [...attrs].some((attr) =>
    new RegExp(`(?<![\\w-])${attr}=(?:"${value}"|\\{TourAnchors\\.${key}\\})`).test(sources),
  );

const orphans = anchors.filter((a) => !placed(a));

if (orphans.length > 0) {
  console.error('check-tour-anchors: anchors with no matching data-tour attribute:');
  for (const o of orphans) console.error(`  - ${o.key} ("${o.value}")`);
  console.error(
    `\nChecked ${relative(process.cwd(), SRC)} for each anchor as ` +
      `${[...attrs].map((a) => `${a}=…`).join(' / ')}.`,
  );
  process.exit(1);
}

console.log(`check-tour-anchors: all ${anchors.length} tour anchors are placed.`);
