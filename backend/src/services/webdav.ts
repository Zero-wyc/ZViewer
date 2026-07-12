import { Connection } from 'webdav-client';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const DEFAULT_TIMEOUT = 10000; // 10 秒

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时`)), DEFAULT_TIMEOUT),
    ),
  ]);
}

export interface WebDAVConnectionParams {
  serverUrl: string;
  path: string;
  username?: string;
  password?: string;
}

export interface WebDAVFileInfo {
  name: string;
  path: string;
  size: number;
  lastModified?: Date;
}

function normalizePath(path: string): string {
  let normalized = path.trim();
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  return normalized;
}

function normalizeServerUrl(url: string): string {
  let normalized = url.trim();
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function createConnection(params: WebDAVConnectionParams): Connection {
  return new Connection({
    url: normalizeServerUrl(params.serverUrl),
    username: params.username || undefined,
    password: params.password || undefined,
  });
}

export async function statWebDAVFile(
  params: WebDAVConnectionParams,
): Promise<WebDAVFileInfo> {
  return withTimeout(
    (async () => {
      const connection = createConnection(params);
      const getProperties = promisify(connection.getProperties.bind(connection));
      const props = (await getProperties(normalizePath(params.path))) as {
        size?: number | string;
        getlastmodified?: string;
        displayname?: string;
      };

      const size =
        typeof props.size === 'number'
          ? props.size
          : Number(props.size) || 0;
      const name =
        props.displayname || params.path.split('/').filter(Boolean).pop() || '';

      return {
        name,
        path: params.path,
        size,
        lastModified: props.getlastmodified
          ? new Date(props.getlastmodified)
          : undefined,
      };
    })(),
    'WebDAV 连接',
  );
}

export function createWebDAVReadStream(
  params: WebDAVConnectionParams,
): Readable {
  const connection = createConnection(params);
  return connection.get(normalizePath(params.path)) as Readable;
}

export interface WebDAVDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  lastModified?: Date;
}

export async function listWebDAVDirectory(
  params: WebDAVConnectionParams,
  targetPath?: string,
): Promise<WebDAVDirectoryEntry[]> {
  return withTimeout(
    (async () => {
      try {
        const connection = createConnection(params);
        const listPath = targetPath
          ? normalizePath(targetPath)
          : params.path.endsWith('/')
            ? normalizePath(params.path)
            : normalizePath(params.path.split('/').slice(0, -1).join('/') || '/');
        const readdir = promisify(
          connection.readdir.bind(connection) as (
            path: string,
            options: { properties?: boolean; extraProperties?: unknown[] },
            callback: (error: Error, files?: unknown[]) => void,
          ) => void,
        );
        const entries = (await readdir(listPath, {
          properties: true,
          extraProperties: [],
        })) as Array<{
          name?: string;
          href?: string;
          isDirectory?: boolean;
          size?: number;
          lastModified?: Date;
        }>;
        return entries.map((entry) => ({
          name: entry.name || '',
          path: entry.href || '',
          type: entry.isDirectory ? 'directory' : 'file',
          size: typeof entry.size === 'number' ? entry.size : undefined,
          lastModified: entry.lastModified,
        }));
      } catch (err) {
        throw new Error(
          '无法列出 WebDAV 目录: ' + (err instanceof Error ? err.message : String(err)),
        );
      }
    })(),
    'WebDAV 连接',
  );
}
