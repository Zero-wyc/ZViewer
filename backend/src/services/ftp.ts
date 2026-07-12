import { Client } from 'basic-ftp';
import { Readable, PassThrough } from 'node:stream';

const DEFAULT_TIMEOUT = 10000; // 10 秒

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时`)), DEFAULT_TIMEOUT),
    ),
  ]);
}

export interface FTPConnectionParams {
  serverUrl: string;
  path: string;
  username?: string;
  password?: string;
  port?: number;
}

export interface FTPFileInfo {
  name: string;
  path: string;
  size: number;
  lastModified?: Date;
}

function parseServerUrl(serverUrl: string): { host: string; protocol?: string } {
  const trimmed = serverUrl.trim();
  if (trimmed.startsWith('ftp://') || trimmed.startsWith('ftps://')) {
    const url = new URL(trimmed);
    return { host: url.hostname, protocol: url.protocol };
  }
  return { host: trimmed.replace(/^ftp/i, '').replace(/^:\/\//, '').split('/')[0] };
}

export async function statFTPFile(
  params: FTPConnectionParams,
): Promise<FTPFileInfo> {
  return withTimeout(
    (async () => {
      const client = new Client();
      client.ftp.verbose = false;
      const { host, protocol } = parseServerUrl(params.serverUrl);
      const port = params.port || 21;
      const secure = protocol === 'ftps:';

      try {
        await client.access({
          host,
          port,
          user: params.username || 'anonymous',
          password: params.password || 'anonymous@',
          secure,
        });

        const dir = params.path.split('/').slice(0, -1).join('/') || '/';
        const filename = params.path.split('/').pop() || '';
        await client.cd(dir);
        const list = await client.list();
        const file = list.find((item) => item.name === filename && item.type === 1);
        if (!file) {
          throw new Error('FTP 文件不存在');
        }

        return {
          name: file.name,
          path: params.path,
          size: file.size,
          lastModified: file.modifiedAt,
        };
      } finally {
        client.close();
      }
    })(),
    'FTP 连接',
  );
}

export function createFTPReadStream(params: FTPConnectionParams): Readable {
  const passThrough = new PassThrough();
  const client = new Client();
  client.ftp.verbose = false;
  const { host, protocol } = parseServerUrl(params.serverUrl);
  const port = params.port || 21;
  const secure = protocol === 'ftps:';

  client
    .access({
      host,
      port,
      user: params.username || 'anonymous',
      password: params.password || 'anonymous@',
      secure,
    })
    .then(async () => {
      await client.downloadTo(passThrough, params.path);
    })
    .catch((err) => {
      passThrough.destroy(err);
    })
    .finally(() => {
      client.close();
    });

  return passThrough;
}

export interface FTPDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  lastModified?: Date;
}

export async function listFTPDirectory(
  params: FTPConnectionParams,
  targetPath?: string,
): Promise<FTPDirectoryEntry[]> {
  return withTimeout(
    (async () => {
      const client = new Client();
      client.ftp.verbose = false;
      const { host, protocol } = parseServerUrl(params.serverUrl);
      const port = params.port || 21;
      const secure = protocol === 'ftps:';

      try {
        await client.access({
          host,
          port,
          user: params.username || 'anonymous',
          password: params.password || 'anonymous@',
          secure,
        });

        const dir = targetPath
          ? targetPath
          : params.path.endsWith('/')
            ? params.path
            : params.path.split('/').slice(0, -1).join('/') || '/';
        const list = await client.list(dir);
        return list
          .filter((item) => item.name !== '.' && item.name !== '..')
          .map((item) => ({
            name: item.name,
            path: (dir.endsWith('/') ? dir : dir + '/') + item.name,
            type: item.type === 1 ? 'file' : 'directory',
            size: item.size,
            lastModified: item.modifiedAt,
          }));
      } finally {
        client.close();
      }
    })(),
    'FTP 连接',
  );
}
