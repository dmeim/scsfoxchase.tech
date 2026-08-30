import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBuildSha } from './build-metadata.mjs';

export const SERVICE_WORKER_BUILD_PLACEHOLDER = '__SERVICE_WORKER_BUILD_SHA__';

export async function stampServiceWorker({
  filePath = resolve(process.cwd(), 'dist/client/sw.js'),
  buildSha = resolveBuildSha(),
} = {}) {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(buildSha)) {
    throw new Error(`Invalid service-worker build SHA: ${buildSha}`);
  }

  const source = await readFile(filePath, 'utf8');
  const placeholderCount = source.split(SERVICE_WORKER_BUILD_PLACEHOLDER).length - 1;
  if (placeholderCount !== 1) {
    throw new Error(
      `Expected one ${SERVICE_WORKER_BUILD_PLACEHOLDER} placeholder in ${filePath}; found ${placeholderCount}`,
    );
  }

  const stamped = source.replace(SERVICE_WORKER_BUILD_PLACEHOLDER, buildSha);
  await writeFile(filePath, stamped, 'utf8');
  return { buildSha, filePath };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  const { buildSha, filePath } = await stampServiceWorker();
  console.log(`Stamped ${filePath} with service-worker cache version ${buildSha}`);
}
