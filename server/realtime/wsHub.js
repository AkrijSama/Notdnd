import crypto from "node:crypto";

const LOCK_TTL_MS = Number(process.env.NOTDND_LOCK_TTL_MS || 30_000);

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload]);
  }

  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(length, 6);
  return Buffer.concat([header, payload]);
}

function encodePong(payload = Buffer.alloc(0)) {
  const length = payload.length;
  return Buffer.concat([Buffer.from([0x8a, length]), payload]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  let shouldClose = false;
  const pings = [];

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];

    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) === 0x80;
    let payloadLength = secondByte & 0x7f;
    let cursor = offset + 2;

    if (payloadLength === 126) {
      if (cursor + 2 > buffer.length) {
        break;
      }
      payloadLength = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLength === 127) {
      if (cursor + 8 > buffer.length) {
        break;
      }
      const high = buffer.readUInt32BE(cursor);
      const low = buffer.readUInt32BE(cursor + 4);
      if (high !== 0) {
        throw new Error("Unsupported large websocket frame");
      }
      payloadLength = low;
      cursor += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (cursor + maskLength + payloadLength > buffer.length) {
      break;
    }

    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += maskLength;

    let payload = buffer.subarray(cursor, cursor + payloadLength);
    if (masked && mask) {
      const unmasked = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    if (opcode === 0x8) {
      shouldClose = true;
    } else if (opcode === 0x9) {
      pings.push(payload);
    } else if (opcode === 0x1) {
      messages.push(payload.toString("utf8"));
    }

    offset = cursor + payloadLength;
  }

  return {
    messages,
    pings,
    shouldClose,
    rest: buffer.subarray(offset)
  };
}

function parseUrl(req) {
  const baseUrl = `http://${req.headers.host || "localhost"}`;
  return new URL(req.url || "/", baseUrl);
}

function parseCampaignIdFromUrl(req) {
  const url = parseUrl(req);
  return url.searchParams.get("campaignId") || "global";
}

function parseTokenFromUrl(req) {
  const url = parseUrl(req);
  return url.searchParams.get("token") || "";
}

function nowMs() {
  return Date.now();
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function streamEnabled() {
  return String(process.env.NOTDND_STREAM || "").trim().toLowerCase() === "true";
}

/**
 * Creates the websocket hub used for campaign realtime sync and GM streaming.
 * @param {object} [options]
 * @param {(token: string) => object | null} [options.authenticateToken]
 * @param {(user: object, campaignId: string) => boolean} [options.canJoinCampaign]
 * @param {(message: object, client: object, helpers: object) => void} [options.onClientMessage]
 * @param {(payload: object) => Promise<object>} [options.onGmPlayerMessage]
 * @param {(campaignId: string) => object} [options.getCampaignRuntime]
 * @param {(campaignId: string, patch: object) => object} [options.setCampaignRuntime]
 * @returns {object}
 */
export function createWsHub({
  authenticateToken,
  canJoinCampaign,
  onClientMessage,
  onGmPlayerMessage,
  getCampaignRuntime,
  setCampaignRuntime
} = {}) {
  const clients = new Map();
  const cursorsByCampaign = new Map();
  const locksByCampaign = new Map();
  const typingByCampaign = new Map();

  function send(client, message) {
    if (!client.socket.destroyed) {
      client.socket.write(encodeTextFrame(JSON.stringify(message)));
    }
  }

  function sendToClient(clientId, message) {
    const client = clients.get(clientId);
    if (client) {
      send(client, message);
    }
  }

  function broadcast(message, predicate = () => true) {
    for (const client of clients.values()) {
      if (predicate(client)) {
        send(client, message);
      }
    }
  }

  function campaignClients(campaignId) {
    return [...clients.values()].filter((client) => client.campaignId === campaignId);
  }

  function broadcastCampaign(campaignId, message, predicate = () => true) {
    broadcast(message, (client) => client.campaignId === campaignId && predicate(client));
  }

  function getTypingMap(campaignId) {
    if (!typingByCampaign.has(campaignId)) {
      typingByCampaign.set(campaignId, new Map());
    }
    return typingByCampaign.get(campaignId);
  }

  function getRuntimeState(campaignId) {
    try {
      return getCampaignRuntime?.(campaignId) || {
        mode: "freeform",
        initiativeOrder: [],
        turnPointer: 0,
        waitingForGm: false
      };
    } catch {
      return {
        mode: "freeform",
        initiativeOrder: [],
        turnPointer: 0,
        waitingForGm: false
      };
    }
  }

  function getActiveTurnName(runtime = {}) {
    const order = Array.isArray(runtime.initiativeOrder) ? runtime.initiativeOrder : [];
    if (order.length === 0) {
      return "";
    }
    const pointer = Number(runtime.turnPointer || 0);
    const idx = ((pointer % order.length) + order.length) % order.length;
    return String(order[idx]?.name || "").trim();
  }

  function presenceForCampaign(campaignId) {
    const users = [];
    const seen = new Set();
    const typingMap = getTypingMap(campaignId);
    const runtime = getRuntimeState(campaignId);

    for (const client of campaignClients(campaignId)) {
      if (!client.user) {
        continue;
      }
      if (seen.has(client.user.id)) {
        continue;
      }
      seen.add(client.user.id);
      users.push({
        id: client.user.id,
        displayName: client.user.displayName,
        email: client.user.email,
        typing: Boolean(typingMap.get(client.user.id)),
        waitingForGm: Boolean(runtime.waitingForGm)
      });
    }
    return users;
  }

  function getCampaignCursorMap(campaignId) {
    if (!cursorsByCampaign.has(campaignId)) {
      cursorsByCampaign.set(campaignId, new Map());
    }
    return cursorsByCampaign.get(campaignId);
  }

  function getCampaignLockMap(campaignId) {
    if (!locksByCampaign.has(campaignId)) {
      locksByCampaign.set(campaignId, new Map());
    }
    return locksByCampaign.get(campaignId);
  }

  function cleanupExpiredLocks(campaignId) {
    const lockMap = getCampaignLockMap(campaignId);
    const now = nowMs();
    for (const [resource, lock] of lockMap.entries()) {
      if (lock.expiresAt <= now) {
        lockMap.delete(resource);
      }
    }
  }

  function publishPresence(campaignId) {
    broadcastCampaign(campaignId, {
      type: "presence",
      campaignId,
      users: presenceForCampaign(campaignId),
      runtime: getRuntimeState(campaignId),
      timestamp: nowMs()
    });
  }

  function publishCursors(campaignId) {
    const cursorMap = getCampaignCursorMap(campaignId);
    broadcastCampaign(campaignId, {
      type: "cursor_state",
      campaignId,
      cursors: [...cursorMap.values()],
      timestamp: nowMs()
    });
  }

  function publishLocks(campaignId) {
    cleanupExpiredLocks(campaignId);
    const lockMap = getCampaignLockMap(campaignId);
    broadcastCampaign(campaignId, {
      type: "lock_state",
      campaignId,
      locks: [...lockMap.values()].map((lock) => ({
        resource: lock.resource,
        ownerUserId: lock.ownerUserId,
        ownerName: lock.ownerName,
        expiresAt: lock.expiresAt
      })),
      timestamp: nowMs()
    });
  }

  function lockResource(campaignId, resource, user) {
    cleanupExpiredLocks(campaignId);
    const lockMap = getCampaignLockMap(campaignId);
    const existing = lockMap.get(resource);

    if (existing && existing.ownerUserId !== user.id) {
      return {
        ok: false,
        lock: existing
      };
    }

    const lock = {
      resource,
      ownerUserId: user.id,
      ownerName: user.displayName,
      expiresAt: nowMs() + LOCK_TTL_MS
    };
    lockMap.set(resource, lock);
    return {
      ok: true,
      lock
    };
  }

  function releaseResource(campaignId, resource, userId) {
    cleanupExpiredLocks(campaignId);
    const lockMap = getCampaignLockMap(campaignId);
    const existing = lockMap.get(resource);
    if (!existing) {
      return false;
    }
    if (existing.ownerUserId !== userId) {
      return false;
    }
    lockMap.delete(resource);
    return true;
  }

  function releaseAllResourcesOwnedBy(campaignId, userId) {
    const lockMap = getCampaignLockMap(campaignId);
    let changed = false;
    for (const [resource, lock] of lockMap.entries()) {
      if (lock.ownerUserId === userId) {
        lockMap.delete(resource);
        changed = true;
      }
    }
    return changed;
  }

  function getLock(campaignId, resource) {
    cleanupExpiredLocks(campaignId);
    return getCampaignLockMap(campaignId).get(resource) || null;
  }

  async function handleGmPlayerMessage(parsed, client) {
    if (!onGmPlayerMessage) {
      send(client, {
        type: "ai_error",
        campaignId: client.campaignId,
        error: "GM pipeline unavailable",
        timestamp: nowMs()
      });
      return;
    }

    const campaignId = client.campaignId;
    const text = String(parsed?.text || parsed?.message || "").trim();
    if (!text) {
      return;
    }

    const runtime = getRuntimeState(campaignId);
    const isCombat = runtime.mode === "combat";
    const isOoc = Boolean(parsed?.ooc);
    const expectedTurnName = getActiveTurnName(runtime);

    const clientName = String(parsed?.playerName || client.user?.displayName || "").trim();
    if (isCombat && !isOoc && expectedTurnName) {
      const isAllowed = normalizeName(expectedTurnName) === normalizeName(clientName);
      if (!isAllowed) {
        send(client, {
          type: "turn_blocked",
          campaignId,
          activePlayer: expectedTurnName,
          yourName: clientName,
          timestamp: nowMs()
        });
        return;
      }
    }

    broadcastCampaign(
      campaignId,
      {
        type: "player_message",
        campaignId,
        playerName: clientName,
        text,
        ooc: isOoc,
        timestamp: nowMs()
      },
      (target) => target.id !== client.id
    );

    if (isOoc) {
      return;
    }

    try {
      setCampaignRuntime?.(campaignId, {
        waitingForGm: true
      });
    } catch {
      // Ignore runtime persistence failures here; response still continues.
    }

    publishPresence(campaignId);

    broadcastCampaign(campaignId, {
      type: "ai_thinking",
      campaignId,
      playerName: clientName,
      timestamp: nowMs()
    });

    const streaming = streamEnabled();

    try {
      const response = await onGmPlayerMessage({
        campaignId,
        message: text,
        mode: "session",
        playerName: clientName,
        actorUserId: client.user.id,
        activePlayers: presenceForCampaign(campaignId).map((entry) => ({
          name: entry.displayName
        })),
        stream: streaming,
        onStream(chunk) {
          broadcastCampaign(campaignId, {
            type: "ai_stream",
            campaignId,
            chunk: String(chunk || ""),
            timestamp: nowMs()
          });
        }
      });

      broadcastCampaign(campaignId, {
        type: "ai_response",
        campaignId,
        narrative: response.narrative,
        memoryUpdates: response.memoryUpdates || [],
        meta: response.meta || {},
        timestamp: nowMs()
      });

      broadcastCampaign(campaignId, {
        type: "ai_mechanical",
        campaignId,
        mechanical: response.mechanical || { rolls: [], stateChanges: [] },
        timestamp: nowMs()
      });

      if (isCombat && !isOoc) {
        const latest = getRuntimeState(campaignId);
        const order = Array.isArray(latest.initiativeOrder) ? latest.initiativeOrder : [];
        if (order.length > 0) {
          const nextPointer = ((Number(latest.turnPointer || 0) + 1) % order.length + order.length) % order.length;
          let updated = latest;
          try {
            updated = setCampaignRuntime?.(campaignId, { turnPointer: nextPointer }) || {
              ...latest,
              turnPointer: nextPointer
            };
          } catch {
            updated = {
              ...latest,
              turnPointer: nextPointer
            };
          }

          const nextName = getActiveTurnName(updated);
          broadcastCampaign(campaignId, {
            type: "turn_change",
            campaignId,
            activePlayer: nextName,
            turnPointer: Number(updated.turnPointer || 0),
            initiativeOrder: updated.initiativeOrder || [],
            timestamp: nowMs()
          });
        }
      }
    } catch (error) {
      send(client, {
        type: "ai_error",
        campaignId,
        error: String(error?.message || error),
        timestamp: nowMs()
      });
    } finally {
      try {
        setCampaignRuntime?.(campaignId, {
          waitingForGm: false
        });
      } catch {
        // Ignore runtime persistence failures.
      }
      publishPresence(campaignId);
    }
  }

  function handleUpgrade(req, socket, head) {
    const token = parseTokenFromUrl(req);
    const user = authenticateToken ? authenticateToken(token) : null;

    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const requestedCampaignId = parseCampaignIdFromUrl(req);
    const allowed = canJoinCampaign ? canJoinCampaign(user, requestedCampaignId) : true;
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "utf8")
      .digest("base64");

    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ];

    socket.write(responseHeaders.join("\r\n"));

    const clientId = crypto.randomUUID();
    const client = {
      id: clientId,
      socket,
      token,
      user,
      campaignId: requestedCampaignId,
      buffer: head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
    };

    clients.set(clientId, client);

    send(client, {
      type: "connected",
      clientId,
      campaignId: client.campaignId,
      user,
      runtime: getRuntimeState(client.campaignId),
      timestamp: nowMs()
    });

    publishPresence(client.campaignId);
    publishCursors(client.campaignId);
    publishLocks(client.campaignId);

    socket.on("data", (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      let decoded;
      try {
        decoded = decodeFrames(client.buffer);
      } catch {
        socket.destroy();
        return;
      }

      client.buffer = decoded.rest;

      for (const pingPayload of decoded.pings) {
        socket.write(encodePong(pingPayload));
      }

      for (const rawMessage of decoded.messages) {
        let parsed;
        try {
          parsed = JSON.parse(rawMessage);
        } catch {
          continue;
        }

        if (parsed?.type === "join_campaign" && parsed?.campaignId) {
          const nextCampaignId = String(parsed.campaignId);
          const nextAllowed = canJoinCampaign ? canJoinCampaign(client.user, nextCampaignId) : true;
          if (!nextAllowed) {
            send(client, {
              type: "join_denied",
              campaignId: nextCampaignId,
              reason: "forbidden",
              timestamp: nowMs()
            });
            continue;
          }

          const prevCampaign = client.campaignId;
          client.campaignId = nextCampaignId;

          send(client, {
            type: "joined_campaign",
            campaignId: nextCampaignId,
            runtime: getRuntimeState(nextCampaignId),
            timestamp: nowMs()
          });

          if (prevCampaign !== nextCampaignId) {
            releaseAllResourcesOwnedBy(prevCampaign, client.user.id);
            const prevCursorMap = getCampaignCursorMap(prevCampaign);
            prevCursorMap.delete(client.user.id);
            getTypingMap(prevCampaign).delete(client.user.id);
            publishPresence(prevCampaign);
            publishCursors(prevCampaign);
            publishLocks(prevCampaign);

            publishPresence(nextCampaignId);
            publishCursors(nextCampaignId);
            publishLocks(nextCampaignId);
          }
          continue;
        }

        if (parsed?.type === "typing") {
          const typingMap = getTypingMap(client.campaignId);
          typingMap.set(client.user.id, Boolean(parsed.typing));
          publishPresence(client.campaignId);
          continue;
        }

        if (parsed?.type === "cursor_update") {
          const cursorMap = getCampaignCursorMap(client.campaignId);
          cursorMap.set(client.user.id, {
            userId: client.user.id,
            displayName: client.user.displayName,
            x: Number(parsed.x || 0),
            y: Number(parsed.y || 0),
            label: String(parsed.label || "cursor"),
            updatedAt: nowMs()
          });
          publishCursors(client.campaignId);
          continue;
        }

        if (parsed?.type === "lock_acquire") {
          const resource = String(parsed.resource || "").trim();
          if (!resource) {
            continue;
          }
          const result = lockResource(client.campaignId, resource, client.user);
          send(client, {
            type: "lock_acquire_result",
            campaignId: client.campaignId,
            resource,
            ok: result.ok,
            lock: result.lock,
            timestamp: nowMs()
          });
          publishLocks(client.campaignId);
          continue;
        }

        if (parsed?.type === "lock_release") {
          const resource = String(parsed.resource || "").trim();
          if (!resource) {
            continue;
          }
          const ok = releaseResource(client.campaignId, resource, client.user.id);
          send(client, {
            type: "lock_release_result",
            campaignId: client.campaignId,
            resource,
            ok,
            timestamp: nowMs()
          });
          publishLocks(client.campaignId);
          continue;
        }

        if (parsed?.type === "gm_player_message") {
          void handleGmPlayerMessage(parsed, client);
          continue;
        }

        onClientMessage?.(parsed, client, {
          send,
          sendToClient,
          broadcast,
          broadcastCampaign,
          getLock,
          publishLocks,
          publishPresence,
          publishCursors
        });
      }

      if (decoded.shouldClose) {
        socket.end();
      }
    });

    function cleanup() {
      const campaignId = client.campaignId;
      const userId = client.user.id;
      clients.delete(clientId);

      const cursorMap = getCampaignCursorMap(campaignId);
      cursorMap.delete(userId);
      getTypingMap(campaignId).delete(userId);
      const lockChanged = releaseAllResourcesOwnedBy(campaignId, userId);

      publishPresence(campaignId);
      publishCursors(campaignId);
      if (lockChanged) {
        publishLocks(campaignId);
      }
    }

    socket.on("close", cleanup);
    socket.on("end", cleanup);
    socket.on("error", cleanup);
  }

  function broadcastStateChanged({ campaignId = "global", reason = "operation", op = null } = {}) {
    if (campaignId === "global") {
      broadcast({
        type: "state_changed",
        campaignId,
        reason,
        op,
        timestamp: nowMs()
      });
      return;
    }

    broadcastCampaign(campaignId, {
      type: "state_changed",
      campaignId,
      reason,
      op,
      timestamp: nowMs()
    });
  }

  function connectionCount() {
    return clients.size;
  }

  function getClientsInCampaign(campaignId) {
    return campaignClients(campaignId);
  }

  return {
    handleUpgrade,
    sendToClient,
    broadcast,
    broadcastCampaign,
    broadcastStateChanged,
    connectionCount,
    getClientsInCampaign,
    getLock,
    publishLocks,
    publishPresence,
    publishCursors
  };
}
