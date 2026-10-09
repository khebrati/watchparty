import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
} from "express";
import type { Config } from "./config.ts";
import type { AuthProvider, Session } from "./auth.ts";
import type { Identities } from "./db.ts";
import { profile } from "./db.ts";
import { ApiError } from "./errors.ts";
import type { Rooms } from "./rooms.ts";
export interface AuthenticatedRequest extends Request {
  session: Session;
}
export interface Dependencies {
  auth: AuthProvider;
  rooms?: Rooms;
  issueRoomTicket?(
    uid: string,
    session: Session,
    roomId: string,
  ): Promise<unknown>;
  identities: Identities;
  databaseReady(): Promise<boolean>;
  // Phase 3 installs membership/ticket/socket cleanup, and dispatcher health.
  revokeIdentity?(uid: string): Promise<void>;
  dispatcherReady?(): boolean;
  realtimeAvailable?(): boolean;
  voiceAvailable?(): boolean;
  issueVoiceConfig?(uid: string, session: Session, roomId: string, voiceSessionId?: string): Promise<unknown>;
}
export function createApplication(configuration: Config, deps: Dependencies) {
  const app = express();
  const api = express.Router();
  app.disable("x-powered-by");
  app.set("trust proxy", configuration.trustedProxies);
  const budgets = new Map<string, { count: number; reset: number }>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of budgets)
      if (value.reset <= now) budgets.delete(key);
  }, 60000);
  timer.unref();
  const limit =
    (name: string, max: number): RequestHandler =>
    (req, res, next) => {
      const key = `${name}:${req.ip}`;
      const now = Date.now();
      let budget = budgets.get(key);
      if (!budget || budget.reset <= now) {
        // Bound attacker-controlled client keys; never evict active entries to bypass their budgets.
        if (budgets.size >= 10000)
          return next(new ApiError(429, "RATE_LIMITED"));
        budget = { count: 0, reset: now + 60000 };
        budgets.set(key, budget);
      }
      if (++budget.count > max) {
        res.setHeader("Retry-After", Math.ceil((budget.reset - now) / 1000));
        return next(new ApiError(429, "RATE_LIMITED"));
      }
      next();
    };
  let draining = false;
  app.get("/healthz", limit("health", 600), (req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", limit("health", 600), async (req, res) => {
    let database = false;
    try {
      database = await deps.databaseReady();
    } catch {}
    const dispatcher = deps.dispatcherReady?.() ?? true;
    const ready = !draining && database && dispatcher;
    res.status(ready ? 200 : 503).json({
      ready,
      database,
      dispatcher,
      voice: deps.voiceAvailable?.() ?? false,
    });
  });
  app.use(express.json({ limit: "8kb", strict: true }));
  const authenticate: RequestHandler = async (req, res, next) => {
    if (draining) throw new ApiError(503, "UNAVAILABLE");
    const header = req.get("Authorization");
    if (!header || !/^Bearer [^\s]+$/.test(header))
      throw new ApiError(401, "UNAUTHENTICATED");
    (req as AuthenticatedRequest).session = await deps.auth.verify(
      header.slice(7),
    );
    next();
  };
  api.use(limit("api", 120), authenticate);
  api.post("/identities/bootstrap", limit("profile", 30), async (req, res) => {
    const { uid } = (req as AuthenticatedRequest).session;
    res.json({
      identity: await deps.identities.bootstrap(uid, profile(req.body)),
    });
  });
  api.patch(
    "/guest-sessions/profile",
    limit("profile", 30),
    async (req, res) => {
      res.json({
        identity: await deps.identities.update(
          (req as AuthenticatedRequest).session.uid,
          profile(req.body),
        ),
      });
    },
  );
  api.post("/guest-sessions/revoke", limit("revoke", 10), async (req, res) => {
    const { uid } = (req as AuthenticatedRequest).session;
    await deps.auth.revoke(uid);
    await deps.revokeIdentity?.(uid);
    res.status(204).end();
  });
  api.get("/capabilities", (req, res) => {
    res.json({
      protocolVersion: 2,
      realtime: deps.realtimeAvailable?.() ? ["socket.io"] : [],
      voice: deps.voiceAvailable?.() ? ["MESH"] : [],
    });
  });
  if (deps.rooms) {
    const rooms = deps.rooms;
    const uid = (req: Request) => (req as AuthenticatedRequest).session.uid;
    const key = (req: Request) => req.get("Idempotency-Key");
    const param = (req: Request, name: string) => String(req.params[name]);
    api.post("/rooms", async (req, res) => {
      const result = await rooms.create(uid(req), req.body?.title, key(req));
      res.status(result.status).json(result.body);
    });
    api.get("/rooms/:code/preview", async (req, res) => {
      res.json(await rooms.preview(uid(req), param(req, "code")));
    });
    api.post("/rooms/:code/join", async (req, res) => {
      const result = await rooms.join(uid(req), param(req, "code"), key(req));
      res.status(result.status).json(result.body);
    });
    api.get("/rooms/:roomId/snapshot", async (req, res) => {
      res.json(await rooms.snapshot(uid(req), param(req, "roomId")));
    });
    api.post("/rooms/:roomId/leave", async (req, res) => {
      res.json(await rooms.leave(uid(req), param(req, "roomId")));
    });
    for (const action of ["start", "abort"] as const) {
      api.post(`/rooms/:roomId/stream/${action}`, async (req, res) => {
        const result = await rooms.stream(
          uid(req),
          param(req, "roomId"),
          action,
          req.body ?? {},
          key(req),
        );
        res.status(result.status).json(result.body);
      });
    }
    api.post(
      "/rooms/:roomId/realtime-ticket",
      limit("ticket", 60),
      async (req, res) => {
        if (!deps.issueRoomTicket) throw new ApiError(503, "UNAVAILABLE");
        res
          .status(201)
          .json(
            await deps.issueRoomTicket(
              uid(req),
              (req as AuthenticatedRequest).session,
              param(req, "roomId"),
            ),
          );
      },
    );
    api.post("/rooms/:roomId/voice/config", limit("voice-config", 30), async (req, res) => {
      if (!deps.issueVoiceConfig || !deps.voiceAvailable?.())
        throw new ApiError(503, "VOICE_DISABLED");
      const voiceSessionId = req.body?.voiceSessionId;
      if (voiceSessionId !== undefined && (typeof voiceSessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(voiceSessionId)))
        throw new ApiError(400, "INVALID_JSON");
      res.json(await deps.issueVoiceConfig(
        (req as AuthenticatedRequest).session.uid,
        (req as AuthenticatedRequest).session,
        param(req, "roomId"),
        voiceSessionId,
      ));
    });
  }
  // Clients never receive unavailable capabilities.
  app.use("/v1", api);
  app.use((req, res, next) => next(new ApiError(404, "NOT_FOUND")));
  const errors: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (!(error instanceof ApiError) && !error?.type)
      console.error(JSON.stringify({ event: "internal_error" }));
    const code =
      error?.type === "entity.parse.failed"
        ? new ApiError(400, "INVALID_JSON")
        : error?.type === "entity.too.large"
          ? new ApiError(413, "PAYLOAD_TOO_LARGE")
          : error instanceof ApiError
            ? error
            : new ApiError(500, "INTERNAL_ERROR");
    res.status(code.status).json({ code: code.code, message: code.message });
  };
  app.use(errors);
  return {
    app,
    api,
    authenticate,
    limit,
    drain: () => {
      draining = true;
    },
    close: () => clearInterval(timer),
  };
}
