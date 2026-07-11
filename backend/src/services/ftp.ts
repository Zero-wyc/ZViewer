import { Client } from 'basic-ftp';
import { Readable, PassThrough } from 'node:stream';

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
