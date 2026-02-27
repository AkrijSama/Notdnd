export function createRealtimeClient({ campaignId = "global", onStateChanged, onOpen, onClose } = {}) {
  let socket = null;
  let reconnectTimer = null;
  let closedByUser = false;

  function wsUrlForCampaign(nextCampaignId) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws?campaignId=${encodeURIComponent(nextCampaignId || "global")}`;
  }

  function connect(nextCampaignId = campaignId) {
    campaignId = nextCampaignId || "global";
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
      } catch {
        // Ignore malformed frames.
      }
    });

    socket.addEventListener("close", () => {
      onClose?.();
      if (!closedByUser) {
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

  function sendOp(op, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type: "op", op, payload }));
  }

  connect(campaignId);

  return {
    joinCampaign,
    close,
    sendOp
  };
}
