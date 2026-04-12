const clients = new Set();
const KEEPALIVE_INTERVAL_MS = 25000;

function formatEvent(eventType, payload) {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function attachRealtimeClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(formatEvent('system:connected', {
    connectedAt: new Date().toISOString(),
  }));

  clients.add(res);

  const keepaliveTimer = setInterval(() => {
    res.write(': ping\n\n');
  }, KEEPALIVE_INTERVAL_MS);

  req.on('close', () => {
    clearInterval(keepaliveTimer);
    clients.delete(res);
    res.end();
  });
}

export function broadcast(eventType, payload) {
  const message = formatEvent(eventType, payload);

  for (const client of clients) {
    try {
      client.write(message);
    } catch (error) {
      clients.delete(client);
    }
  }
}

export function getConnectedClientCount() {
  return clients.size;
}
