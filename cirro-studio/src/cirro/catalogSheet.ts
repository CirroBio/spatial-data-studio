// The project's catalog: what scanning each dataset found, kept so the next visit — by
// anyone in the project — lists only the datasets nobody has scanned yet. It is a Cirro
// sheet (`spatial_data_studio.catalog`) where the project can have one, and this
// browser's storage where it can't (sheets off, not permitted, or failing).
import {
  ColumnDataType, EntityType, SemanticColumnType, SheetCreationMode, SqlSortOrder,
  type ColumnDef, type Sheet,
} from '@cirrobio/api-client';
import { APP_TAG, APP_VERSION, SHEET_NAMESPACE } from '../app/appInfo';
import { kvDeleteWhere, kvPut, kvValues } from '../data/idb';
import { ROW_KINDS, rowsOf, scansOf, type CatalogRow, type ScanRecord } from '../data/scan';
import { addProvenanceNote } from './provenance';
import { describeError, refusedPermission, type CirroSession } from './session';

const TABLE = 'catalog';
const PAGE = 1000;
const BATCH = 250;

const COLUMNS: ColumnDef[] = [
  { name: 'item', dataType: ColumnDataType.String, required: true, unique: true, description: 'kind:dataset/path' },
  { name: 'kind', dataType: ColumnDataType.String, semanticType: SemanticColumnType.EnumSingle, allowedValues: ROW_KINDS },
  { name: 'dataset', dataType: ColumnDataType.String, semanticType: SemanticColumnType.CirroDataset },
  { name: 'dataset_id', dataType: ColumnDataType.String, required: true },
  { name: 'path', dataType: ColumnDataType.String, description: 'Relative to the dataset\'s data directory' },
  { name: 'label', dataType: ColumnDataType.String },
  { name: 'size_bytes', dataType: ColumnDataType.Bigint },
  { name: 'format', dataType: ColumnDataType.String },
  { name: 'details', dataType: ColumnDataType.String, description: 'JSON' },
  { name: 'scanned_at', dataType: ColumnDataType.String },
  { name: 'app_version', dataType: ColumnDataType.String },
];

export interface CatalogCache {
  // 'sheet', or why the catalog is kept in this browser instead.
  readonly where: { kind: 'sheet' } | { kind: 'browser'; reason: string };
  load(): Promise<Map<string, ScanRecord>>;
  save(scans: ScanRecord[]): Promise<void>;
}

class BrowserCatalog implements CatalogCache {
  constructor(private readonly projectId: string, readonly where: CatalogCache['where']) {}

  async load(): Promise<Map<string, ScanRecord>> {
    const all = await kvValues<ScanRecord & { projectId: string }>('scans');
    return new Map(all.filter((s) => s.projectId === this.projectId).map((s) => [s.datasetId, s]));
  }

  async save(scans: ScanRecord[]): Promise<void> {
    for (const s of scans) await kvPut('scans', `${this.projectId}/${s.datasetId}`, { ...s, projectId: this.projectId });
  }
}

// Every entry in 'scans' is a Cirro project's: the examples list their own files.
export const forgetBrowserCatalog = () => kvDeleteWhere('scans', () => true);

class SheetCatalog implements CatalogCache {
  readonly where = { kind: 'sheet' } as const;

  // Saves start every 1.5 s while scans stream in, so on a first visit a second one can
  // start before the sheet exists; they share one creation.
  private creating: Promise<string> | null = null;
  // Every `item` the sheet holds. The column is unique and saves only insert, so a dataset
  // re-scanned because its `dataset` row is missing (a write cut short) must not insert
  // again the rows that did land.
  private readonly items = new Set<string>();

  constructor(private readonly cirro: CirroSession, private readonly projectId: string, private sheetId: string | null) {}

  async load(): Promise<Map<string, ScanRecord>> {
    if (!this.sheetId) return new Map();
    const rows: CatalogRow[] = [];
    for (let page = 1; ; page++) {
      const res = await this.cirro.data.sheets.querySheetData({
        projectId: this.projectId, sheetId: this.sheetId,
        // Ordered by _row_id: unordered pages of a large sheet overlap and skip rows.
        sheetDataRequest: { limit: PAGE, page, sort: { orderBy: '_row_id', order: SqlSortOrder.Asc } },
      });
      const names = res.columns.map((c) => c.name);
      for (const r of res.rows) rows.push(Object.fromEntries(names.map((n, i) => [n, r[i]])) as unknown as CatalogRow);
      if (res.rows.length < PAGE || rows.length >= res.totalRowCount) break;
    }
    for (const r of rows) this.items.add(r.item);
    return scansOf(rows);
  }

  private ensureSheet(): Promise<string> {
    if (this.sheetId) return Promise.resolve(this.sheetId);
    this.creating ??= (async () => {
      const { id } = await this.cirro.data.sheets.createSheet({
        projectId: this.projectId,
        sheetInput: {
          sheetType: 'TABLE',
          name: 'Spatial Data Studio catalog',
          description: 'What Spatial Data Studio found in each dataset: SpatialData stores, instrument runs, images and saved versions.',
          namespaceName: SHEET_NAMESPACE,
          tableName: TABLE,
          sheetCreationMode: SheetCreationMode.Scratch,
          tags: [APP_TAG],
          columns: COLUMNS,
        },
      });
      this.sheetId = id;
      await addProvenanceNote(this.cirro, this.projectId, { type: EntityType.Sheet, id }, {
        what: 'The project catalog Spatial Data Studio keeps of what each dataset holds, so it lists files only for datasets it has not seen.',
        inputs: [],
      });
      return id;
    })();
    return this.creating;
  }

  async save(scans: ScanRecord[]): Promise<void> {
    if (!scans.length) return;
    const sheetId = await this.ensureSheet();
    // A dataset's `dataset` row goes last, so a write cut short leaves it unscanned
    // rather than scanned with items missing.
    const rows = scans.flatMap((s) => {
      const [head, ...items] = rowsOf(s);
      return [...items, head];
    }).map((r) => ({
      ...r,
      dataset: `cirro:${this.cirro.tenantId}:${this.projectId}:dataset:${r.dataset_id}`,
      app_version: APP_VERSION,
    }));
    try {
      await this.insert(sheetId, rows);
    } catch (e) {
      // Someone else opening the project writes the same rows, and the sheet refuses the
      // later write (a duplicate item, or two writes colliding). Read what landed, and try
      // once more.
      if (refusedPermission(e)) throw e;
      await this.load();
      await this.insert(sheetId, rows);
    }
  }

  private async insert(sheetId: string, rows: CatalogRow[]): Promise<void> {
    const fresh = rows.filter((r) => !this.items.has(r.item));
    for (let i = 0; i < fresh.length; i += BATCH) {
      const batch = fresh.slice(i, i + BATCH);
      await this.cirro.data.sheets.insertSheetData({
        projectId: this.projectId, sheetId,
        insertRowsRequest: { inserts: batch.map((values) => ({ values })) },
      });
      for (const r of batch) this.items.add(r.item);
    }
  }
}

/** The catalog for a project: its sheet when the project can have one, else this browser. */
export async function openCatalog(cirro: CirroSession, projectId: string): Promise<CatalogCache> {
  const browser = (reason: string) => new BrowserCatalog(projectId, { kind: 'browser', reason });
  if (!cirro.sheetsEnabled) return browser('Sheets are turned off in this Cirro, so the catalog is kept in this browser.');
  let sheets: Sheet[];
  try {
    sheets = await cirro.data.sheets.getSheets({ projectId });
  } catch (e) {
    // Any refusal or failure here leaves the app working.
    return browser(refusedPermission(e) ? `The catalog is kept in this browser: ${describeError(e)}` : `The catalog is kept in this browser (${describeError(e)}).`);
  }
  const sheet = sheets.find((s) => s.namespaceName === SHEET_NAMESPACE && s.tableName === TABLE && s.sheetType === 'TABLE');
  return new SheetCatalog(cirro, projectId, sheet?.id ?? null);
}

/** A sheet write refused or failed: carry on with the browser catalog for this visit. */
export function browserFallback(projectId: string, e: unknown): CatalogCache {
  return new BrowserCatalog(projectId, { kind: 'browser', reason: `The project catalog couldn't be updated (${describeError(e, 'update sheets')}), so new findings are kept in this browser.` });
}
