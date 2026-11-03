// Cirro publication shim.
// Canonical source: CirroBio/Cirro-publish-data-objects, shim/cirro-publication.ts.
// Copy this file into an app unchanged. To change it, edit the canonical copy, bump SHIM_VERSION,
// and re-copy it into every app listed in shim/ADOPTERS.md.
//
// Lets an app read Cirro data with the same @cirrobio/sdk calls from either a Cirro tenant or a
// publication: a public bucket written by cirro-publish (see SPEC.md in that repository).
// Requires @cirrobio/sdk and @cirrobio/api-client 0.13.39 or later (tested with 0.13.39 and 0.14.5).

import {
  AppRegistrationsApi,
  AuditApi,
  BillingApi,
  ColumnDataType,
  ComputeEnvironmentApi,
  Configuration,
  DashboardsApi,
  Dataset,
  DatasetDetail,
  DatasetsApi,
  ExecutionApi,
  FeedApi,
  FetchAPI,
  FileApi,
  Filter,
  FilterOperator,
  FilterValuesInner,
  GovernanceApi,
  MetadataApi,
  MetricsApi,
  Middleware,
  ProcessesApi,
  ProjectRequestsApi,
  ProjectsApi,
  ReferencesApi,
  ResponseContext,
  SharedFilesystemsApi,
  SharingApi,
  SheetDataRequest,
  SheetQueryRequest,
  SheetsApi,
  SystemApi,
  ToolsApi,
  UsersApi,
  WorkspacesApi,
} from "@cirrobio/api-client";
import { ApiError, DataService, DownloadableFile, FileService, GetSignedUrlOptions, ProjectFileAccessContext } from "@cirrobio/sdk";

export const SHIM_VERSION = 4;

// ---------------------------------------------------------------------------------------------
// Data sources: what an app constructs instead of DataService and FileService.

export interface DataSource {
  dataService: DataService;
  fileService: FileService;
}

/** Reads from a Cirro tenant as the signed-in user. */
export function createCirroDataSource(options: { tokenGetter: () => Promise<string>; basePath?: string }): DataSource {
  const dataService = new DataService({ tokenGetter: options.tokenGetter, basePath: options.basePath ?? API_BASE_PATH });
  return { dataService, fileService: new PassThroughFileService(dataService.file) };
}

export interface PublicationOptions {
  /** Public URL of the publication root, e.g. https://bucket.s3.us-west-2.amazonaws.com/published */
  baseUrl: string;
  /** Answers sheet row queries and raw SQL; without it those requests fail with 501. */
  runSql?: SqlRunner;
  /** Fetches publication documents; defaults to the global fetch. */
  fetch?: FetchAPI;
}

/** Reads anonymously from a publication. One per base URL. */
export function createPublicationDataSource(options: PublicationOptions): DataSource {
  const fetchApi = createPublicationFetch(options);
  const noCredentials = () => Promise.reject(new Error("A publication has no file credentials; its files are public URLs"));
  return {
    dataService: new PublicationDataService(fetchApi),
    fileService: new PassThroughFileService({ generateProjectFileAccessToken: noCredentials }),
  };
}

/** Returns public file URLs without signing and signs s3:// ones, so it serves both sources. */
export class PassThroughFileService extends FileService {
  override async getSignedUrlFromProjectFile(file: DownloadableFile, params?: GetSignedUrlOptions): Promise<string> {
    return file.url.startsWith("s3://") ? super.getSignedUrlFromProjectFile(file, params) : encodeFileUrl(file.url);
  }
}

/**
 * Percent-encodes each path segment of a file URL joined from raw manifest paths, as the SDK's
 * ManifestParser joins `${domain}/${path}`. S3 reads a literal "+" in a path as a space, so a
 * file named "IgM+" is unreadable unless encoded. The base URL itself must not be percent-encoded.
 */
export function encodeFileUrl(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(\/.*)?$/i.exec(url);
  const [origin, path] = match ? [match[1], match[2] ?? ""] : ["", url];
  return origin + path.split("/").map(encodeURIComponent).join("/");
}

const API_BASE_PATH = "/api";

/**
 * A DataService whose every API answers from a publication. The released SDK takes no fetchApi,
 * so each API getter is overridden; any getter left out would send requests to the app's own /api.
 */
export class PublicationDataService extends DataService {
  private readonly publicationConfig: Configuration;

  constructor(fetchApi: FetchAPI) {
    // DataService requires a token getter; publication requests carry no credentials.
    super({ tokenGetter: async () => "", basePath: API_BASE_PATH });
    this.publicationConfig = new Configuration({ basePath: API_BASE_PATH, fetchApi, middleware: [new ApiErrorMiddleware()] });
  }

  override get appRegistrations() { return new AppRegistrationsApi(this.publicationConfig); }
  override get audit() { return new AuditApi(this.publicationConfig); }
  override get billing() { return new BillingApi(this.publicationConfig); }
  override get computeEnvironments() { return new ComputeEnvironmentApi(this.publicationConfig); }
  override get dashboards() { return new DashboardsApi(this.publicationConfig); }
  override get datasets() { return new DatasetsApi(this.publicationConfig); }
  override get execution() { return new ExecutionApi(this.publicationConfig); }
  override get feed() { return new FeedApi(this.publicationConfig); }
  override get file() { return new FileApi(this.publicationConfig); }
  override get governance() { return new GovernanceApi(this.publicationConfig); }
  override get metadata() { return new MetadataApi(this.publicationConfig); }
  override get metrics() { return new MetricsApi(this.publicationConfig); }
  override get processes() { return new ProcessesApi(this.publicationConfig); }
  override get projectRequests() { return new ProjectRequestsApi(this.publicationConfig); }
  override get projects() { return new ProjectsApi(this.publicationConfig); }
  override get references() { return new ReferencesApi(this.publicationConfig); }
  override get sharedFilesystems() { return new SharedFilesystemsApi(this.publicationConfig); }
  override get sharing() { return new SharingApi(this.publicationConfig); }
  override get sheets() { return new SheetsApi(this.publicationConfig); }
  override get system() { return new SystemApi(this.publicationConfig); }
  override get tools() { return new ToolsApi(this.publicationConfig); }
  override get users() { return new UsersApi(this.publicationConfig); }
  override get workspaces() { return new WorkspacesApi(this.publicationConfig); }
}

/** Raises ApiError for error responses, as the SDK's own (unexported) error middleware does. */
class ApiErrorMiddleware implements Middleware {
  async post({ response }: ResponseContext): Promise<Response> {
    if (response.ok) return response;
    let message = "Unknown Error";
    try {
      message = (await response.json()).message ?? message;
    } catch {
      // The body was not JSON; the status code still identifies the failure.
    }
    throw new ApiError(message, [], response.status);
  }
}

// ---------------------------------------------------------------------------------------------
// Folders: Cirro's folder tags (key "Folder", value "folder://a/b"), in a live project or a publication.

const FOLDER_PREFIX = "folder://";

/** The folders an object is placed in; an object may be in several, or none (unfiled). */
export function folderPaths(tags: { value: string }[] | undefined): string[] {
  return (tags ?? [])
    .filter(tag => tag.value.startsWith(FOLDER_PREFIX))
    .map(tag => tag.value.slice(FOLDER_PREFIX.length).split("/").map(s => s.trim()).filter(Boolean).join("/"))
    .filter(Boolean);
}

export interface FolderListing {
  /** Paths of the folders directly inside the listed folder. */
  folders: string[];
  /** Datasets placed directly in the listed folder; at the root, the unfiled datasets. */
  datasets: Dataset[];
}

/** Lists one folder of a project's datasets as a filesystem would. `path` "" is the root. */
export async function listFolder(dataService: DataService, projectId: string, path = ""): Promise<FolderListing> {
  const folder = folderPaths([{ value: FOLDER_PREFIX + path }])[0] ?? "";
  const subfolders = new Set<string>();
  const datasets: Dataset[] = [];
  let nextToken: string | undefined;
  do {
    const page = await dataService.datasets.getDatasets({ projectId, nextToken });
    for (const dataset of page.data) {
      const paths = folderPaths(dataset.tags);
      if (paths.length === 0 ? folder === "" : paths.includes(folder)) datasets.push(dataset);
      for (const p of paths) {
        const rest = folder === "" ? p : p.startsWith(`${folder}/`) ? p.slice(folder.length + 1) : null;
        if (rest) subfolders.add(folder === "" ? rest.split("/")[0] : `${folder}/${rest.split("/")[0]}`);
      }
    }
    nextToken = page.nextToken ?? undefined;
  } while (nextToken);
  return { folders: Array.from(subfolders).sort(), datasets };
}

// ---------------------------------------------------------------------------------------------
// Dataset URIs: cirro:<tenantId>:<projectId>:dataset:<datasetId>[/<path>]

export interface DatasetUri {
  /** Empty in the URIs apps list for a publication, whose base URL takes the tenant's place. */
  tenantId: string;
  projectId: string;
  datasetId: string;
  /** Relative to the dataset's data directory, as in Cirro URI sheet cells; absent for the dataset itself. */
  path?: string;
}

const DATASET_URI = /^cirro:([^:]*):([^:/]+):dataset:([^:/]+)(?:\/(.+))?$/;

export function parseDatasetUri(uri: string): DatasetUri {
  const match = DATASET_URI.exec(uri);
  if (!match) throw new Error(`Not a Cirro dataset URI: ${uri}`);
  const [, tenantId, projectId, datasetId, path] = match;
  return path === undefined ? { tenantId, projectId, datasetId } : { tenantId, projectId, datasetId, path };
}

// ---------------------------------------------------------------------------------------------
// References: where an object lives (a Cirro tenant or a publication) and which object it is.

export type SourceKind = "cirro" | "publication";

/** `baseUrl` is a tenant's URL (https://dev.cirro.bio) or a publication's base URL. */
export interface DatasetReference {
  source: SourceKind;
  baseUrl: string;
  uri: string;
}

export function datasetReference(source: SourceKind, baseUrl: string, projectId: string, datasetId: string, path?: string): DatasetReference {
  const uri = `cirro::${projectId}:dataset:${datasetId}${path ? `/${path}` : ""}`;
  return { source, baseUrl: stripTrailing(baseUrl, "/"), uri };
}

export function parseDatasetReference(ref: DatasetReference): { source: SourceKind; baseUrl: string } & DatasetUri {
  if (ref.source !== "cirro" && ref.source !== "publication") throw new Error(`Unknown source kind: ${ref.source}`);
  return { source: ref.source, baseUrl: stripTrailing(ref.baseUrl, "/"), ...parseDatasetUri(ref.uri) };
}

/** The data source a reference reads from. Callers keep one per (source, baseUrl). */
export function dataSourceFor(ref: Pick<DatasetReference, "source" | "baseUrl">, options: { tokenGetter?: () => Promise<string> } = {}): DataSource {
  const baseUrl = stripTrailing(ref.baseUrl, "/");
  if (ref.source === "publication") return createPublicationDataSource({ baseUrl });
  if (!options.tokenGetter) throw new Error(`Reading ${baseUrl} needs a signed-in user's tokenGetter`);
  return createCirroDataSource({ tokenGetter: options.tokenGetter, basePath: `${baseUrl}/api` });
}

const datasetDetails = new WeakMap<DataSource, Map<string, Promise<DatasetDetail>>>();

/**
 * A URL for a file under a dataset's data/ directory: signed from a tenant, public from a
 * publication. Call again for a fresh signed URL; the dataset lookup is cached per data source.
 */
export async function datasetFileUrl(
  source: DataSource, projectId: string, datasetId: string, path: string, options: { timeoutMinutes?: number } = {},
): Promise<string> {
  let cache = datasetDetails.get(source);
  if (!cache) datasetDetails.set(source, cache = new Map());
  let detail = cache.get(datasetId);
  if (!detail) {
    detail = source.dataService.datasets.getDataset({ projectId, datasetId });
    cache.set(datasetId, detail);
    detail.catch(() => cache!.delete(datasetId));
  }
  const dataset = await detail;
  const file: DownloadableFile = {
    url: `${stripTrailing(dataset.s3, "/")}/data/${path}`,
    name: path.split("/").pop(),
    fileAccessContext: ProjectFileAccessContext.datasetDownload({ id: projectId }, dataset),
  };
  return source.fileService.getSignedUrlFromProjectFile(file, { timeout: options.timeoutMinutes });
}

// ---------------------------------------------------------------------------------------------
// Credit: tag values of the form "credit.<field>: <value>" (SPEC.md, "Dataset credit").

export interface Credit {
  source: string;
  url: string;
  by: string;
  license: string;
  licenseUrl: string;
  changes: string;
}

const CREDIT_FIELDS: (keyof Credit)[] = ["source", "url", "by", "license", "licenseUrl", "changes"];

/** The credit fields present on a dataset, or null when it names neither a source nor a license. */
export function creditOf(tags: { value: string }[] | undefined): Partial<Credit> | null {
  const credit: Partial<Credit> = {};
  for (const { value } of tags ?? []) {
    for (const field of CREDIT_FIELDS) {
      const prefix = `credit.${field}:`;
      if (value.startsWith(prefix)) credit[field] = value.slice(prefix.length).trim();
    }
  }
  return credit.source || credit.license ? credit : null;
}

// ---------------------------------------------------------------------------------------------
// Publication fetch: answers Cirro API requests from a publication's documents.

/** Runs one SQL statement, e.g. on a DuckDB-WASM connection, and returns its rows positionally. */
export type SqlRunner = (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>;

interface RouteContext {
  params: string[];
  query: URLSearchParams;
  body: any;
}

type Handler = (ctx: RouteContext) => Promise<unknown>;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Mirrors the Cirro API's default page size for dataset manifests.
const DEFAULT_MANIFEST_LIMIT = 20000;
// Publication format version 2: one project per publication root (see SPEC.md).
const V2 = "v2";
const SEGMENT = "([^/:]+)";

/**
 * A fetch that serves Cirro API read routes from a publication; every other route is a 404. A
 * publication is one project. Dataset, sheet and dashboard routes resolve by object ID and ignore
 * the project segment, so a URI naming the object's origin project reads it too.
 */
export function createPublicationFetch(options: PublicationOptions): FetchAPI {
  const baseUrl = stripTrailing(options.baseUrl, "/");
  const fetchDocument = options.fetch ?? ((input, init) => fetch(input, init));

  const resolve = (rel: string) => `${baseUrl}/${rel}`;

  async function document(rel: string): Promise<any> {
    const response = await fetchDocument(resolve(rel));
    // A public bucket without list permission answers 403 for keys that do not exist.
    if (response.status === 403 || response.status === 404) throw new HttpError(404, `Not published: ${rel}`);
    if (!response.ok) throw new HttpError(response.status, `Failed to read ${rel}`);
    return response.json();
  }

  /** A publication need not hold every object kind; a missing index lists nothing. */
  async function optionalIndex(rel: string, empty: unknown): Promise<unknown> {
    try {
      return await document(rel);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return empty;
      throw e;
    }
  }

  function sqlRunner(): SqlRunner {
    if (!options.runSql) throw new HttpError(501, "This publication reader was created without a SQL runner");
    return options.runSql;
  }

  async function sheetQuery({ params: [, s], body }: RouteContext) {
    const runSql = sqlRunner();
    const sheet = await document(`${V2}/sheets/${s}.json`);
    const columns: { name: string; dataType: ColumnDataType }[] = sheet.columns;
    const { pageSql, countSql } = buildSheetQuery(
      resolve(`${V2}/sheets/${s}.parquet`), columns.map(c => c.name), (body ?? {}) as SheetDataRequest);
    const page = await runSql(pageSql);
    const count = await runSql(countSql);
    const responseColumns = [{ name: ROW_ID_COLUMN, dataType: ColumnDataType.Bigint }, ...columns.map(c => ({ name: c.name, dataType: c.dataType }))];
    return {
      columns: responseColumns,
      rows: page.rows.map(row => row.map((v, i) => toCellValue(v, responseColumns[i].dataType))),
      totalRowCount: Number(count.rows[0][0]),
    };
  }

  async function rawQuery({ body }: RouteContext) {
    const runSql = sqlRunner();
    const request = body as SheetQueryRequest;
    const sheets: { id: string; namespaceName: string; tableName: string }[] = await document(`${V2}/sheets/index.json`);
    // Views are recreated for every query so that names always resolve to this project's sheets.
    const namespaces = Array.from(new Set(sheets.map(s => s.namespaceName)));
    for (const namespace of namespaces) {
      await runSql(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(namespace)}`);
    }
    for (const sheet of sheets) {
      const parquetUrl = resolve(`${V2}/sheets/${sheet.id}.parquet`);
      await runSql(`CREATE OR REPLACE VIEW ${quoteIdentifier(sheet.namespaceName)}.${quoteIdentifier(sheet.tableName)} AS SELECT * FROM read_parquet(${sqlLiteral(parquetUrl)})`);
    }
    if (namespaces.length) {
      await runSql(`SET search_path = ${sqlLiteral(namespaces.join(","))}`);
    }
    const { pageSql, countSql, describeSql } = buildRawQuery(request.query, request.limit ?? undefined, request.page ?? undefined);
    // Failures from here on come from the caller's SQL, which the Cirro API reports as 400.
    const runQuery = (sql: string) => runSql(sql).catch((e: Error) => { throw new HttpError(400, e.message); });
    const description = await runQuery(describeSql);
    const nameIndex = description.columns.indexOf("column_name");
    const typeIndex = description.columns.indexOf("column_type");
    const columns = description.rows.map(r => ({ name: String(r[nameIndex]), dataType: toColumnDataType(String(r[typeIndex])) }));
    const page = await runQuery(pageSql);
    const count = await runQuery(countSql);
    return {
      columns,
      rows: page.rows.map(row => row.map((v, i) => toCellValue(v, columns[i].dataType))),
      totalRowCount: Number(count.rows[0][0]),
    };
  }

  async function project({ params: [projectId] }: RouteContext) {
    const detail = await document(`${V2}/project.json`);
    if (projectId !== undefined && projectId !== detail.id) throw new HttpError(404, `Not this publication's project: ${projectId}`);
    return detail;
  }

  async function datasetDetail({ params: [, d] }: RouteContext) {
    const dataset = await document(`${V2}/datasets/${d}.json`);
    return { ...dataset, s3: resolve(dataset.s3) };
  }

  async function datasetManifest({ params: [, d], query }: RouteContext) {
    const manifest = await document(`${V2}/datasets/${d}/files.json`);
    const offset = Number(query.get("fileOffset") ?? 0);
    const limit = Number(query.get("fileLimit") ?? DEFAULT_MANIFEST_LIMIT);
    return { ...manifest, domain: resolve(manifest.domain), files: manifest.files.slice(offset, offset + limit) };
  }

  async function processDetail({ params: [processId] }: RouteContext) {
    const processes: { id: string }[] = await document(`${V2}/processes/index.json`);
    const process = processes.find(entry => entry.id === processId);
    if (!process) throw new HttpError(404, `Not published: process ${processId}`);
    return process;
  }

  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/projects$/, async (ctx) => [await project(ctx)]],
    ["GET", route(`/projects/${SEGMENT}`), project],
    ["GET", route(`/projects/${SEGMENT}/datasets`), () => optionalIndex(`${V2}/datasets/index.json`, { data: [], nextToken: null })],
    ["GET", route(`/projects/${SEGMENT}/datasets/${SEGMENT}`), datasetDetail],
    ["GET", route(`/projects/${SEGMENT}/datasets/${SEGMENT}/files`), datasetManifest],
    ["GET", route(`/projects/${SEGMENT}/sheets`), () => optionalIndex(`${V2}/sheets/index.json`, [])],
    ["POST", route(`/projects/${SEGMENT}/sheets/raw-query`), rawQuery],
    ["GET", route(`/projects/${SEGMENT}/sheets/${SEGMENT}`), ({ params: [, s] }) => document(`${V2}/sheets/${s}.json`)],
    ["POST", route(`/projects/${SEGMENT}/sheets/${SEGMENT}/data/query`), sheetQuery],
    ["GET", route(`/projects/${SEGMENT}/dashboards`), () => optionalIndex(`${V2}/dashboards/index.json`, [])],
    ["GET", route(`/projects/${SEGMENT}/dashboards/${SEGMENT}`), ({ params: [, id] }) => document(`${V2}/dashboards/${id}.json`)],
    ["GET", /^\/processes$/, () => optionalIndex(`${V2}/processes/index.json`, [])],
    ["GET", route(`/processes/${SEGMENT}`), processDetail],
  ];

  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://publication.invalid");
    if (!url.pathname.startsWith(API_BASE_PATH)) {
      return jsonResponse(404, { message: `Not an API request: ${url.pathname}` });
    }
    const path = url.pathname.slice(API_BASE_PATH.length);
    for (const [routeMethod, pattern, handler] of routes) {
      const match = method === routeMethod ? pattern.exec(path) : null;
      if (!match) continue;
      try {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        const params = match.slice(1).map(decodeURIComponent);
        return jsonResponse(200, await handler({ params, query: url.searchParams, body }));
      } catch (e) {
        if (e instanceof HttpError) return jsonResponse(e.status, { message: e.message });
        if (e instanceof SheetQueryError) return jsonResponse(400, { message: e.message });
        throw e;
      }
    }
    return jsonResponse(404, { message: `Not available from a publication: ${method} ${path}` });
  };
}

function route(pattern: string): RegExp {
  return new RegExp(`^${pattern}$`);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Removes any trailing characters found in `chars`, in linear time (a `/x+$/` regex can backtrack polynomially). */
export function stripTrailing(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end--;
  return value.slice(0, end);
}

// ---------------------------------------------------------------------------------------------
// Sheet queries: SQL over a sheet's published parquet, following the Cirro backend's semantics.

// Matches the Cirro API's defaults and limits for sheet queries.
const DEFAULT_LIMIT = 1000;
const DEFAULT_PAGE = 1;
const MAX_FILTER_DEPTH = 10;
const MAX_IN_VALUES = 1000;

const ROW_ID_COLUMN = "_row_id";

const SINGLE_VALUE_OPERATORS: Partial<Record<FilterOperator, string>> = {
  [FilterOperator.Equals]: "=",
  [FilterOperator.NotEquals]: "!=",
  [FilterOperator.GreaterThan]: ">",
  [FilterOperator.GreaterThanOrEquals]: ">=",
  [FilterOperator.LessThan]: "<",
  [FilterOperator.LessThanOrEquals]: "<=",
  [FilterOperator.Like]: "LIKE",
  [FilterOperator.NotLike]: "NOT LIKE",
};

export class SheetQueryError extends Error {}

function quoteIdentifier(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

function sqlLiteral(value: FilterValuesInner | null): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  return `'${value.split("'").join("''")}'`;
}

/** Translates a sheet filter tree to a SQL condition, following the Cirro backend's FilterSqlBuilder. */
export function filterToSql(filter: Filter, columns: Set<string>, depth = 0): string {
  if (depth > MAX_FILTER_DEPTH) {
    throw new SheetQueryError(`Filter nesting exceeds maximum depth of ${MAX_FILTER_DEPTH}`);
  }
  const isGroup = filter.logicalOperator != null || filter.conditions != null;
  const isLeaf = filter.column != null || filter.operator != null;
  if (isGroup && isLeaf) throw new SheetQueryError("Filter node cannot be both a group and a leaf condition");
  if (isGroup) {
    if (!filter.logicalOperator) throw new SheetQueryError("Filter group must have a logicalOperator");
    if (!filter.conditions?.length) throw new SheetQueryError("Filter group must have at least one condition");
    return `(${filter.conditions.map(c => filterToSql(c, columns, depth + 1)).join(` ${filter.logicalOperator} `)})`;
  }
  if (!isLeaf || !filter.column || !filter.operator) {
    throw new SheetQueryError("Leaf filter must have column and operator");
  }
  const column = resolveColumn(filter.column, columns);
  const values = filter.values ?? [];
  switch (filter.operator) {
    case FilterOperator.IsNull:
      return `${column} IS NULL`;
    case FilterOperator.IsNotNull:
      return `${column} IS NOT NULL`;
    case FilterOperator.In:
    case FilterOperator.NotIn:
      if (values.length === 0) {
        throw new SheetQueryError(`Filter on ${filter.column} with operator ${filter.operator} requires a non-empty values list`);
      }
      if (values.length > MAX_IN_VALUES) {
        throw new SheetQueryError(`IN/NOT_IN filter exceeds maximum of ${MAX_IN_VALUES} values`);
      }
      return `${column} ${filter.operator === FilterOperator.NotIn ? "NOT " : ""}IN (${values.map(sqlLiteral).join(", ")})`;
    default:
      if (values.length !== 1) {
        throw new SheetQueryError(`Filter on ${filter.column} with operator ${filter.operator} requires exactly one value`);
      }
      return `${column} ${SINGLE_VALUE_OPERATORS[filter.operator]} ${sqlLiteral(values[0])}`;
  }
}

function resolveColumn(name: string, columns: Set<string>): string {
  if (!columns.has(name)) throw new SheetQueryError(`Unknown column: ${name}`);
  return quoteIdentifier(name);
}

/** The page and count queries for a sheet stored as parquet; `_row_id` is synthesized from row order. */
export function buildSheetQuery(parquetUrl: string, columnNames: string[], request: SheetDataRequest) {
  const limit = request.limit ?? DEFAULT_LIMIT;
  const page = request.page ?? DEFAULT_PAGE;
  if (limit < 1) throw new SheetQueryError("limit must be >= 1");
  if (page < 1) throw new SheetQueryError("page must be >= 1");
  const columns = new Set([ROW_ID_COLUMN, ...columnNames]);
  const selectList = [ROW_ID_COLUMN, ...columnNames].map(quoteIdentifier).join(", ");
  const source = `(SELECT row_number() OVER () AS ${ROW_ID_COLUMN}, * FROM read_parquet(${sqlLiteral(parquetUrl)}))`;
  const where = request.filter ? ` WHERE ${filterToSql(request.filter, columns)}` : "";
  const orderBy = request.sort?.orderBy
    ? ` ORDER BY ${resolveColumn(request.sort.orderBy, columns)} ${request.sort.order ?? "ASC"}`
    : "";
  return {
    pageSql: `SELECT ${selectList} FROM ${source}${where}${orderBy} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    countSql: `SELECT count(*) FROM ${source}${where}`,
  };
}

/** The page and count queries for a raw SQL query, wrapped as the Cirro backend wraps it. */
export function buildRawQuery(query: string, limit = DEFAULT_LIMIT, page = DEFAULT_PAGE) {
  if (limit < 1) throw new SheetQueryError("limit must be >= 1");
  if (page < 1) throw new SheetQueryError("page must be >= 1");
  const inner = stripTrailing(query, "; \t\r\n").trim();
  return {
    pageSql: `SELECT * FROM (${inner}) LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    countSql: `SELECT count(*) FROM (${inner})`,
    describeSql: `DESCRIBE SELECT * FROM (${inner})`,
  };
}

const DUCKDB_TYPES: Record<string, ColumnDataType> = {
  TINYINT: ColumnDataType.Integer,
  SMALLINT: ColumnDataType.Integer,
  INTEGER: ColumnDataType.Integer,
  UTINYINT: ColumnDataType.Integer,
  USMALLINT: ColumnDataType.Integer,
  UINTEGER: ColumnDataType.Bigint,
  BIGINT: ColumnDataType.Bigint,
  UBIGINT: ColumnDataType.Bigint,
  HUGEINT: ColumnDataType.Bigint,
  UHUGEINT: ColumnDataType.Bigint,
  FLOAT: ColumnDataType.Float,
  DOUBLE: ColumnDataType.Double,
  BOOLEAN: ColumnDataType.Boolean,
  DATE: ColumnDataType.Date,
};

/** Maps a DuckDB column type to the sheet column type the Cirro API reports; unmapped types are STRING. */
export function toColumnDataType(duckDbType: string): ColumnDataType {
  const type = duckDbType.toUpperCase();
  if (type.startsWith("DECIMAL")) return ColumnDataType.Double;
  if (type.startsWith("TIMESTAMP")) return ColumnDataType.Timestamp;
  return DUCKDB_TYPES[type] ?? ColumnDataType.String;
}

/** Converts a value from the SQL runner to the JSON value the Cirro API returns for that column type. */
export function toCellValue(value: unknown, dataType: ColumnDataType): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === ColumnDataType.Date || dataType === ColumnDataType.Timestamp) {
    // DuckDB-WASM returns dates and timestamps as epoch milliseconds.
    const iso = (value instanceof Date ? value : new Date(value as number | string)).toISOString();
    return dataType === ColumnDataType.Date ? iso.slice(0, 10) : iso;
  }
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  return value;
}
