import { createServer, type Server } from "node:http";
import { config, type Config } from "./config.ts";
import { createAuth, type FirebaseProvider } from "./auth.ts";
import { pool, migrate, IdentityStore } from "./db.ts";
import { createApplication } from "./app.ts";
export async function start(configuration: Config = config()) {
  const db = pool(configuration.databaseUrl);
  db.on("error", () =>
    console.error(JSON.stringify({ event: "database_pool_error" })),
  );
  let auth: FirebaseProvider | undefined;
  let application: ReturnType<typeof createApplication> | undefined;
  let server: Server | undefined;
  const cleanup = async () => {
    application?.drain();
    if (server?.listening) {
      const deadline = setTimeout(() => server?.closeAllConnections(), 5000);
      deadline.unref();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      clearTimeout(deadline);
    }
    application?.close();
    try {
      await auth?.close();
    } finally {
      await db.end();
    }
  };
  try {
    auth = await createAuth(configuration);
    await migrate(db);
    await db.query("SELECT 1");
    application = createApplication(configuration, {
      auth,
      identities: new IdentityStore(db),
      databaseReady: async () => {
        await db.query("SELECT 1");
        return true;
      },
    });
    server = createServer(application.app);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server!.off("listening", onListen);
        reject(error);
      };
      const onListen = () => {
        server!.off("error", onError);
        resolve();
      };
      server!.once("error", onError);
      server!.once("listening", onListen);
      server!.listen(configuration.port, configuration.host);
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  console.log(
    JSON.stringify({
      event: "hambin_started",
      port: configuration.port,
      auth: configuration.emulatorHost ? "emulator" : "firebase",
    }),
  );
  let stopping = false;
  const signalStop = () => void stop();
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    process.off("SIGTERM", signalStop);
    process.off("SIGINT", signalStop);
    await cleanup();
  };
  process.once("SIGTERM", signalStop);
  process.once("SIGINT", signalStop);
  return { server, application, db, auth, stop };
}
