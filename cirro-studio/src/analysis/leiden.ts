// Leiden community detection (Traag, Waltman & van Eck 2019, "From Louvain to Leiden:
// guaranteeing well-connected communities"), maximising modularity with a resolution
// parameter (the RB configuration model). Ported from the authors' reference
// implementation (CWTS networkanalysis: FastLocalMovingAlgorithm, LocalMergingAlgorithm,
// LeidenAlgorithm), where modularity is CPM with node weight = strength and resolution
// γ / 2m.
import { relabelBySize } from './labels';
import { silent, type Progress } from './progress';
import { mulberry32, shuffle, type Random } from './random';

/** A symmetric weighted graph as CSR: node i's neighbours are
 * indices[indptr[i]..indptr[i+1]] with the matching weights. No self-loops. */
export interface WeightedGraph {
  indptr: Int32Array;
  indices: Int32Array;
  weights: Float64Array;
}

export interface LeidenOptions {
  resolution?: number;
  seed?: number;
  // θ in the refinement step's random merge; 0.01 as in leidenalg and igraph.
  randomness?: number;
}

interface Network {
  nNodes: number;
  indptr: Int32Array;
  neighbors: Int32Array;
  weights: Float64Array;
  nodeWeight: Float64Array;
}

interface Clustering {
  clusters: Int32Array;
  nClusters: number;
}

// Iterations repeat until nothing moves; the cap only guards against floating-point ties
// letting two moves undo each other forever.
const MAX_ITERATIONS = 50;

/** Community labels for every node, renumbered so community 0 is the largest. */
export function leiden(graph: WeightedGraph, options: LeidenOptions = {}, progress: Progress = silent): Int32Array {
  const { resolution = 1, seed = 0, randomness = 0.01 } = options;
  const n = graph.indptr.length - 1;
  const nodeWeight = new Float64Array(n);
  let totalWeight = 0;
  for (let v = 0; v < n; v++) {
    for (let e = graph.indptr[v]; e < graph.indptr[v + 1]; e++) nodeWeight[v] += graph.weights[e];
    totalWeight += nodeWeight[v];
  }
  const clustering: Clustering = { clusters: Int32Array.from({ length: n }, (_, v) => v), nClusters: n };
  if (totalWeight === 0) return relabelBySize(clustering.clusters);
  const network: Network = { nNodes: n, indptr: graph.indptr, neighbors: graph.indices, weights: graph.weights, nodeWeight };
  const gamma = resolution / totalWeight;
  const random = mulberry32(seed);
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const moved = improve(network, clustering, gamma, randomness, random);
    progress(1 - 0.5 ** (iteration + 1), `Leiden iteration ${iteration + 1}: ${clustering.nClusters} communities`);
    if (!moved) break;
  }
  progress(1, `Leiden: ${clustering.nClusters} communities`);
  return relabelBySize(clustering.clusters);
}

/** One Leiden iteration on `network`, starting from and updating `clustering`. */
function improve(network: Network, clustering: Clustering, gamma: number, randomness: number, random: Random): boolean {
  let moved = moveNodesFast(network, clustering, gamma, random);
  if (clustering.nClusters === network.nNodes) return moved;
  let refinement = refine(network, clustering, gamma, randomness, random);
  // When refinement merges nothing, aggregating by it would not shrink the network;
  // aggregate by the clustering itself instead, as igraph does.
  if (refinement.nClusters === network.nNodes) refinement = { clusters: Int32Array.from(clustering.clusters), nClusters: clustering.nClusters };
  const reduced = aggregate(network, refinement);
  const reducedClustering: Clustering = { clusters: new Int32Array(refinement.nClusters), nClusters: clustering.nClusters };
  for (let v = 0; v < network.nNodes; v++) reducedClustering.clusters[refinement.clusters[v]] = clustering.clusters[v];
  moved = improve(reduced, reducedClustering, gamma, randomness, random) || moved;
  for (let v = 0; v < network.nNodes; v++) clustering.clusters[v] = reducedClustering.clusters[refinement.clusters[v]];
  clustering.nClusters = reducedClustering.nClusters;
  return moved;
}

function randomOrder(n: number, random: Random): Int32Array {
  const order = Int32Array.from({ length: n }, (_, i) => i);
  shuffle(order, random);
  return order;
}

function maxDegree(network: Network): number {
  let max = 0;
  for (let v = 0; v < network.nNodes; v++) max = Math.max(max, network.indptr[v + 1] - network.indptr[v]);
  return max;
}

/** Renumbers clusters 0..k-1 in order of their old ids and returns k. */
function removeEmptyClusters(clusters: Int32Array): number {
  let max = -1;
  for (const c of clusters) if (c > max) max = c;
  const rename = new Int32Array(max + 1).fill(-1);
  for (const c of clusters) rename[c] = 0;
  let next = 0;
  for (let c = 0; c <= max; c++) if (rename[c] === 0) rename[c] = next++;
  for (let v = 0; v < clusters.length; v++) clusters[v] = rename[clusters[v]];
  return next;
}

/** Local moving with a queue: each node goes to the neighbouring (or an empty) cluster
 * with the largest quality gain; neighbours of a moved node are revisited. */
function moveNodesFast(network: Network, clustering: Clustering, gamma: number, random: Random): boolean {
  const { nNodes: n, indptr, neighbors, weights, nodeWeight } = network;
  const { clusters } = clustering;
  const clusterWeight = new Float64Array(n);
  const clusterSize = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    clusterWeight[clusters[v]] += nodeWeight[v];
    clusterSize[clusters[v]]++;
  }
  const unused = new Int32Array(n);
  let nUnused = 0;
  for (let c = n - 1; c >= 0; c--) if (clusterSize[c] === 0) unused[nUnused++] = c;

  const order = randomOrder(n, random);
  const edgeWeightTo = new Float64Array(n);
  const candidates = new Int32Array(maxDegree(network) + 1);
  const stable = new Uint8Array(n);
  let nUnstable = n;
  let i = 0;
  let moved = false;
  do {
    const v = order[i];
    const current = clusters[v];
    clusterWeight[current] -= nodeWeight[v];
    clusterSize[current]--;
    if (clusterSize[current] === 0) unused[nUnused++] = current;

    // Candidates: an empty cluster plus every cluster v has an edge into.
    candidates[0] = unused[nUnused - 1];
    let nCandidates = 1;
    for (let e = indptr[v]; e < indptr[v + 1]; e++) {
      const c = clusters[neighbors[e]];
      if (edgeWeightTo[c] === 0) candidates[nCandidates++] = c;
      edgeWeightTo[c] += weights[e];
    }
    // Ties keep the node where it was, which guarantees convergence.
    let best = current;
    let bestGain = edgeWeightTo[current] - nodeWeight[v] * clusterWeight[current] * gamma;
    for (let t = 0; t < nCandidates; t++) {
      const c = candidates[t];
      const gain = edgeWeightTo[c] - nodeWeight[v] * clusterWeight[c] * gamma;
      if (gain > bestGain) {
        best = c;
        bestGain = gain;
      }
      edgeWeightTo[c] = 0;
    }

    clusterWeight[best] += nodeWeight[v];
    clusterSize[best]++;
    if (best === unused[nUnused - 1]) nUnused--;
    stable[v] = 1;
    nUnstable--;
    if (best !== current) {
      clusters[v] = best;
      for (let e = indptr[v]; e < indptr[v + 1]; e++) {
        const u = neighbors[e];
        if (stable[u] && clusters[u] !== best) {
          stable[u] = 0;
          nUnstable++;
          order[(i + nUnstable) % n] = u;
        }
      }
      moved = true;
    }
    i = i + 1 < n ? i + 1 : 0;
  } while (nUnstable > 0);
  clustering.nClusters = removeEmptyClusters(clusters);
  return moved;
}

/** The refinement step: within each cluster, singletons merge into well-connected
 * sub-clusters, choosing among positive-gain options at random with probability
 * ∝ exp(gain / θ). Sub-clusters never cross cluster boundaries. */
function refine(network: Network, clustering: Clustering, gamma: number, randomness: number, random: Random): Clustering {
  const { nNodes: n, indptr, neighbors, weights, nodeWeight } = network;
  const { clusters } = clustering;
  const refined = Int32Array.from({ length: n }, (_, v) => v);
  const coarseWeight = new Float64Array(clustering.nClusters);
  for (let v = 0; v < n; v++) coarseWeight[clusters[v]] += nodeWeight[v];
  const refinedWeight = Float64Array.from(nodeWeight);
  // Weight of edges from each sub-cluster to the rest of its cluster.
  const external = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    for (let e = indptr[v]; e < indptr[v + 1]; e++) if (clusters[neighbors[e]] === clusters[v]) external[v] += weights[e];
  }
  const nonSingleton = new Uint8Array(n);
  const edgeWeightTo = new Float64Array(n);
  const candidates = new Int32Array(maxDegree(network) + 1);
  const cumulative = new Float64Array(candidates.length);
  const order = randomOrder(n, random);
  for (const v of order) {
    const coarse = clusters[v];
    const total = coarseWeight[coarse];
    if (nonSingleton[v] || external[v] < refinedWeight[v] * (total - refinedWeight[v]) * gamma) continue;
    refinedWeight[v] = 0;
    external[v] = 0;

    candidates[0] = v;
    let nCandidates = 1;
    for (let e = indptr[v]; e < indptr[v + 1]; e++) {
      const u = neighbors[e];
      if (clusters[u] !== coarse) continue;
      const c = refined[u];
      if (edgeWeightTo[c] === 0) candidates[nCandidates++] = c;
      edgeWeightTo[c] += weights[e];
    }
    let best = v;
    let bestGain = 0;
    let totalTransformed = 0;
    for (let t = 0; t < nCandidates; t++) {
      const c = candidates[t];
      if (external[c] >= refinedWeight[c] * (total - refinedWeight[c]) * gamma) {
        const gain = edgeWeightTo[c] - nodeWeight[v] * refinedWeight[c] * gamma;
        if (gain > bestGain) {
          best = c;
          bestGain = gain;
        }
        if (gain >= 0) totalTransformed += Math.exp(gain / randomness);
      }
      cumulative[t] = totalTransformed;
      edgeWeightTo[c] = 0;
    }
    let chosen = best;
    // exp overflows for large gains; the reference implementation then takes the best.
    if (totalTransformed < Infinity) {
      const r = totalTransformed * random();
      let lo = 0;
      let hi = nCandidates - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cumulative[mid] >= r) hi = mid;
        else lo = mid + 1;
      }
      chosen = candidates[lo];
    }

    refinedWeight[chosen] += nodeWeight[v];
    for (let e = indptr[v]; e < indptr[v + 1]; e++) {
      const u = neighbors[e];
      if (clusters[u] !== coarse) continue;
      external[chosen] += refined[u] === chosen ? -weights[e] : weights[e];
    }
    if (chosen !== v) {
      refined[v] = chosen;
      nonSingleton[chosen] = 1;
    }
  }
  return { clusters: refined, nClusters: removeEmptyClusters(refined) };
}

/** The network whose nodes are the clusters of `clustering`, with summed node weights
 * and summed edge weights between clusters; edges inside a cluster are dropped. */
function aggregate(network: Network, clustering: Clustering): Network {
  const { nNodes: n, indptr, neighbors, weights, nodeWeight } = network;
  const { clusters, nClusters } = clustering;
  const start = new Int32Array(nClusters + 1);
  for (let v = 0; v < n; v++) start[clusters[v] + 1]++;
  for (let c = 0; c < nClusters; c++) start[c + 1] += start[c];
  const members = new Int32Array(n);
  const fill = start.slice(0, nClusters);
  for (let v = 0; v < n; v++) members[fill[clusters[v]]++] = v;

  const reducedWeight = new Float64Array(nClusters);
  const reducedIndptr = new Int32Array(nClusters + 1);
  const reducedNeighbors = new Int32Array(neighbors.length);
  const reducedWeights = new Float64Array(neighbors.length);
  const seenBy = new Int32Array(nClusters).fill(-1);
  const slot = new Int32Array(nClusters);
  let edges = 0;
  for (let c = 0; c < nClusters; c++) {
    for (let m = start[c]; m < start[c + 1]; m++) {
      const v = members[m];
      reducedWeight[c] += nodeWeight[v];
      for (let e = indptr[v]; e < indptr[v + 1]; e++) {
        const d = clusters[neighbors[e]];
        if (d === c) continue;
        if (seenBy[d] !== c) {
          seenBy[d] = c;
          slot[d] = edges;
          reducedNeighbors[edges] = d;
          reducedWeights[edges] = 0;
          edges++;
        }
        reducedWeights[slot[d]] += weights[e];
      }
    }
    reducedIndptr[c + 1] = edges;
  }
  return {
    nNodes: nClusters,
    indptr: reducedIndptr,
    neighbors: reducedNeighbors.slice(0, edges),
    weights: reducedWeights.slice(0, edges),
    nodeWeight: reducedWeight,
  };
}
