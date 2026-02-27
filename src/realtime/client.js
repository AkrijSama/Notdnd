export function createRealtimeClient({
  campaignId = "global",
  token = "",
  onStateChanged,
  onOpen,
  onClose,
  onError
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

  function sendOp(op, payload, expectedVersion) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type: "op", op, payload, expectedVersion }));
  }

  connect(campaignId);

  return {
    joinCampaign,
    close,
    sendOp,
    setToken
  };
}
