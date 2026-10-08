import {
  initializeApp,
  applicationDefault,
  deleteApp,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { ApiError } from "./errors.ts";
export interface Session {
  uid: string;
  expiresAt: number;
  authTime: number;
  token: string;
}
export interface AuthProvider {
  verify(token: string): Promise<Session>;
  revoke(uid: string): Promise<void>;
  close?(): Promise<void>;
}
const invalid = new Set([
  "auth/argument-error",
  "auth/invalid-argument",
  "auth/invalid-id-token",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/user-disabled",
  "auth/user-not-found",
  "auth/tenant-id-mismatch",
]);
export function authError(error: unknown): ApiError {
  const code = (error as { code?: string })?.code;
  if (code === "auth/id-token-revoked" || code === "auth/user-disabled")
    return new ApiError(401, "SESSION_REVOKED");
  if (code === "auth/id-token-expired")
    return new ApiError(401, "SESSION_EXPIRED");
  if (code && invalid.has(code)) return new ApiError(401, "INVALID_TOKEN");
  return new ApiError(503, "AUTH_UNAVAILABLE");
}
export class FirebaseProvider implements AuthProvider {
  readonly auth: Auth;
  readonly app: ReturnType<typeof initializeApp>;
  constructor(configuration: Config) {
    this.app = initializeApp(
      {
        projectId: configuration.projectId,
        ...(configuration.emulatorHost
          ? {}
          : { credential: applicationDefault() }),
      },
      `hambin-${randomUUID()}`,
    );
    this.auth = getAuth(this.app);
  }
  async verify(token: string): Promise<Session> {
    try {
      const decoded = await this.auth.verifyIdToken(token, true);
      return {
        uid: decoded.uid,
        expiresAt: decoded.exp * 1000,
        authTime: decoded.auth_time * 1000,
        token,
      };
    } catch (error) {
      throw authError(error);
    }
  }
  async revoke(uid: string): Promise<void> {
    try {
      await this.auth.revokeRefreshTokens(uid);
    } catch (error) {
      throw authError(error);
    }
  }
  async close() {
    await deleteApp(this.app);
  }
}
export async function createAuth(
  configuration: Config,
): Promise<FirebaseProvider> {
  if (!configuration.emulatorHost) {
    const credentials = JSON.parse(
      await readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"),
    );
    if (
      credentials.project_id !== configuration.projectId ||
      !credentials.private_key ||
      !credentials.client_email
    )
      throw new Error(
        "Admin credential project does not match FIREBASE_PROJECT_ID",
      );
  }
  return new FirebaseProvider(configuration);
}
