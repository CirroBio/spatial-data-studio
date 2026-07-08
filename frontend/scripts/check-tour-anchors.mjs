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

// An element carries an anchor as either data-tour="literal" or, when the
// central const is used, data-tour={TourAnchors.Key}.
const sources = walk(SRC)
  .filter((p) => !p.includes(join('tours', 'anchors.ts')))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

const orphans = anchors.filter(
  ({ key, value }) =>
    !sources.includes(`data-tour="${value}"`) &&
    !sources.includes(`data-tour={TourAnchors.${key}}`),
);

if (orphans.length > 0) {
  console.error('check-tour-anchors: anchors with no matching data-tour attribute:');
  for (const o of orphans) console.error(`  - ${o.key} ("${o.value}")`);
  console.error(`\nChecked ${relative(process.cwd(), SRC)} for each anchor.`);
  process.exit(1);
}

console.log(`check-tour-anchors: all ${anchors.length} tour anchors are placed.`);
