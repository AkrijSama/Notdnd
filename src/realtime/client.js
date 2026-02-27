export function createRealtimeClient({
  campaignId = "global",
  token = "",
  onStateChanged,
  onStateSync,
  onOpen,
  onClose,
  onError,
  onPresence,
  onCursors,
  onLocks
} = {}) {
  let socket = null;
  let reconnectTimer = null;
  let closedByUser = false;
  let authToken = token || "";

  function wsUrlForCampaign(nextCampaignId) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams({
      campaignId: nextCampaignId || "global",
      token: authToken || ""
    });
    return `${protocol}//${window.location.host}/ws?${query.toString()}`;
  }

  function connect(nextCampaignId = campaignId) {
    campaignId = nextCampaignId || "global";

    if (!authToken) {
      return;
    }

    if (socket && socket.readyState <= 1) {
      socket.close();
    }

    socket = new WebSocket(wsUrlForCampaign(campaignId));

    socket.addEventListener("open", () => {
      onOpen?.();
    });

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "state_changed") {
          onStateChanged?.(message);
        }
        if (message.type === "sync_state") {
          onStateSync?.(message);
        }
        if (message.type === "presence") {
          onPresence?.(message);
        }
        if (message.type === "cursor_state") {
          onCursors?.(message);
        }
        if (message.type === "lock_state") {
          onLocks?.(message);
        }
        if (message.type === "op_error") {
          onError?.(message);
        }
      } catch {
        // Ignore malformed frames.
      }
    });

    socket.addEventListener("close", () => {
      onClose?.();
      if (!closedByUser && authToken) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connect(campaignId), 1200);
      }
    });

    socket.addEventListener("error", () => {
      socket?.close();
    });
  }

  function joinCampaign(nextCampaignId) {
    connect(nextCampaignId);
  }

  function close() {
    closedByUser = true;
    clearTimeout(reconnectTimer);
    if (socket && socket.readyState <= 1) {
      socket.close();
    }
  }

  function setToken(nextToken) {
    authToken = nextToken || "";
    closedByUser = false;

    if (!authToken) {
      if (socket && socket.readyState <= 1) {
        socket.close();
      }
      return;
    }

    connect(campaignId);
  }

  function sendMessage(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  function sendOp(op, payload, expectedVersion) {
    return sendMessage({ type: "op", op, payload, expectedVersion });
  }

  function sendCursor(x, y, label = "cursor") {
    return sendMessage({ type: "cursor_update", x, y, label });
  }

  function acquireLock(resource) {
    return sendMessage({ type: "lock_acquire", resource });
  }

  function releaseLock(resource) {
    return sendMessage({ type: "lock_release", resource });
  }

  connect(campaignId);

  return {
    joinCampaign,
    close,
    sendOp,
    setToken,
    sendCursor,
    acquireLock,
    releaseLock
  };
}
