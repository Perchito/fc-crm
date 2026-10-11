// Private file storage for documents. Production: perchito-storage project "fc-crm"
// (private, nightly + B2 offsite backup). Tests/dev: DOCS_DIR = a local folder.
// Keys are generated server-side (docs/<yyyy>/<uuid>.<ext>) — never from user input.
import { homeStorage } from './home-storage.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

function localStorage(root) {
  const base = resolve(root);
  const path = (key) => {
    const p = resolve(base, key);
    if (!p.startsWith(base + '/')) throw new Error('bad storage key');
    return p;
  };
  return {
    async put(key, buf) { await mkdir(dirname(path(key)), { recursive: true, mode: 0o700 }); await writeFile(path(key), buf, { mode: 0o600 }); },
    async get(key) { return readFile(path(key)); },
  };
}

function remoteStorage() {
  const s = homeStorage({ url: process.env.HOME_STORAGE_URL || 'http://127.0.0.1:9100', project: process.env.HOME_STORAGE_PROJECT || 'fc-crm', key: process.env.HOME_STORAGE_KEY });
  return {
    async put(key, buf, mime) { await s.put(key, buf, mime); },
    async get(key) {
      const r = await s.get(key);
      if (!r.ok) throw new Error(`document missing from storage (${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

export const storageConfigured = () => !!(process.env.DOCS_DIR || process.env.HOME_STORAGE_KEY);
let _s;
export const storage = () => (_s ??= process.env.DOCS_DIR ? localStorage(process.env.DOCS_DIR) : remoteStorage());
