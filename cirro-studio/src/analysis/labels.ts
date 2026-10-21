/** Renumbers cluster labels so 0 is the largest cluster, 1 the next, and so on; empty
 * labels are dropped and negative labels (unassigned) are kept as they are. */
export function relabelBySize(labels: Int32Array): Int32Array {
  const span = labelCount(labels);
  const sizes = new Float64Array(span);
  for (const label of labels) if (label >= 0) sizes[label]++;
  const order = Array.from({ length: span }, (_, i) => i)
    .filter((label) => sizes[label] > 0)
    .sort((a, b) => sizes[b] - sizes[a] || a - b);
  const rename = new Int32Array(span);
  order.forEach((label, rank) => {
    rename[label] = rank;
  });
  return labels.map((label) => (label >= 0 ? rename[label] : label));
}

/** One more than the largest label: the cluster count of labels numbered 0..k-1. */
export function labelCount(labels: Int32Array): number {
  let max = -1;
  for (const label of labels) if (label > max) max = label;
  return max + 1;
}
