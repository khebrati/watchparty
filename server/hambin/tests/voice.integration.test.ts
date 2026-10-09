import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { config } from "../config.ts";
import { start } from "../main.ts";

const enabled = process.env.HAMBIN_INTEGRATION === "true";
const profile = { name: "Voice tester", avatar: "moon", language: "en" };
const waitEvent = <T>(socket: Socket, name: string) => new Promise<T>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 5000);
  socket.once(name, (value) => { clearTimeout(timeout); resolve(value as T); });
});
const rpc = (socket: Socket, name: string, body: unknown) => new Promise<any>((resolve) => {
  socket.emit(name, body, (result: unknown) => resolve(result));
});

test("voice configuration, ticket lifecycle, independent role, mute and scoped signaling", {
  skip: !enabled,
  timeout: 45000,
}, async () => {
  const baseConfig = config();
  assert.ok(baseConfig.emulatorHost);
  const configuration = {
    ...baseConfig,
    port: 0,
    turnUrls: ["turn:127.0.0.1:3478?transport=udp", "turn:127.0.0.1:3478?transport=tcp"],
    turnSecret: "local-test-turn-shared-secret-32-bytes-minimum",
  };
  const running = await start(configuration);
  const base = `http://127.0.0.1:${(running.server!.address() as { port: number }).port}`;
  const sockets: Socket[] = [];
  const users: { token: string; uid: string }[] = [];
  try {
    const createUser = async () => {
      const auth = await fetch(`http://${configuration.emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-key`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }),
      });
      assert.equal(auth.status, 200);
      const data = await auth.json() as { idToken: string; localId: string };
      const boot = await fetch(base + "/v1/identities/bootstrap", {
        method: "POST", headers: { Authorization: `Bearer ${data.idToken}`, "Content-Type": "application/json" }, body: JSON.stringify(profile),
      });
      assert.equal(boot.status, 200);
      const user = { token: data.idToken, uid: data.localId };
      users.push(user);
      return user;
    };
    const request = async (user: (typeof users)[number], path: string, body: unknown = {}) => fetch(base + path, {
      method: "POST", headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const owner = await createUser();
    const created = await request(owner, "/v1/rooms", { title: "voice room" });
    assert.equal(created.status, 201);
    const room = (await created.json() as any).room;
    const guest = await createUser();
    assert.equal((await request(guest, `/v1/rooms/${room.code}/join`)).status, 200);
    const roomTicketResponse = await request(owner, `/v1/rooms/${room.id}/realtime-ticket`);
    const roomTicket = await roomTicketResponse.json() as any;
    const roomSocket = io(base + roomTicket.namespace, {
      transports: ["websocket"], reconnection: false, forceNew: true,
      auth: { ticket: roomTicket.ticket, protocolVersion: 2 },
    });
    sockets.push(roomSocket);
    await waitEvent(roomSocket, "snapshot");
    const nonmember = await createUser();
    const unavailable = await request(nonmember, `/v1/rooms/${room.id}/voice/config`);
    assert.equal(unavailable.status, 403);

    const ownerConfigResponse = await request(owner, `/v1/rooms/${room.id}/voice/config`);
    assert.equal(ownerConfigResponse.status, 200);
    const ownerConfig = await ownerConfigResponse.json() as any;
    assert.equal(ownerConfig.mode, "MESH");
    assert.equal(ownerConfig.namespace, `/hambin/voice/${room.id}`);
    assert.ok(ownerConfig.iceExpiresAt);
    const turn = ownerConfig.iceServers.at(-1);
    const expires = Number(turn.username.split(":")[0]);
    assert.ok(expires >= Math.floor(Date.now() / 1000) + 599 && expires <= Math.floor(Date.now() / 1000) + 600);
    assert.equal(turn.credential, createHmac("sha1", configuration.turnSecret).update(turn.username).digest("base64"));
    const guestConfigResponse = await request(guest, `/v1/rooms/${room.id}/voice/config`);
    const guestConfig = await guestConfigResponse.json() as any;
    const rosterEvents = new Map<Socket, any[]>();
    const connect = async (user: (typeof users)[number], configValue: any) => {
      const socket = io(base + configValue.namespace, {
        transports: ["websocket"], reconnection: false, forceNew: true,
        auth: { ticket: configValue.ticket, protocolVersion: 2 },
      });
      sockets.push(socket);
      const seen: any[] = [];
      rosterEvents.set(socket, seen);
      socket.on("voice.roster", (value) => seen.push(value));
      await waitEvent(socket, "voice.roster");
      return socket;
    };
    const ownerSocket = await connect(owner, ownerConfig);
    const sameSessionResponse = await request(owner, `/v1/rooms/${room.id}/voice/config`, { voiceSessionId: ownerConfig.voiceSessionId });
    const sameSession = await sameSessionResponse.json() as any;
    assert.equal(sameSession.voiceSessionId, ownerConfig.voiceSessionId);
    assert.notEqual(sameSession.ticket, ownerConfig.ticket);
    const guestSocket = await connect(guest, guestConfig);
    // One initial roster per joining socket; the existing owner gets one update.
    assert.equal(rosterEvents.get(ownerSocket)?.length, 2);
    assert.equal(rosterEvents.get(guestSocket)?.length, 1);
    const roster = rosterEvents.get(ownerSocket)?.at(-1);
    assert.deepEqual(new Set(roster.members.map((member: any) => member.membershipId)), new Set([ownerConfig.membershipId, guestConfig.membershipId]));
    assert.ok(roster.members.every((member: any) => member.muted));
    const unmutedRosterEvent = waitEvent<any>(guestSocket, "voice.roster");
    assert.deepEqual(await rpc(ownerSocket, "voice.mute", { muted: false }), { ok: true });
    const unmutedRoster = await unmutedRosterEvent;
    assert.equal(unmutedRoster.members.find((member: any) => member.membershipId === ownerConfig.membershipId).muted, false);

    const ownerIsOfferer = ownerConfig.membershipId < guestConfig.membershipId;
    const offererSocket = ownerIsOfferer ? ownerSocket : guestSocket;
    const answererSocket = ownerIsOfferer ? guestSocket : ownerSocket;
    const offererConfig = ownerIsOfferer ? ownerConfig : guestConfig;
    const answererConfig = ownerIsOfferer ? guestConfig : ownerConfig;
    const signal = {
      generation: offererConfig.voiceSessionId,
      targetGeneration: answererConfig.voiceSessionId,
      peerGeneration: 1,
      targetPeerGeneration: 0,
      sdp: { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" },
    };
    const inbound = waitEvent<any>(answererSocket, "signal");
    assert.deepEqual(await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: JSON.stringify(signal) }), { ok: true });
    const received = await inbound;
    assert.equal(received.from, offererConfig.membershipId);
    assert.deepEqual(JSON.parse(received.msg), signal);
    const videoSdp = { ...signal, sdp: { type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n" } };
    assert.equal((await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: JSON.stringify(videoSdp) })).code, "INVALID_JSON");
    const dataChannelSdp = { ...signal, sdp: { type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" } };
    assert.equal((await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: JSON.stringify(dataChannelSdp) })).code, "INVALID_JSON");
    const rollback = { ...signal, sdp: { type: "rollback", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" } };
    assert.equal((await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: JSON.stringify(rollback) })).code, "INVALID_JSON");
    assert.equal((await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: JSON.stringify({ ...signal, peerGeneration: 1.5 }) })).code, "INVALID_JSON");
    assert.equal((await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: JSON.stringify({ ...signal, peerGeneration: 1 }) })).code, "STALE_NEGOTIATION");
    const answer = { generation: answererConfig.voiceSessionId, targetGeneration: offererConfig.voiceSessionId, peerGeneration: 1, targetPeerGeneration: 1,
      sdp: { type: "answer", sdp: "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" } };
    assert.deepEqual(await rpc(answererSocket, "signal", { to: offererConfig.membershipId, msg: JSON.stringify(answer) }), { ok: true });
    const restart = { generation: offererConfig.voiceSessionId, targetGeneration: answererConfig.voiceSessionId,
      peerGeneration: 1, targetPeerGeneration: 1, restart: true };
    assert.deepEqual(await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: JSON.stringify(restart) }), { ok: true });
    const replacementOffer = { ...signal, peerGeneration: 2 };
    assert.deepEqual(await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: JSON.stringify(replacementOffer) }), { ok: true });
    const staleIce = { generation: offererConfig.voiceSessionId, targetGeneration: answererConfig.voiceSessionId, peerGeneration: 1, targetPeerGeneration: 2,
      ice: { candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 } };
    assert.equal((await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: JSON.stringify(staleIce) })).code, "STALE_NEGOTIATION");
    const replacementAnswer = { ...answer, peerGeneration: 2, targetPeerGeneration: 2 };
    assert.deepEqual(await rpc(answererSocket, "signal", { to: offererConfig.membershipId, msg: JSON.stringify(replacementAnswer) }), { ok: true });
    assert.equal((await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: JSON.stringify(restart) })).code, "STALE_NEGOTIATION");
    assert.equal((await rpc(answererSocket, "signal", { to: offererConfig.membershipId, msg: JSON.stringify({ ...signal, generation: answererConfig.voiceSessionId, targetGeneration: offererConfig.voiceSessionId }) })).code, "STALE_NEGOTIATION");
    assert.equal((await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: JSON.stringify({ ...signal, targetGeneration: "00000000-0000-4000-8000-000000000000" }) })).code, "FORBIDDEN");
    assert.equal((await rpc(offererSocket, "signal", { to: answererConfig.membershipId, msg: "x".repeat(65537) })).code, "PAYLOAD_TOO_LARGE");
    assert.equal((await rpc(offererSocket, "signal", { to: offererConfig.membershipId, msg: JSON.stringify(signal) })).code, "FORBIDDEN");

    // Replacing just the voice generation disconnects its old socket and preserves the room lease.
    const replacementResponse = await request(owner, `/v1/rooms/${room.id}/voice/config`);
    const replacement = await replacementResponse.json() as any;
    assert.notEqual(replacement.voiceSessionId, ownerConfig.voiceSessionId);
    const roomGenerationBefore = (await running.db.query("SELECT generation FROM role_leases WHERE membership_id=$1 AND role='room'", [ownerConfig.membershipId])).rows[0].generation;
    const replacementSocket = await connect(owner, replacement);
    assert.equal(ownerSocket.connected, false);
    const roles = await running.db.query("SELECT role,generation FROM role_leases WHERE membership_id=$1 ORDER BY role", [ownerConfig.membershipId]);
    assert.deepEqual(roles.rows.map((row) => row.role), ["room", "voice"]);
    assert.equal(roles.rows.find((row) => row.role === "room").generation, roomGenerationBefore);
    assert.ok((await rpc(replacementSocket, "auth.refresh", { idToken: owner.token })).expiresAt);

    const emptyVoiceSession = await request(nonmember, `/v1/rooms/${room.id}/voice/config`, { voiceSessionId: guestConfig.voiceSessionId });
    assert.equal(emptyVoiceSession.status, 403);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await running.stop();
  }
});
