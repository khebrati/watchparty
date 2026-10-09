import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import type { AuthProvider, Session } from "./auth.ts";
import type { Config } from "./config.ts";
import { ApiError } from "./errors.ts";
import type { Rooms } from "./rooms.ts";

interface Ticket {
  uid: string;
  session: Session;
  membershipId: string;
  roomId: string;
  generation: string;
  expires: number;
}
interface VoiceConnection extends Ticket {
  socket: Socket;
  muted: boolean;
  tokens: number;
  tokenAt: number;
  verifiedAt: number;
}
interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

const jsonError = (error: unknown) => error instanceof ApiError
  ? { code: error.code, message: error.message }
  : { code: "INTERNAL_ERROR", message: "Internal server error" };

/** Mesh signaling and voice role leases. This deliberately owns no media. */
export class MeshVoice {
  readonly available: boolean;
  readonly tickets = new Map<string, Ticket>();
  readonly connections = new Map<string, VoiceConnection>();
  private readonly generations = new Map<string, string>();
  private readonly muted = new Map<string, boolean>();
  private closing = false;
  private pendingDetaches = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly io: Server;
  private readonly rooms: Rooms;
  private readonly auth: AuthProvider;
  private readonly configuration: Config;
  private authFlights = new Map<VoiceConnection, Promise<void>>();

  constructor(
    io: Server,
    rooms: Rooms,
    auth: AuthProvider,
    configuration: Config,
  ) {
    this.io = io;
    this.rooms = rooms;
    this.auth = auth;
    this.configuration = configuration;
    this.available = configuration.turnUrls.some((url) => /^turns?:/i.test(url)) &&
      !!configuration.turnSecret && Buffer.byteLength(configuration.turnSecret) >= 32;
    const beforeRemoved = rooms.onMembershipRemoved;
    rooms.onMembershipRemoved = (id) => {
      beforeRemoved?.(id);
      this.removeMembership(id);
    };
    const beforeClosed = rooms.onRoomClosed;
    rooms.onRoomClosed = (id) => {
      beforeClosed?.(id);
      this.removeRoom(id);
    };
    if (this.available) {
      const namespace = io.of(/^\/hambin\/voice\/[0-9a-f-]{36}$/i);
      namespace.use((socket, next) => void this.admit(socket, next));
      namespace.on("connection", (socket) => void this.connect(socket));
      this.timer = setInterval(() => void this.maintain().catch(() => {
        console.error(JSON.stringify({ event: "voice_maintenance_failed" }));
      }), 10000);
      this.timer.unref();
    }
  }

  async issue(uid: string, session: Session, roomId: string, requested?: string) {
    if (this.closing || !this.available || !this.configuration.turnSecret)
      throw new ApiError(503, "VOICE_DISABLED");
    const member = await this.rooms.ticketMembership(uid, roomId);
    const key = member.id;
    let generation = this.generations.get(key);
    if (requested) {
      const active = this.connections.get(key);
      if (!generation || generation !== requested || !active?.socket.connected || active.generation !== requested)
        throw new ApiError(409, "VOICE_SESSION_EXPIRED");
    } else {
      generation = randomUUID();
      this.generations.set(key, generation);
      this.tickets.forEach((ticket, secret) => {
        if (ticket.membershipId === key) this.tickets.delete(secret);
      });
      const old = this.connections.get(key);
      if (old) old.socket.disconnect(true);
    }
    const ticket = randomBytes(32).toString("base64url");
    const expires = Date.now() + 30000;
    // A membership can hold only its newest, short-lived credential.
    for (const [secret, existing] of this.tickets)
      if (existing.membershipId === key) this.tickets.delete(secret);
    if (this.tickets.size >= 10000) throw new ApiError(429, "RATE_LIMITED");
    this.tickets.set(ticket, {
      uid, session, membershipId: key, roomId, generation, expires,
    });
    const iceExpires = Math.floor(Date.now() / 1000) + 600;
    const username = `${iceExpires}:${createHmac("sha256", this.configuration.turnSecret)
      .update(`${key}:${generation}`).digest("hex").slice(0, 24)}`;
    const credential = createHmac("sha1", this.configuration.turnSecret)
      .update(username).digest("base64");
    const iceServers: IceServer[] = [{ urls: this.configuration.turnUrls.filter((url) => /^stun:/i.test(url)) }];
    if (!iceServers[0].urls.length) iceServers.pop();
    iceServers.push({ urls: this.configuration.turnUrls.filter((url) => /^turns?:/i.test(url)), username, credential });
    return {
      mode: "MESH",
      roomId,
      membershipId: key,
      voiceSessionId: generation,
      namespace: `/hambin/voice/${roomId}`,
      ticket,
      iceServers,
      iceExpiresAt: new Date(iceExpires * 1000).toISOString(),
    };
  }

  private async admit(socket: Socket, next: (error?: Error) => void) {
    try {
      const packet = socket.handshake.auth;
      if (packet?.protocolVersion !== 2 || typeof packet.ticket !== "string")
        throw new ApiError(401, "INVALID_TICKET");
      const ticket = this.tickets.get(packet.ticket);
      this.tickets.delete(packet.ticket);
      const roomId = socket.nsp.name.slice("/hambin/voice/".length);
      if (!ticket || ticket.expires <= Date.now() || ticket.roomId !== roomId)
        throw new ApiError(401, "INVALID_TICKET");
      const session = await this.auth.verify(ticket.session.token);
      if (session.uid !== ticket.uid || this.generations.get(ticket.membershipId) !== ticket.generation)
        throw new ApiError(401, "INVALID_TICKET");
      socket.data.voiceTicket = { ...ticket, session } satisfies Ticket;
      next();
    } catch (error) {
      const data = jsonError(error);
      const rejected = new Error(data.code) as Error & { data?: unknown };
      rejected.data = data;
      next(rejected);
    }
  }

  private async connect(socket: Socket) {
    if (this.closing) return socket.disconnect(true);
    const ticket = socket.data.voiceTicket as Ticket;
    const key = ticket.membershipId;
    const current = this.connections.get(key);
    // A credential refresh does not authorize a second socket for the same
    // generation; reconnect requires a new generation from the REST endpoint.
    if (current?.socket.connected && current.generation === ticket.generation)
      return socket.disconnect(true);
    const connection: VoiceConnection = {
      ...ticket,
      socket,
      muted: this.muted.get(key) ?? true,
      tokens: 60,
      tokenAt: Date.now(),
      verifiedAt: Date.now(),
    };
    try {
      await this.rooms.attach(ticket.uid, ticket.roomId, key, "voice", ticket.generation);
      if (this.closing || this.generations.get(key) !== ticket.generation || !socket.connected)
        throw new ApiError(401, "SESSION_EXPIRED");
      this.connections.set(key, connection);
      const prior = socket.nsp.sockets;
      for (const peer of prior.values()) {
        const other = peer.data.voiceConnection as VoiceConnection | undefined;
        if (other?.membershipId === key && other !== connection) peer.disconnect(true);
      }
      socket.data.voiceConnection = connection;
      socket.on("disconnect", () => {
        if (this.connections.get(key) === connection) this.connections.delete(key);
        this.authFlights.delete(connection);
        this.detach(ticket.uid, ticket.roomId, key, ticket.generation);
        this.broadcastRoster(ticket.roomId);
      });
      socket.on("voice.mute", (body: unknown, ack?: (value: unknown) => void) =>
        void this.mute(connection, body, ack));
      socket.on("auth.refresh", (body: unknown, ack?: (value: unknown) => void) =>
        void this.refresh(connection, body, ack));
      socket.on("signal", (body: unknown, ack?: (value: unknown) => void) =>
        void this.signal(connection, body, ack));
      // Existing peers get one update; the newcomer gets one initial snapshot.
      socket.broadcast.emit("voice.roster", this.roster(ticket.roomId));
      socket.emit("voice.roster", this.roster(ticket.roomId));
    } catch (error) {
      await this.rooms.detach(ticket.uid, ticket.roomId, key, "voice", ticket.generation).catch(() => {});
      socket.emit("error", jsonError(error));
      socket.disconnect(true);
    }
  }

  private roster(roomId: string) {
    return { members: [...this.connections.values()]
      .filter((peer) => peer.roomId === roomId && peer.socket.connected)
      .map((peer) => ({ membershipId: peer.membershipId, voiceSessionId: peer.generation, muted: peer.muted })) };
  }
  private broadcastRoster(roomId: string) {
    this.io.of(`/hambin/voice/${roomId}`).emit("voice.roster", this.roster(roomId));
  }

  private async mute(connection: VoiceConnection, body: unknown, ack?: (value: unknown) => void) {
    try {
      await this.authorize(connection);
      if (!body || typeof body !== "object" || typeof (body as any).muted !== "boolean")
        throw new ApiError(400, "INVALID_JSON");
      connection.muted = (body as any).muted;
      this.muted.set(connection.membershipId, connection.muted);
      this.broadcastRoster(connection.roomId);
      ack?.({ ok: true });
    } catch (error) { ack?.(jsonError(error)); }
  }

  private async signal(connection: VoiceConnection, body: unknown, ack?: (value: unknown) => void) {
    try {
      await this.authorize(connection);
      if (!body || typeof body !== "object" || typeof (body as any).to !== "string" || !/^[0-9a-f-]{36}$/i.test((body as any).to) || typeof (body as any).msg !== "string")
        throw new ApiError(400, "INVALID_JSON");
      const bytes = Buffer.byteLength((body as any).msg, "utf8");
      if (bytes > 65536) throw new ApiError(413, "PAYLOAD_TOO_LARGE");
      const now = Date.now();
      connection.tokens = Math.min(60, connection.tokens + Math.max(0, now - connection.tokenAt) * 0.02);
      connection.tokenAt = now;
      if (connection.tokens < 1) throw new ApiError(429, "RATE_LIMITED");
      connection.tokens -= 1;
      let message: any;
      try { message = JSON.parse((body as any).msg); } catch { throw new ApiError(400, "INVALID_JSON"); }
      if (!message || message.generation !== connection.generation || typeof message.targetGeneration !== "string")
        throw new ApiError(401, "SESSION_EXPIRED");
      const content = message.sdp ?? message.ice;
      if (Number(!!message.sdp) + Number(!!message.ice) + Number(message.restart === true) !== 1)
        throw new ApiError(400, "INVALID_JSON");
      if (message.sdp && (typeof content.sdp !== "string" || Buffer.byteLength(content.sdp) > 60000 || !["offer", "answer", "pranswer", "rollback"].includes(content.type)))
        throw new ApiError(400, "INVALID_JSON");
      if (message.ice && (typeof content.candidate !== "string" || content.candidate.length > 4096 || (content.sdpMid !== null && typeof content.sdpMid !== "string") || (content.sdpMLineIndex !== null && !Number.isInteger(content.sdpMLineIndex))))
        throw new ApiError(400, "INVALID_JSON");
      if (!message.sdp && !message.ice && message.restart !== true)
        throw new ApiError(400, "INVALID_JSON");
      const target = this.connections.get((body as any).to);
      if (!target || target.roomId !== connection.roomId || target.membershipId === connection.membershipId || target.generation !== message.targetGeneration)
        throw new ApiError(403, "FORBIDDEN");
      await this.rooms.active(connection.uid, connection.roomId, connection.membershipId, "voice", connection.generation);
      await this.rooms.active(target.uid, target.roomId, target.membershipId, "voice", target.generation);
      target.socket.emit("signal", { from: connection.membershipId, msg: (body as any).msg });
      ack?.({ ok: true });
    } catch (error) { ack?.(jsonError(error)); }
  }

  private async authorize(connection: VoiceConnection) {
    if (this.closing || !connection.socket.connected || this.connections.get(connection.membershipId) !== connection)
      throw new ApiError(401, "SESSION_EXPIRED");
    if (connection.session.expiresAt <= Date.now()) throw new ApiError(401, "SESSION_EXPIRED");
    await this.verifyFresh(connection);
    await this.rooms.active(connection.uid, connection.roomId, connection.membershipId, "voice", connection.generation);
  }

  private async verifyFresh(connection: VoiceConnection) {
    if (Date.now() - connection.verifiedAt < 60000) return;
    let flight = this.authFlights.get(connection);
    if (!flight) {
      flight = (async () => {
        const session = await this.auth.verify(connection.session.token);
        if (session.uid !== connection.uid) throw new ApiError(401, "INVALID_TOKEN");
        connection.session = session;
        connection.verifiedAt = Date.now();
      })();
      this.authFlights.set(connection, flight);
    }
    try { await flight; } finally {
      if (this.authFlights.get(connection) === flight) this.authFlights.delete(connection);
    }
  }

  private detach(uid: string, roomId: string, membershipId: string, generation: string) {
    const task = this.rooms.detach(uid, roomId, membershipId, "voice", generation).catch(() => {});
    this.pendingDetaches.add(task);
    void task.finally(() => this.pendingDetaches.delete(task));
  }

  private async refresh(connection: VoiceConnection, body: unknown, ack?: (value: unknown) => void) {
    try {
      if (this.closing || !connection.socket.connected || this.connections.get(connection.membershipId) !== connection)
        throw new ApiError(401, "SESSION_EXPIRED");
      if (!body || typeof body !== "object" || typeof (body as any).idToken !== "string")
        throw new ApiError(401, "INVALID_TOKEN");
      const session = await this.auth.verify((body as any).idToken);
      if (session.uid !== connection.uid) throw new ApiError(401, "INVALID_TOKEN");
      connection.session = session;
      connection.verifiedAt = Date.now();
      await this.rooms.active(connection.uid, connection.roomId, connection.membershipId, "voice", connection.generation);
      ack?.({ expiresAt: new Date(session.expiresAt).toISOString() });
    } catch (error) { ack?.(jsonError(error)); }
  }

  private async maintain() {
    if (this.closing) return;
    for (const [secret, ticket] of this.tickets) if (ticket.expires <= Date.now()) this.tickets.delete(secret);
    const active = [...this.connections.values()];
    if (!active.length) return;
    const renewed = await this.rooms.renewLeases(active.map((connection) => ({ membershipId: connection.membershipId, role: "voice" as const, generation: connection.generation })));
    for (const connection of active) {
      if (!renewed.has(connection.membershipId)) connection.socket.disconnect(true);
      else if (Date.now() - connection.verifiedAt >= 60000) {
        try {
          await this.verifyFresh(connection);
        } catch (error) {
          // Provider outages suspend protected signaling but do not tear down
          // already-negotiated media. Invalid/revoked credentials do disconnect.
          if (!(error instanceof ApiError && error.status === 503))
            connection.socket.disconnect(true);
        }
      }
    }
  }

  private removeMembership(id: string) {
    this.generations.delete(id);
    this.muted.delete(id);
    for (const [secret, ticket] of this.tickets) if (ticket.membershipId === id) this.tickets.delete(secret);
    this.connections.get(id)?.socket.disconnect(true);
  }
  private removeRoom(roomId: string) {
    const memberships = new Set<string>();
    for (const [secret, ticket] of this.tickets) {
      if (ticket.roomId === roomId) {
        memberships.add(ticket.membershipId);
        this.tickets.delete(secret);
      }
    }
    for (const connection of [...this.connections.values()]) {
      if (connection.roomId !== roomId) continue;
      memberships.add(connection.membershipId);
      connection.socket.disconnect(true);
    }
    for (const id of memberships) {
      this.generations.delete(id);
      this.muted.delete(id);
    }
  }
  revoke(uid: string) {
    for (const [secret, ticket] of this.tickets) if (ticket.uid === uid) this.tickets.delete(secret);
    for (const connection of this.connections.values()) if (connection.uid === uid) connection.socket.disconnect(true);
  }
  drain() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.tickets.clear();
    for (const connection of this.connections.values()) connection.socket.disconnect(true);
  }
  async close() {
    this.drain();
    for (const connection of this.connections.values()) connection.socket.disconnect(true);
    await Promise.allSettled([...this.pendingDetaches]);
    this.connections.clear();
    this.tickets.clear();
  }
}
