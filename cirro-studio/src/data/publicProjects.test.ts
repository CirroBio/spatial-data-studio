import { beforeEach, describe, expect, it, vi } from 'vitest';

// While the network is down nothing answers.
const network = vi.hoisted(() => ({ down: false }));

// A publication answers with one project, named after the last part of its root and
// identified by it without any "-copy"; a root under /missing/ is not a publication.
vi.mock('../cirro/cirro-publication', () => ({
  createPublicationDataSource: ({ baseUrl }: { baseUrl: string }) => ({
    dataService: {
      projects: {
        getProjects: async () => {
          if (network.down) throw new Error('Failed to fetch');
          if (baseUrl.includes('/missing/')) throw new Error('Not published: v2/project.json');
          const name = baseUrl.split('/').pop()!;
          return [{ id: `id-${name.replace(/-copy$/, '')}`, name, description: '' }];
        },
      },
    },
  }),
}));

// A folder under /lab/ has an index.json; nothing else answers.
vi.stubGlobal('fetch', async (url: string) => (!network.down && String(url).includes('/lab/index.json')
  ? new Response(JSON.stringify({ title: 'Lab sections', checkpoints: [{ path: 'a.sdata.zarr.zip' }] }))
  : new Response('', { status: 403 })));

const STORAGE_KEY = 'spatial-data-studio.public-projects';

// The list is read once per page, so each test loads the module afresh.
async function load() {
  vi.resetModules();
  return import('./publicProjects');
}
type Store = Awaited<ReturnType<typeof load>>;

// Read the list as the app does, and wait for every publication in it to answer.
async function settled(m: Store) {
  m.subscribePublicProjects(() => {});
  await vi.waitFor(() => expect(m.publicProjectsSnapshot().every((p) => p.status !== 'loading')).toBe(true));
}

beforeEach(() => {
  localStorage.clear();
  network.down = false;
});

describe('publicationRoot', () => {
  it('takes a root as typed or pasted', async () => {
    const { publicationRoot } = await load();
    expect(publicationRoot(' https://b.s3.amazonaws.com/published/x-studio/ ')).toBe('https://b.s3.amazonaws.com/published/x-studio');
    expect(publicationRoot('https://b.s3.amazonaws.com/published/x-studio/catalog.json')).toBe('https://b.s3.amazonaws.com/published/x-studio');
    expect(publicationRoot('http://localhost:8790')).toBe('http://localhost:8790');
    expect(publicationRoot('https://data.example.org/lab/index.json')).toBe('https://data.example.org/lab');
  });

  it('refuses anything but an https address', async () => {
    const { publicationRoot } = await load();
    expect(() => publicationRoot('http://example.org/published/x')).toThrow('https address');
    expect(() => publicationRoot('javascript:alert(1)')).toThrow('https address');
    expect(() => publicationRoot('published/x')).toThrow('https address');
  });
});

describe('the public projects this browser lists', () => {
  it('starts with this app\'s own publication', async () => {
    const m = await load();
    await settled(m);
    expect(m.publicProjectsSnapshot()).toEqual([expect.objectContaining({ url: m.DEFAULT_PUBLIC_PROJECT, isDefault: true, status: 'ready' })]);
  });

  it('keeps additions and removals in this browser', async () => {
    let m = await load();
    await m.addPublicProject('https://b.s3.amazonaws.com/published/expression-studio/');
    m.removePublicProject(m.DEFAULT_PUBLIC_PROJECT);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(['https://b.s3.amazonaws.com/published/expression-studio']);
    m = await load();
    await settled(m);
    expect(m.publicProjectsSnapshot().map((p) => [p.url, p.status === 'ready' && p.project.name])).toEqual([
      ['https://b.s3.amazonaws.com/published/expression-studio', 'expression-studio'],
    ]);
    m.restoreDefaultPublicProject();
    expect(m.publicProjectsSnapshot()[0]).toMatchObject({ url: m.DEFAULT_PUBLIC_PROJECT, isDefault: true });
  });

  it('saves the default by name, so a new default address reaches a saved list', async () => {
    const m = await load();
    await m.addPublicProject('https://b.s3.amazonaws.com/published/expression-studio');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(['default', 'https://b.s3.amazonaws.com/published/expression-studio']);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['https://b.s3.amazonaws.com/published/slide-studio', 'default']));
    expect((await load()).publicProjectsSnapshot().map((p) => [p.url, p.isDefault])).toEqual([
      ['https://b.s3.amazonaws.com/published/slide-studio', false],
      [m.DEFAULT_PUBLIC_PROJECT, true],
    ]);
  });

  it('adds a folder listed by an index.json, named by its title', async () => {
    const m = await load();
    const project = await m.addPublicProject('https://data.example.org/missing/lab/');
    expect(project).toMatchObject({ kind: 'index', url: 'https://data.example.org/missing/lab', name: 'Lab sections' });
    expect(project.id).toMatch(/^index-[0-9a-f]{8}$/);
    const again = await load();
    await settled(again);
    expect(again.publicProjectsSnapshot()[1]).toMatchObject({ status: 'ready', project: { kind: 'index', id: project.id } });
  });

  it('refuses an address that is not a public project, or one already listed', async () => {
    const m = await load();
    await settled(m);
    await expect(m.addPublicProject('https://b.s3.amazonaws.com/missing/x')).rejects.toThrow('could be read as a public project');
    await m.addPublicProject('https://b.s3.amazonaws.com/published/slide-studio');
    await expect(m.addPublicProject('https://b.s3.amazonaws.com/published/slide-studio/')).rejects.toThrow('already in the list');
    await expect(m.addPublicProject('https://other.example.org/published/slide-studio-copy')).rejects.toThrow('same public project');
    expect(m.publicProjectsSnapshot()).toHaveLength(2);
  });

  it('reads a project that failed afresh when it is listed again', async () => {
    network.down = true;
    const m = await load();
    await settled(m);
    expect(m.publicProjectsSnapshot()[0]).toMatchObject({ status: 'error' });
    network.down = false;
    m.removePublicProject(m.DEFAULT_PUBLIC_PROJECT);
    m.restoreDefaultPublicProject();
    await settled(m);
    expect(m.publicProjectsSnapshot()).toEqual([expect.objectContaining({ isDefault: true, status: 'ready' })]);
  });

  it('lists a project once when it is restored while being added', async () => {
    const m = await load();
    m.removePublicProject(m.DEFAULT_PUBLIC_PROJECT);
    const adding = m.addPublicProject(m.DEFAULT_PUBLIC_PROJECT);
    m.restoreDefaultPublicProject();
    await expect(adding).rejects.toThrow('already in the list');
    await settled(m);
    expect(m.publicProjectsSnapshot()).toHaveLength(1);
  });

  it('falls back to the default list when storage holds something else', async () => {
    localStorage.setItem(STORAGE_KEY, '{"not": "a list"}');
    const m = await load();
    expect(m.publicProjectsSnapshot().map((p) => p.url)).toEqual([m.DEFAULT_PUBLIC_PROJECT]);
  });
});

describe('openedStoreProject', () => {
  const SIGNED = 'https://lab.s3.amazonaws.com/sections/Mouse%20brain-0123456789ab.sdata.zarr.zip?X-Amz-Expires=600&X-Amz-Signature=';

  it('opens a .zarr.zip as a project of that one store, named after its file', async () => {
    const { openedStoreProject } = await load();
    const opened = openedStoreProject(`${SIGNED}aaa`);
    expect(opened.project).toMatchObject({ kind: 'store', url: `${SIGNED}aaa`, name: 'Mouse brain' });
    expect(opened.path).toBe('Mouse brain-0123456789ab.sdata.zarr.zip');
  });

  it('knows a store by its address without the query, so a link signed again is the same project', async () => {
    const { openedStoreProject } = await load();
    const first = openedStoreProject(`${SIGNED}aaa`);
    const again = openedStoreProject(`${SIGNED}bbb`);
    expect(again.project.id).toBe(first.project.id);
    expect(again.datasetId).toBe(first.datasetId);
    expect(openedStoreProject('https://lab.s3.amazonaws.com/sections/other.zarr.zip').project.id).not.toBe(first.project.id);
  });

  it('refuses an address that is not an https .zarr.zip', async () => {
    const { openedStoreProject } = await load();
    for (const address of ['not an address', 'http://lab.example.org/a.zarr.zip', 'https://lab.example.org/a.zarr/', 'https://lab.example.org/page.html?f=a.zarr.zip']) {
      expect(() => openedStoreProject(address)).toThrow('.zarr.zip');
    }
    expect(openedStoreProject('http://localhost:8080/a.zarr.zip').path).toBe('a.zarr.zip');
  });
});
