import path from 'node:path';

function numericEnv(key, fallback, min, max) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}

export function config() {
  return {
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://pacs:pacs_dev_only@127.0.0.1:5432/pacs',
    token: process.env.API_TOKEN,
    host: process.env.HTTP_HOST ?? '127.0.0.1',
    port: numericEnv('HTTP_PORT', 3000, 1, 65535),
    maxBytes: numericEnv('PACS_MAX_STOW_BYTES', 67108864, 1, 1073741824),
    storageRoot: path.resolve(process.env.PACS_STORAGE_ROOT ?? './data/objects'),
    inboxRoot: path.resolve(process.env.PACS_INBOX_ROOT ?? './data/inbox'),
    aet: process.env.PACS_AET ?? 'PACS_NATIVE',
    dicomIp: process.env.DICOM_BIND_IP ?? '127.0.0.1',
    dicomPort: numericEnv('DICOM_PORT', 11112, 1, 65535),
    sourcePort: numericEnv('DICOM_SOURCE_PORT', 11113, 1, 65535)
  };
}
