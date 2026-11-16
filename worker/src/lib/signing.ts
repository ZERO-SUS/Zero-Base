interface FileTokenPayload {
  attachmentId: string;
  storageKey: string;
  userId: string;
  exp: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signFileAccessToken(
  payload: Omit<FileTokenPayload, 'exp'>,
  secret: string,
  ttlSeconds = 300
): Promise<{ token: string; expiresAt: string }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const fullPayload: FileTokenPayload = { ...payload, exp };
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(fullPayload)));
  const key = await importHmacKey(secret);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const signature = toBase64Url(new Uint8Array(sigBuffer));
  return {
    token: `${body}.${signature}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export async function verifyFileAccessToken(
  token: string,
  secret: string
): Promise<FileTokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  try {
    const key = await importHmacKey(secret);
    const sigBytes = fromBase64Url(sig);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      new TextEncoder().encode(body)
    );
    if (!valid) return null;

    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as FileTokenPayload;
    if (
      !decoded ||
      typeof decoded.attachmentId !== 'string' ||
      typeof decoded.storageKey !== 'string' ||
      typeof decoded.userId !== 'string' ||
      typeof decoded.exp !== 'number'
    ) {
      return null;
    }

    if (decoded.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}
