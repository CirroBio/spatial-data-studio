import { describe, expect, it } from 'vitest';
import { storeName } from './storeName';

describe('storeName', () => {
  it('names a plain path by its last segment', () => {
    expect(storeName('results/Pancreas/sample.zarr.zip')).toBe('sample');
    expect(storeName('sample')).toBe('sample');
  });

  it('names a folder by the folder, trailing slash or not', () => {
    expect(storeName('https://data.example.org/runs/sopa.zarr/')).toBe('sopa');
    expect(storeName('runs/sopa.zarr')).toBe('sopa');
  });

  it('drops a query, which may itself hold slashes', () => {
    expect(storeName('https://lab.s3.amazonaws.com/s/lung.sdata.zarr.zip?X-Amz-Credential=a/b/c&X-Amz-Signature=d'))
      .toBe('lung');
  });

  it('decodes a percent-encoded name', () => {
    expect(storeName('https://lab.example.org/Mouse%20brain.zarr.zip')).toBe('Mouse brain');
  });

  it('keeps a malformed % as written instead of throwing', () => {
    expect(storeName('sections/100%.zarr.zip')).toBe('100%');
    expect(storeName('https://lab.example.org/a%zz.zarr.zip?sig=1')).toBe('a%zz');
  });

  it('strips each store extension, the longest that matches', () => {
    expect(storeName('a.sdata.zarr.zip')).toBe('a');
    expect(storeName('runs/a.sdata.zarr/')).toBe('a');
    expect(storeName('a.zarr.zip')).toBe('a');
    expect(storeName('a.zarr')).toBe('a');
    expect(storeName('a.zarr.tar.gz')).toBe('a');
    expect(storeName('a.zarr.tgz')).toBe('a');
    expect(storeName('A.SDATA.ZARR.ZIP')).toBe('A');
    expect(storeName('a.zarr.json')).toBe('a.zarr.json');
  });

  it('strips the content hash a save appends, and nothing like it', () => {
    expect(storeName('results-07b1a290f7f2.sdata.zarr.zip')).toBe('results');
    expect(storeName('Mouse%20brain-0123456789ab.sdata.zarr.zip?sig=1')).toBe('Mouse brain');
    expect(storeName('folder-07b1a290f7f2')).toBe('folder');
    // The backend writes lowercase hex, exactly 12 of it.
    expect(storeName('run-07B1A290F7F2.zarr.zip')).toBe('run-07B1A290F7F2');
    expect(storeName('run-07b1a290f7f.zarr.zip')).toBe('run-07b1a290f7f');
    expect(storeName('run-07b1a290f7f2a.zarr.zip')).toBe('run-07b1a290f7f2a');
  });

  it('is empty when there is no name, so the caller supplies one', () => {
    expect(storeName('')).toBe('');
    expect(storeName('/')).toBe('');
  });
});
