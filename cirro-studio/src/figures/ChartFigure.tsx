// A chart figure drawn from the result it was saved over: a volcano from a comparison,
// a heatmap from neighborhood enrichment.
import { useEffect, useRef, useState } from 'react';
import type { AsyncReadable } from '@zarrita/storage';
import { Heatmap } from '../charts/Heatmap';
import { Volcano } from '../charts/Volcano';
import { describeError } from '../cirro/session';
import { useSize } from '../lib/useSize';
import { GENE_TEST_COLUMN, readDataFrame, type DataFrame } from '../reports/store';
import type { ChartSpec, FigureSpec } from './spec';

const num = (df: DataFrame, column: string) => {
  const c = df.columns[column];
  if (!c || Array.isArray(c)) throw new Error(`The result has no numeric column “${column}”.`);
  return c as ArrayLike<number>;
};

function Chart({ chart, df, width }: { chart: ChartSpec; df: DataFrame; width: number }) {
  if (chart.type === 'volcano') {
    const logfc = num(df, GENE_TEST_COLUMN.logfc);
    const padj = num(df, GENE_TEST_COLUMN.padj);
    const score = num(df, GENE_TEST_COLUMN.score);
    const points = df.index.map((gene, i) => ({ gene, logfc: logfc[i], padj: padj[i], score: score[i] }));
    return <Volcano points={points} cutoffs={chart} width={width} height={Math.round(width * 0.72)} />;
  }
  if (chart.type === 'heatmap') {
    // A square table of groups against the same groups (neighborhood enrichment) names
    // its columns by its index, and draws them in the index's order: `Object.keys` puts
    // integer-like names first, in numeric order, so '0', '1', '10', '2' would not match
    // the rows.
    const names = Object.keys(df.columns);
    const square = names.length === df.index.length && df.index.every((r) => Object.hasOwn(df.columns, r));
    const columns = square ? df.index : names;
    const values = new Float64Array(df.index.length * columns.length);
    columns.forEach((c, j) => {
      const column = num(df, c);
      df.index.forEach((_, i) => { values[i * columns.length + j] = column[i]; });
    });
    // Shares (a niche's mix) have nothing below zero to diverge from.
    return <Heatmap rows={df.index} columns={columns} values={values} width={width} label="Heatmap" diverging={values.some((v) => v < 0)} />;
  }
  // readFigures doesn't check the chart type, so a figure saved by a newer version can
  // name one this version doesn't draw.
  return <p className="muted">This figure's chart type isn't drawn by this version of the app.</p>;
}

export function ChartFigure({ spec, store, table }: { spec: FigureSpec; store: Required<AsyncReadable>; table: string }) {
  const [df, setDf] = useState<DataFrame | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useSize(ref);
  const chart = spec.view.kind === 'chart' ? spec.view.chart : null;
  const resultPath = chart?.result ?? null;
  useEffect(() => {
    if (!resultPath) return;
    let live = true;
    readDataFrame(store, table, resultPath).then((d) => live && setDf(d), (e: unknown) => live && setProblem(describeError(e)));
    return () => {
      live = false;
    };
  }, [store, table, resultPath]);
  return (
    <div className="chart-figure" ref={ref}>
      <h2>{spec.title}</h2>
      {spec.caption && <p className="muted">{spec.caption}</p>}
      {problem && <p className="notice notice-danger">{problem}</p>}
      {chart && df && width > 0 && <Chart chart={chart} df={df} width={Math.min(width, 720)} />}
    </div>
  );
}
