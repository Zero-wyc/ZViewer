import { AppDataSource } from '../../data-source';
import { BilibiliCredential } from '../../entities/BilibiliCredential';

const credentialRepository = () =>
  AppDataSource.getRepository(BilibiliCredential);

function encrypt(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decrypt(text: string): string {
  return Buffer.from(text, 'base64').toString('utf8');
}

export async function getCredential(
  userId: string,
): Promise<{ cookie: string; refreshToken?: string } | null> {
  const credential = await credentialRepository().findOneBy({ userId });
  if (!credential) return null;

  return {
    cookie: decrypt(credential.cookie),
    refreshToken: credential.refreshToken
      ? decrypt(credential.refreshToken)
      : undefined,
  };
}

export async function saveCredential(
  userId: string,
  cookie: string,
  refreshToken?: string,
): Promise<void> {
  const repository = credentialRepository();
  let credential = await repository.findOneBy({ userId });

  if (credential) {
    credential.cookie = encrypt(cookie);
    credential.refreshToken = refreshToken ? encrypt(refreshToken) : null;
  } else {
    credential = new BilibiliCredential();
    credential.userId = userId;
    credential.cookie = encrypt(cookie);
    credential.refreshToken = refreshToken ? encrypt(refreshToken) : null;
  }

  await repository.save(credential);
}

export async function clearCredential(userId: string): Promise<void> {
  await credentialRepository().delete({ userId });
}
