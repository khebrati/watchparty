import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { config } from "../config.ts";
import { createAuth } from "../auth.ts";
import { pool, migrate, IdentityStore } from "../db.ts";
import { start } from "../main.ts";
import { createApplication } from "../app.ts";
const enabled = process.env.HAMBIN_INTEGRATION === "true";
test(
  "real Auth Emulator and PostgreSQL: auth failures, concurrent durable bootstrap, refresh, revocation and disabled users",
  { skip: !enabled },
  async () => {
    const configuration = config();
    assert.ok(
      configuration.emulatorHost,
      "Integration requires local emulator",
    );
    const db = pool(configuration.databaseUrl);
    await migrate(db);
    const auth = await createAuth(configuration);
    const store = new IdentityStore(db);
    const app = createApplication(configuration, {
      auth,
      identities: store,
      databaseReady: async () => {
        await db.query("SELECT 1");
        return true;
      },
    });
    const server = createServer(app.app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const signup = async () => {
      const result = await fetch(
        `http://${configuration.emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-test-key`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ returnSecureToken: true }),
        },
      );
      assert.equal(result.status, 200);
      return result.json() as Promise<{
        idToken: string;
        refreshToken: string;
        localId: string;
      }>;
    };
    const request = (token: string, body?: unknown) =>
      fetch(base + "/v1/identities/bootstrap", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          body ?? { name: "Alice", avatar: "a", language: "en" },
        ),
      });
    const altered = (token: string, patch: Record<string, unknown>) => {
      const parts = token.split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      return `${parts[0]}.${Buffer.from(JSON.stringify({ ...payload, ...patch })).toString("base64url")}.`;
    };
    try {
      const occupiedPort = (server.address() as { port: number }).port;
      const taggedUrl = new URL(configuration.databaseUrl);
      taggedUrl.searchParams.set("application_name", "hambin-failed-start");
      await assert.rejects(
        start({
          ...configuration,
          port: occupiedPort,
          databaseUrl: taggedUrl.toString(),
        }),
        { code: "EADDRINUSE" },
      );
      const leaked = await db.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='hambin-failed-start'",
      );
      assert.equal(leaked.rows[0].count, 0, "failed startup must close pool");
      const running = await start({ ...configuration, port: 0 });
      try {
        const actualPort = (running.server!.address() as { port: number }).port;
        assert.equal(
          (await fetch(`http://127.0.0.1:${actualPort}/healthz`)).status,
          200,
        );
        assert.equal(
          (await fetch(`http://127.0.0.1:${actualPort}/readyz`)).status,
          200,
        );
      } finally {
        await running.stop();
      }

      const user = await signup();
      const responses = await Promise.all(
        Array.from({ length: 15 }, () => request(user.idToken)),
      );
      for (const result of responses) assert.equal(result.status, 200);
      const values = await Promise.all(responses.map((x) => x.json()));
      const ids = new Set(values.map((x) => x.identity.id));
      assert.equal(ids.size, 1);
      assert.notEqual(values[0].identity.id, user.localId);
      assert.equal(
        (await request(altered(user.idToken, { aud: "wrong-project" }))).status,
        401,
      );
      assert.equal(
        (
          await request(
            altered(user.idToken, {
              iss: "https://securetoken.google.com/wrong-project",
            }),
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await request(
            altered(user.idToken, { exp: Math.floor(Date.now() / 1000) - 5 }),
          )
        ).status,
        401,
      );
      assert.equal((await request("forged")).status, 401);
      const refresh = await fetch(
        `http://${configuration.emulatorHost}/securetoken.googleapis.com/v1/token?key=local-test-key`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: user.refreshToken,
          }),
        },
      );
      assert.equal(refresh.status, 200);
      const refreshed = await refresh.json();
      assert.equal(refreshed.user_id, user.localId);
      const result = await (await request(refreshed.id_token)).json();
      assert.equal(result.identity.id, values[0].identity.id);
      const secondPool = pool(configuration.databaseUrl);
      try {
        await migrate(secondPool);
        assert.equal(
          (await new IdentityStore(secondPool).get(user.localId)).id,
          values[0].identity.id,
        );
      } finally {
        await secondPool.end();
      }
      await auth.auth.updateUser(user.localId, { disabled: true });
      assert.equal((await request(user.idToken)).status, 401);
      const revoked = await signup();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await auth.revoke(revoked.localId);
      assert.equal((await request(revoked.idToken)).status, 401);
    } finally {
      app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await auth.close();
      await db.end();
    }
  },
);
