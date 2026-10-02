import { randomBytes, createHash } from "node:crypto";

/** URL-safe random id. */
export const randomId = (bytes = 12) => randomBytes(bytes).toString("base64url");

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
