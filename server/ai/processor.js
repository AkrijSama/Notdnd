import { generateWithProvider } from "./providers.js";
import { applyOperation, getAiJobById, updateAiJobStatus } from "../db/repository.js";

export function createAiJobProcessor({ onJobUpdated }) {
  const inFlight = new Set();

  async function processJob(jobId, config = {}) {
    if (!jobId || inFlight.has(jobId)) {
      return;
    }

    const job = getAiJobById(jobId);
    if (!job || job.status === "Complete") {
      return;
    }

    inFlight.add(jobId);

    try {
      updateAiJobStatus({ jobId, status: "Processing" });
      onJobUpdated?.({ jobId, campaignId: job.campaignId, status: "Processing" });

      const result = await generateWithProvider({
        provider: config.provider || process.env.NOTDND_AI_PROVIDER || "local",
        type: job.type,
        prompt: job.prompt,
        model: config.model || ""
      });

      updateAiJobStatus({
        jobId,
        status: "Complete",
        result,
        providerName: result.provider,
        modelValue: result.model
      });

      applyOperation("push_chat_line", {
        campaignId: job.campaignId,
        speaker: "AI GM",
        text: result.text || "AI job complete"
      }, { internal: true });

      onJobUpdated?.({ jobId, campaignId: job.campaignId, status: "Complete", result });
    } catch (error) {
      updateAiJobStatus({
        jobId,
        status: "Failed",
        result: { error: String(error.message || error) }
      });
      applyOperation("push_chat_line", {
        campaignId: job.campaignId,
        speaker: "System",
        text: `AI job failed for ${job.type}: ${String(error.message || error)}`
      }, { internal: true });
      onJobUpdated?.({
        jobId,
        campaignId: job.campaignId,
        status: "Failed",
        error: String(error.message || error)
      });
    } finally {
      inFlight.delete(jobId);
    }
  }

  return {
    processJob
  };
}
