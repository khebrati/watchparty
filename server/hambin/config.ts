export interface Config {
  environment: string;
  host: string;
  port: number;
  databaseUrl: string;
  projectId: string;
  emulatorHost?: string;
  trustedProxies: string[];
}
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const environment = env.NODE_ENV ?? "development";
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId || !/^[a-z][a-z0-9-]{4,62}$/.test(projectId))
    throw new Error("FIREBASE_PROJECT_ID is required");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (
    env.FIREBASE_AUTH_EMULATOR_HOST &&
    environment !== "development" &&
    environment !== "test"
  )
    throw new Error("Auth Emulator is forbidden outside development/test");
  if (
    env.FIREBASE_AUTH_EMULATOR_HOST &&
    !/^[a-zA-Z0-9.-]+:[0-9]+$/.test(env.FIREBASE_AUTH_EMULATOR_HOST)
  )
    throw new Error("Invalid emulator address");
  if (!env.FIREBASE_AUTH_EMULATOR_HOST && !env.GOOGLE_APPLICATION_CREDENTIALS)
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS must point to an external Admin credential",
    );
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid PORT");
  return {
    environment,
    projectId,
    emulatorHost: env.FIREBASE_AUTH_EMULATOR_HOST,
    databaseUrl: env.DATABASE_URL,
    host: env.HOST ?? "127.0.0.1",
    port,
    trustedProxies: (env.TRUSTED_PROXIES ?? "").split(",").filter(Boolean),
  };
}
