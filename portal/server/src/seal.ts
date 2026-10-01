import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Encrypted, tamper-proof cookie values (AES-256-GCM). The payload carries
// its own expiry, so a stolen-and-replayed cookie stops working on time.
export interface Sealer {
  seal(value: object, ttlSeconds: number): string;
  unseal<T>(token: string | undefined): T | null;
}

export function createSealer(secret: string, now: () => number = Date.now): Sealer {
  const key = createHash("sha256").update(secret).digest();
  return {
    seal(value, ttlSeconds) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const plaintext = JSON.stringify({ v: value, exp: Math.floor(now() / 1000) + ttlSeconds });
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
    },
    unseal<T>(token: string | undefined): T | null {
      if (!token) return null;
      try {
        const raw = Buffer.from(token, "base64url");
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
        const { v, exp } = JSON.parse(plaintext) as { v: T; exp: number };
        return exp > Math.floor(now() / 1000) ? v : null;
      } catch {
        return null;
      }
    },
  };
}
