import { Connection } from 'webdav-client';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

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
}

export function createWebDAVReadStream(
  params: WebDAVConnectionParams,
): Readable {
  const connection = createConnection(params);
  return connection.get(normalizePath(params.path)) as Readable;
}
