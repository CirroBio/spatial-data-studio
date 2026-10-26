import { describe, expect, it } from 'vitest';
import { uploadCommand } from './uploadCommand';

describe('uploadCommand', () => {
  it('names the Cirro, the project, the data type, the dataset and the folder', () => {
    expect(uploadCommand({ host: 'dev.cirro.bio', projectId: 'p-1', dataTypeId: 'xenium', name: 'Lung run', folder: './output' })).toBe([
      'pip install cirro',
      'export CIRRO_BASE_URL=dev.cirro.bio',
      'cirro upload \\',
      '  --project p-1 \\',
      '  --data-type xenium \\',
      "  --name 'Lung run' \\",
      '  --data-directory ./output',
    ].join('\n'));
  });

  it('keeps a name with quotes and shell characters one word', () => {
    const command = uploadCommand({ host: 'h', projectId: 'p', dataTypeId: 'd', name: "Sam's $HOME `run`", folder: '~/my data' });
    expect(command).toContain(`--name 'Sam'\\''s $HOME \`run\`'`);
    expect(command).toContain(`--data-directory '~/my data'`);
  });

  it('leaves a home-relative path unquoted, so the shell expands it', () => {
    expect(uploadCommand({ host: 'h', projectId: 'p', dataTypeId: 'd', name: 'n', folder: '~/runs/output_1' })).toContain('--data-directory ~/runs/output_1');
  });
});
