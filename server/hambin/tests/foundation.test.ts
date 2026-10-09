import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { config } from "../config.ts";
import { profile } from "../db.ts";
import { authError } from "../auth.ts";
import { ApiError } from "../errors.ts";
import { createApplication } from "../app.ts";
const configuration = config({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost/test",
  FIREBASE_PROJECT_ID: "demo-hambin",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
});
test("production cannot opt into unsigned emulator auth or mismatched project config", () => {
  assert.throws(() =>
    config({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://localhost/db",
      FIREBASE_PROJECT_ID: "demo-hambin",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    }),
  );
  assert.throws(() =>
    config({ NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/db" }),
  );
  assert.throws(() => config({
    NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/db",
    FIREBASE_PROJECT_ID: "demo-hambin", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    TURN_SHARED_SECRET: "too-short",
  }));
  assert.throws(() => config({
    NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/db",
    FIREBASE_PROJECT_ID: "demo-hambin", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    TURN_URLS: "https://example.invalid",
  }));
  assert.deepEqual(config({
    NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/db",
    FIREBASE_PROJECT_ID: "demo-hambin", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    TURN_URLS: "stun:turn.example.org:3478,turn:turn.example.org:3478?transport=udp",
    TURN_SHARED_SECRET: "01234567890123456789012345678901",
  }).turnUrls, ["stun:turn.example.org:3478", "turn:turn.example.org:3478?transport=udp"]);
});
test("profile preserves Unicode rune and UTF8 byte limits", () => {
  assert.equal(
    profile({ name: " 😀 ", avatar: "a", language: "en" }).name,
    "😀",
  );
  assert.doesNotThrow(() =>
    profile({ name: "😀".repeat(48), avatar: "a", language: "en" }),
  );
  assert.throws(() =>
    profile({ name: "😀".repeat(49), avatar: "a", language: "en" }),
  );
  assert.throws(() =>
    profile({ name: "a", avatar: "😀".repeat(9), language: "en" }),
  );
});
test("auth distinguishes rejected credential from provider outage", () => {
  assert.equal(
    authError({ code: "auth/id-token-revoked" }).code,
    "SESSION_REVOKED",
  );
  assert.equal(
    authError({ code: "auth/id-token-expired" }).code,
    "SESSION_EXPIRED",
  );
  assert.equal(authError({ code: "auth/invalid-id-token" }).status, 401);
  assert.equal(authError({ code: "app/network-error" }).status, 503);
});
test("HTTP mandatory auth, fail-closed outage, readiness, bootstrap and disabled stock routes", async () => {
  let ready = true;
  let revoked = false;
  const identities = new Map();
  const value = {
    id: "internal-uuid",
    name: "A",
    avatar: "a",
    language: "en",
    createdAt: "now",
    updatedAt: "now",
  };
  const app = createApplication(configuration, {
    auth: {
      async verify(token) {
        if (token === "unexpected")
          throw new Error("private detail must not be returned");
        if (token === "outage") throw new ApiError(503, "AUTH_UNAVAILABLE");
        if (token !== "valid") throw new ApiError(401, "INVALID_TOKEN");
        return {
          uid: "firebase-not-uuid",
          token,
          expiresAt: Date.now() + 60000,
          authTime: Date.now(),
        };
      },
      async revoke() {
        revoked = true;
      },
    },
    identities: {
      async bootstrap(uid, profile) {
        if (!identities.has(uid)) identities.set(uid, { ...value, ...profile });
        return identities.get(uid);
      },
      async get(uid) {
        return identities.get(uid);
      },
      async update(uid, profile) {
        return { ...identities.get(uid), ...profile };
      },
    },
    databaseReady: async () => ready,
  });
  const server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, token = "valid", body?: unknown) =>
    fetch(base + path, {
      method: body !== undefined ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await fetch(base + "/v1/capabilities")).status, 401);
    assert.equal((await request("/v1/capabilities", "forged")).status, 401);
    assert.equal((await request("/v1/capabilities", "outage")).status, 503);
    const unexpected = await request("/v1/capabilities", "unexpected");
    assert.equal(unexpected.status, 500);
    assert.deepEqual(await unexpected.json(), {
      code: "INTERNAL_ERROR",
      message: "INTERNAL_ERROR",
    });
    assert.deepEqual(await (await request("/v1/capabilities")).json(), {
      protocolVersion: 2,
      realtime: [],
      voice: [],
    });
    assert.equal((await request("/createRoom", "valid", {})).status, 404);
    assert.equal((await request("/proxy")).status, 404);
    const first = await (
      await request("/v1/identities/bootstrap", "valid", {
        name: "Alice",
        avatar: "a",
        language: "en",
      })
    ).json();
    const again = await (
      await request("/v1/identities/bootstrap", "valid", {
        name: "Bob",
        avatar: "b",
        language: "fa",
      })
    ).json();
    assert.deepEqual(first, again);
    assert.equal((await fetch(base + "/readyz")).status, 200);
    ready = false;
    assert.equal((await fetch(base + "/readyz")).status, 503);
    assert.equal(
      (await request("/v1/guest-sessions/revoke", "valid", {})).status,
      204,
    );
    assert.ok(revoked);
    app.drain();
    assert.equal((await request("/v1/capabilities")).status, 503);
  } finally {
    app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
