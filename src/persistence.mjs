import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readSnapshot(dataDir) {
  return JSON.parse(await readFile(join(dataDir, 'snapshot-v1.json'), 'utf8'));
}

export async function readSourceState(dataDir) {
  return JSON.parse(await readFile(join(dataDir, 'snapshot-source-v1.json'), 'utf8'));
}

export async function persistSourceState(dataDir, state) {
  return persistJson(dataDir, 'snapshot-source-v1.json', state);
}

// The caller validates the candidate before writing and swaps live state only
// after this succeeds. Both files reside in the same directory/filesystem.
export async function persistSnapshot(dataDir, snapshot) {
  return persistJson(dataDir, 'snapshot-v1.json', snapshot);
}

async function persistJson(dataDir, name, value) {
  const json = JSON.stringify(value);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporaryPath = join(dataDir, `.${name}-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporaryPath, 'wx', 0o600);
    await file.writeFile(json, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, join(dataDir, name));
  } finally {
    await file?.close();
    await unlink(temporaryPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
