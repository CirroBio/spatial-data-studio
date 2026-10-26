// The terminal commands that upload a folder as a new dataset with Cirro's command-line
// tool. `cirro upload` checks the files against the data type, creates the dataset and
// uploads them; its first run logs in through the browser.

// Python the `cirro` package installs on (its pyproject).
export const CLI_PYTHON = 'Python 3.11 or later';

// Characters a shell word can hold unquoted; a leading ~ stays unquoted so it expands.
const PLAIN = /^[\w./:@%+=,~-]+$/;
// One POSIX shell word, whatever the value holds.
const word = (s: string) => (PLAIN.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Shell lines that upload `folder` to the project as a dataset of the data type. */
export function uploadCommand({ host, projectId, dataTypeId, name, folder }: {
  host: string; projectId: string; dataTypeId: string; name: string; folder: string;
}): string {
  return [
    'pip install cirro',
    `export CIRRO_BASE_URL=${host}`,
    'cirro upload \\',
    `  --project ${projectId} \\`,
    `  --data-type ${word(dataTypeId)} \\`,
    `  --name ${word(name)} \\`,
    `  --data-directory ${word(folder)}`,
  ].join('\n');
}
