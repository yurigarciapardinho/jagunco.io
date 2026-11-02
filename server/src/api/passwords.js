// Password credentials for Jagunco accounts. Passwords are never logged or stored directly.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const DEFAULT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });
const MAX_MEMORY = 64 * 1024 * 1024;

export function passwordError(password) {
    if (typeof password !== "string") return "invalidCredentials";
    if (password.length < 10 || password.length > 128) return "weakPassword";
    if (/[\x00-\x1f\x7f]/.test(password)) return "invalidCredentials";
    return null;
}

function encoded(hash, salt, params) {
    return ["scrypt", params.N, params.r, params.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function hashPassword(password) {
    if (passwordError(password)) throw new Error("invalid password");
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, KEY_LENGTH, { ...DEFAULT_PARAMS, maxmem: MAX_MEMORY });
    return encoded(hash, salt, DEFAULT_PARAMS);
}

export async function verifyPassword(password, credential) {
    try {
        if (typeof password !== "string" || password.length > 128 || typeof credential !== "string") return false;
        const [algorithm, n, r, p, saltText, hashText, extra] = credential.split("$");
        if (algorithm !== "scrypt" || extra !== undefined) return false;
        const params = { N: Number(n), r: Number(r), p: Number(p) };
        if (params.N !== DEFAULT_PARAMS.N || params.r !== DEFAULT_PARAMS.r || params.p !== DEFAULT_PARAMS.p) return false;
        const salt = Buffer.from(saltText, "base64url");
        const expected = Buffer.from(hashText, "base64url");
        if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
        const actual = await scryptAsync(password, salt, KEY_LENGTH, { ...params, maxmem: MAX_MEMORY });
        return timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}
