import crypto from "node:crypto";

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

function parseCampaignIdFromUrl(req) {
  const baseUrl = `http://${req.headers.host || "localhost"}`;
  const url = new URL(req.url || "/", baseUrl);
  return url.searchParams.get("campaignId") || "global";
}

export function createWsHub({ onClientMessage } = {}) {
  const clients = new Map();

  function send(client, message) {
    if (!client.socket.destroyed) {
      client.socket.write(encodeTextFrame(JSON.stringify(message)));
    }
  }

  function broadcast(message, predicate = () => true) {
    for (const client of clients.values()) {
      if (predicate(client)) {
        send(client, message);
      }
    }
  }

  function handleUpgrade(req, socket, head) {
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
      campaignId: parseCampaignIdFromUrl(req),
      buffer: head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
    };
    clients.set(clientId, client);

    send(client, {
      type: "connected",
      clientId,
      campaignId: client.campaignId,
      timestamp: Date.now()
    });

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
          client.campaignId = parsed.campaignId;
          send(client, {
            type: "joined_campaign",
            campaignId: client.campaignId,
            timestamp: Date.now()
          });
          continue;
        }

        onClientMessage?.(parsed, client, {
          broadcast
        });
      }

      if (decoded.shouldClose) {
        socket.end();
      }
    });

    socket.on("close", () => {
      clients.delete(clientId);
    });

    socket.on("end", () => {
      clients.delete(clientId);
    });

    socket.on("error", () => {
      clients.delete(clientId);
    });
  }

  function broadcastStateChanged({ campaignId = "global", reason = "operation", op = null } = {}) {
    broadcast(
      {
        type: "state_changed",
        campaignId,
        reason,
        op,
        timestamp: Date.now()
      },
      (client) => client.campaignId === campaignId || campaignId === "global"
    );
  }

  function connectionCount() {
    return clients.size;
  }

  return {
    handleUpgrade,
    broadcastStateChanged,
    connectionCount
  };
}
