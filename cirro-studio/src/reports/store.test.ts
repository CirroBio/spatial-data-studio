import { describe, expect, it } from 'vitest';
import type { GeneTest } from '../analysis/rankGenes';
import { GENE_TEST_COLUMN, geneTestColumns, geneTestsOf } from './store';

const geneTest = (gene: string, n: number): GeneTest => ({
  gene, score: n, logfc: n + 0.1, pval: n + 0.2, padj: n + 0.3, meanA: n + 0.4, meanB: n + 0.5, fracA: n + 0.6, fracB: n + 0.7,
});

describe('geneTestColumns', () => {
  it('stores each statistic under its column name, one row per test in order', () => {
    const columns = geneTestColumns([geneTest('A', 1), geneTest('B', 2)]);
    expect(Object.keys(columns)).toEqual(['score', 'logfoldchange', 'pval', 'pval_adj', 'mean_group', 'mean_reference', 'fraction_group', 'fraction_reference']);
    expect(Array.from(columns[GENE_TEST_COLUMN.score])).toEqual([1, 2]);
    expect(Array.from(columns[GENE_TEST_COLUMN.logfc])).toEqual([1.1, 2.1]);
    expect(Array.from(columns[GENE_TEST_COLUMN.pval])).toEqual([1.2, 2.2]);
    expect(Array.from(columns[GENE_TEST_COLUMN.padj])).toEqual([1.3, 2.3]);
    expect(Array.from(columns[GENE_TEST_COLUMN.meanA])).toEqual([1.4, 2.4]);
    expect(Array.from(columns[GENE_TEST_COLUMN.meanB])).toEqual([1.5, 2.5]);
    expect(Array.from(columns[GENE_TEST_COLUMN.fracA])).toEqual([1.6, 2.6]);
    expect(Array.from(columns[GENE_TEST_COLUMN.fracB])).toEqual([1.7, 2.7]);
  });

  it('reads back as the tests it was made from', () => {
    const tests = [geneTest('A', 1), geneTest('B', 2)];
    expect(geneTestsOf({ index: ['A', 'B'], columns: geneTestColumns(tests) })).toEqual(tests);
  });
});
