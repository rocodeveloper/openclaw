import fs from "node:fs/promises";
import path from "node:path";

type GroupTokenEntry = { token?: unknown; updatedAt?: string };
type TokenStore = { version: 1; groups: Record<string, GroupTokenEntry> };

let writeQueue: Promise<unknown> = Promise.resolve();

function emptyStore(): TokenStore {
  return { version: 1, groups: {} };
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function readStore(file: string): Promise<TokenStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<TokenStore> | null;
    if (parsed?.version !== 1 || typeof parsed?.groups !== "object" || !parsed.groups) {
      throw new Error("unsupported credential store format");
    }
    return parsed as TokenStore;
  } catch (error) {
    if (isMissingFileError(error)) {
      return emptyStore();
    }
    throw error;
  }
}

async function writeStore(file: string, store: TokenStore): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);

  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.catch(() => {});
  return next;
}

export async function getGroupToken(file: string, groupJid: string): Promise<string | null> {
  const store = await readStore(file);
  const token = store.groups[groupJid]?.token;
  return typeof token === "string" && token ? token : null;
}

export async function hasGroupToken(file: string, groupJid: string): Promise<boolean> {
  return Boolean(await getGroupToken(file, groupJid));
}

export async function setGroupToken(file: string, groupJid: string, token: string): Promise<void> {
  return withWriteLock(async () => {
    const store = await readStore(file);
    store.groups[groupJid] = { token, updatedAt: new Date().toISOString() };
    await writeStore(file, store);
  });
}

export async function deleteGroupToken(file: string, groupJid: string): Promise<boolean> {
  return withWriteLock(async () => {
    const store = await readStore(file);
    const existed = Boolean(store.groups[groupJid]);
    if (existed) {
      delete store.groups[groupJid];
      await writeStore(file, store);
    }
    return existed;
  });
}
