import { describe, expect, it } from 'vitest';
import { handleRequest, ops, type AnalysisMessage, type AnalysisRequest } from './ops';
import { silent } from './progress';
import { adjustedRandIndex, simulatedTypes } from './testData';

function collect(request: AnalysisRequest) {
  const messages: { message: AnalysisMessage; transfer: Transferable[] }[] = [];
  handleRequest(request, (message, transfer) => messages.push({ message, transfer }));
  return messages;
}

describe('analysis ops', () => {
  it('clusters simulated cell types end to end, log-normalizing counts first', () => {
    const { matrix, types } = simulatedTypes(5, 1500, 150, 10, 1);
    const result = ops.cluster({ matrix, nComps: 20 }, silent);
    expect(result.normalized).toBe(true);
    expect(result.nComps).toBe(20);
    expect(result.pca).toHaveLength(1500 * 20);
    expect(result.genes).toHaveLength(150);
    expect(adjustedRandIndex(result.labels, types)).toBeGreaterThan(0.9);
    expect(result.nClusters).toBe(new Set(result.labels).size);
  });

  it('finds niches from neighbourhood make-up and leaves cells with no labelled neighbours out', () => {
    // Left half: types 0 and 1 interleaved; right half: type 2 only; one far, unlabelled cell.
    const side = 30;
    const n = side * side + 1;
    const xy = new Float32Array(2 * n);
    const codes = new Int32Array(n);
    for (let i = 0; i < side * side; i++) {
      const x = i % side;
      xy[2 * i] = x;
      xy[2 * i + 1] = Math.floor(i / side);
      codes[i] = x < side / 2 ? i % 2 : 2;
    }
    xy[2 * (n - 1)] = 1e4;
    xy[2 * (n - 1) + 1] = 1e4;
    codes[n - 1] = -1;
    const { labels, nNiches, profiles } = ops.niches({ codes, nCategories: 3, xy, k: 10, nNiches: 2, seed: 0 }, silent);
    expect(nNiches).toBe(2);
    // The far cell's neighbours are labelled, so it still gets a niche.
    expect(labels[n - 1]).toBeGreaterThanOrEqual(0);
    const leftNiche = labels[side * 5 + 2];
    const rightNiche = labels[side * 5 + side - 3];
    expect(leftNiche).not.toBe(rightNiche);
    expect(profiles[rightNiche * 3 + 2]).toBeGreaterThan(0.9);
    expect(profiles[leftNiche * 3 + 0] + profiles[leftNiche * 3 + 1]).toBeGreaterThan(0.9);
  });

  it('marks a cell whose whole neighbourhood is unlabelled with niche -1', () => {
    const xy = Float32Array.from([0, 0, 1, 0, 2, 0, 100, 0, 101, 0]);
    const codes = Int32Array.from([0, 1, 0, -1, -1]);
    const { labels } = ops.niches({ codes, nCategories: 2, xy, k: 1, nNiches: 1 }, silent);
    expect(Array.from(labels)).toEqual([0, 0, 0, -1, -1]);
  });

  it('posts throttled progress, then the result with its buffers listed for transfer', () => {
    const { matrix } = simulatedTypes(3, 300, 60, 10, 2);
    const messages = collect({ op: 'markersForAll', args: { matrix, codes: Int32Array.from({ length: 300 }, (_, c) => c % 3), nGroups: 3 } });
    const progress = messages.filter((m) => 'progress' in m.message);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThan(30);
    const last = messages.at(-1)!;
    expect('result' in last.message).toBe(true);
    expect(last.transfer).toEqual([]);

    const knn = collect({ op: 'spatialKnn', args: { xy: Float32Array.from([0, 0, 1, 0, 0, 2]), k: 1 } }).at(-1)!;
    expect(knn.message).toEqual({ result: Int32Array.from([1, 0, 0]) });
    expect(knn.transfer).toHaveLength(1);
  });

  it('reports a failure as an error message', () => {
    const { matrix } = simulatedTypes(2, 20, 10, 5, 3);
    const [message] = collect({ op: 'markersForAll', args: { matrix, codes: new Int32Array(5), nGroups: 2 } }).map((m) => m.message);
    expect(message).toEqual({ error: 'expected 20 group codes, got 5' });
  });
});
