import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Cache identities include all inputs that can change the result. Bump schema when
// synthesis settings or draft semantics change. No credentials enter these files.
export function cacheKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cachePath(root, namespace, key) {
  if (!/^[a-z-]+$/.test(namespace) || !/^[a-f0-9]{64}$/.test(key)) {
    throw new Error("Invalid podcast cache identity");
  }
  return path.join(root, namespace, key);
}

export async function readCache(root, namespace, key) {
  try {
    return await readFile(cachePath(root, namespace, key));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCache(root, namespace, key, value) {
  const target = cachePath(root, namespace, key);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeCache(root, namespace, key) {
  await rm(cachePath(root, namespace, key), { force: true });
}

// Bound the workflow snapshot to 512 MiB. Old entries are expendable, never inputs
// to publication. Pruning happens after generation, including failed generations.
export async function pruneCache(root, maxBytes = 512 * 1024 * 1024) {
  const files = [];
  for (const namespace of await readdir(root).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const directory = path.join(root, namespace);
    if (!(await stat(directory)).isDirectory()) continue;
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const info = await stat(file);
      if (info.isFile()) files.push({ file, size: info.size, age: info.mtimeMs });
    }
  }
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  files.sort((a, b) => a.age - b.age);
  for (const file of files) {
    if (bytes <= maxBytes) break;
    await rm(file.file, { force: true });
    bytes -= file.size;
  }
  return bytes;
}
