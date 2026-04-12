const DEFAULT_STREAM_URL = '/api/realtime/stream';

function safeParseEvent(data) {
  try {
    return JSON.parse(data);
  } catch (error) {
    return data;
  }
}

export class RealtimeClient {
  constructor(url = DEFAULT_STREAM_URL) {
    this.url = url;
    this.source = null;
    this.listeners = new Map();
  }

  connect() {
    if (this.source || typeof EventSource === 'undefined') {
      return this;
    }

    this.source = new EventSource(this.url);
    this.source.addEventListener('gm:spawn', (event) => {
      this.emit('gm:spawn', safeParseEvent(event.data));
    });
    this.source.addEventListener('system:connected', (event) => {
      this.emit('system:connected', safeParseEvent(event.data));
    });
    this.source.addEventListener('error', (event) => {
      this.emit('error', event);
    });

    return this;
  }

  disconnect() {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }

  subscribe(eventType, handler) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }

    const handlers = this.listeners.get(eventType);
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
    };
  }

  emit(eventType, payload) {
    const handlers = this.listeners.get(eventType);

    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      handler(payload);
    }
  }
}

export function createRealtimeClient(url = DEFAULT_STREAM_URL) {
  return new RealtimeClient(url).connect();
}
