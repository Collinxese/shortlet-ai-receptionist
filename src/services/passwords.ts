import { argon2id, hash, verify } from 'argon2';

export function hashPassword(password: string): Promise<string> {
  // Argon2 generates a fresh random salt and stores its parameters in each hash.
  return hash(password, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
