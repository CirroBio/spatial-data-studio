// A chart figure drawn from the result it was saved over: a volcano from a comparison,
// a heatmap from neighborhood enrichment, stacked bars from a composition.
import { useEffect, useRef, useState } from 'react';
import type { AsyncReadable } from '@zarrita/storage';
import { downloadBlob } from '@cirrobio/spatial-viewer';
import { Heatmap } from '../charts/Heatmap';
import { StackedBars } from '../charts/StackedBars';
import { Volcano } from '../charts/Volcano';
import { describeError } from '../cirro/session';
import { useSize } from '../lib/useSize';
import { GENE_TEST_COLUMN, matrixOf, readDataFrame, type DataFrame } from '../reports/store';
import { fileStem, pngBlob, standaloneSvg, svgBlob } from './export';
import type { ChartSpec, FigureSpec } from './spec';

const num = (df: DataFrame, column: string) => {
  const c = df.columns[column];
  if (!c || Array.isArray(c)) throw new Error(`The result has no numeric column “${column}”.`);
  return c as ArrayLike<number>;
};

function Chart({ chart, df, marks, width }: { chart: ChartSpec; df: DataFrame; marks: DataFrame | null; width: number }) {
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
    const values = matrixOf(df, columns);
    const below = chart.marks?.below ?? 0;
    const marked = marks ? Array.from(matrixOf(marks, columns), (v) => v < below) : undefined;
    // Shares (a niche's mix) have nothing below zero to diverge from.
    return <Heatmap rows={df.index} columns={columns} values={values} width={width} label="Heatmap" diverging={values.some((v) => v < 0)} marked={marked} />;
  }
  if (chart.type === 'composition') {
    return <StackedBars rows={df.index} segments={chart.segments} colors={chart.colors} counts={matrixOf(df, chart.segments)} overall="Overall"
      width={width} label="Composition" unit={chart.unit} />;
  }
  // readFigures doesn't check the chart type, so a figure saved by a newer version can
  // name one this version doesn't draw.
  return <p className="muted">This figure's chart type isn't drawn by this version of the app.</p>;
}

export function ChartFigure({ spec, store, table }: { spec: FigureSpec; store: Required<AsyncReadable>; table: string }) {
  const [tables, setTables] = useState<{ df: DataFrame; marks: DataFrame | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useSize(ref);
  const chart = spec.view.kind === 'chart' ? spec.view.chart : null;
  const resultPath = chart?.result ?? null;
  const marksPath = chart?.type === 'heatmap' ? chart.marks?.result ?? null : null;
  useEffect(() => {
    if (!resultPath) return;
    let live = true;
    Promise.all([readDataFrame(store, table, resultPath), marksPath ? readDataFrame(store, table, marksPath) : null])
      .then(([df, marks]) => live && setTables({ df, marks }), (e: unknown) => live && setProblem(describeError(e)));
    return () => {
      live = false;
    };
  }, [store, table, resultPath, marksPath]);
  const [exporting, setExporting] = useState(false);
  // The chart as it is drawn here, at the width the figure was kept at. No PDF: the PDF
  // writer loses the labels' halos and with them the labels, and the SVG is the vector copy.
  const download = async (format: 'svg' | 'png') => {
    const drawn = ref.current?.querySelector('svg');
    if (!drawn) return;
    setProblem(null);
    setExporting(true);
    try {
      const svg = standaloneSvg(drawn);
      const page = { widthMm: spec.width_mm, heightMm: (spec.width_mm * drawn.clientHeight) / drawn.clientWidth };
      const blob = format === 'svg' ? svgBlob(svg) : await pngBlob(svg, page);
      downloadBlob(blob, `${fileStem(spec.title)}.${format}`);
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setExporting(false);
    }
  };
  return (
    <div className="chart-figure" ref={ref}>
      <header className="report-head">
        <div className="report-title">
          <h2>{spec.title}</h2>
          {spec.caption && <p className="muted">{spec.caption}</p>}
        </div>
        {chart && tables && (
          <div className="button-row">
            <span className="muted">Download</span>
            {(['png', 'svg'] as const).map((f) => (
              <button key={f} type="button" className="button button-small" disabled={exporting} onClick={() => void download(f)}>{f.toUpperCase()}</button>
            ))}
          </div>
        )}
      </header>
      {problem && <p className="notice notice-danger">{problem}</p>}
      {chart && tables && width > 0 && <Chart chart={chart} df={tables.df} marks={tables.marks} width={Math.min(width, 720)} />}
    </div>
  );
}
