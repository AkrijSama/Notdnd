const PLACEHOLDER_MEDIA = {
  image: "IMAGE_RESULT_PLACEHOLDER_URL",
  voice: "VOICE_RESULT_PLACEHOLDER_URL"
};

export function listAiProviders() {
  return [
    {
      key: "placeholder",
      label: "Placeholder Provider",
      models: {
        gm: "AI_GM_MODEL_VALUE",
        image: "IMAGE_MODEL_VALUE",
        voice: "VOICE_MODEL_VALUE"
      },
      status: "ready"
    },
    {
      key: "local-mock",
      label: "Local Mock Provider",
      models: {
        gm: "mock-gm-v1",
        image: "mock-image-v1",
        voice: "mock-voice-v1"
      },
      status: "ready"
    },
    {
      key: "openai-compatible",
      label: "OpenAI-Compatible Endpoint",
      models: {
        gm: process.env.NOTDND_AI_GM_MODEL || "gpt-placeholder",
        image: process.env.NOTDND_AI_IMAGE_MODEL || "image-placeholder",
        voice: process.env.NOTDND_AI_VOICE_MODEL || "voice-placeholder"
      },
      status: process.env.NOTDND_AI_ENDPOINT ? "configured" : "missing-config"
    }
  ];
}

function localMockResult({ type, prompt }) {
  const stamp = new Date().toISOString();
  if (type === "image") {
    return {
      text: `Generated mock image prompt at ${stamp}`,
      imageUrl: `mock://image/${encodeURIComponent(prompt.slice(0, 48))}`
    };
  }
  if (type === "voice") {
    return {
      text: `Generated mock voice line at ${stamp}`,
      audioUrl: `mock://voice/${encodeURIComponent(prompt.slice(0, 48))}`
    };
  }
  return {
    text: `Mock GM response (${stamp}): ${prompt.slice(0, 140)}`
  };
}

async function openAiCompatibleResult({ type, prompt, model }) {
  const endpoint = process.env.NOTDND_AI_ENDPOINT;
  const apiKey = process.env.NOTDND_AI_API_KEY;

  if (!endpoint || !apiKey) {
    throw new Error("NOTDND_AI_ENDPOINT and NOTDND_AI_API_KEY are required");
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      type,
      prompt
    })
  });

  if (!res.ok) {
    throw new Error(`Upstream AI endpoint failed with status ${res.status}`);
  }

  const data = await res.json();
  if (type === "image") {
    return {
      text: data.text || "Image generation complete",
      imageUrl: data.imageUrl || PLACEHOLDER_MEDIA.image
    };
  }
  if (type === "voice") {
    return {
      text: data.text || "Voice generation complete",
      audioUrl: data.audioUrl || PLACEHOLDER_MEDIA.voice
    };
  }
  return {
    text: data.text || "GM response generated"
  };
}

export async function generateWithProvider({ provider = "placeholder", type = "gm", prompt = "", model = "" }) {
  if (provider === "placeholder") {
    if (type === "image") {
      return {
        provider: "placeholder",
        model: model || "IMAGE_MODEL_VALUE",
        text: "Placeholder image job complete.",
        imageUrl: PLACEHOLDER_MEDIA.image
      };
    }
    if (type === "voice") {
      return {
        provider: "placeholder",
        model: model || "VOICE_MODEL_VALUE",
        text: "Placeholder voice job complete.",
        audioUrl: PLACEHOLDER_MEDIA.voice
      };
    }
    return {
      provider: "placeholder",
      model: model || "AI_GM_MODEL_VALUE",
      text: `Placeholder GM output: ${prompt.slice(0, 160)}`
    };
  }

  if (provider === "local-mock") {
    const result = localMockResult({ type, prompt });
    return {
      provider,
      model: model || `${type}-mock-v1`,
      ...result
    };
  }

  if (provider === "openai-compatible") {
    const result = await openAiCompatibleResult({ type, prompt, model });
    return {
      provider,
      model: model || `${type}-remote`,
      ...result
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
