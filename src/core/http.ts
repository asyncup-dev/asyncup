import type { Request } from 'express';

/** `Authorization: Bearer <token>` → token, else undefined. */
export function bearerToken(req: Request): string | undefined {
  return req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
}

/** Raw value of one cookie from the Cookie header, else undefined. */
export function readCookie(req: Request, name: string): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
