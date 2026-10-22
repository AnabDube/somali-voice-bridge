import { useCallback, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { readFunctionError } from "@/lib/functionErrors";
import type { StepName } from "@/lib/pipeline";

/**
 * Retry one failed step of a recording. The server claims the step before
 * working, so a second click while it runs does nothing (no duplicate work,
 * no double-counted minutes). Progress arrives through the live step updates.
 */
export const useRetryStep = (onSettled?: () => void) => {
  const [running, setRunning] = useState<Set<string>>(new Set());

  const isRetrying = useCallback((uploadId: string, step: StepName) => running.has(`${uploadId}:${step}`), [running]);

  const retry = useCallback(
    async (uploadId: string, step: StepName) => {
      const id = `${uploadId}:${step}`;
      if (running.has(id)) return;

      if (step === "upload") {
        toast.error("This upload didn't finish. Please upload the file again.");
        return;
      }

      setRunning((prev) => new Set(prev).add(id));
      try {
        const { error } =
          step === "transcription"
            ? await supabase.functions.invoke("transcribe-audio", { body: { upload_id: uploadId } })
            : await supabase.functions.invoke("run-pipeline", { body: { upload_id: uploadId, step } });
        if (error) {
          toast.error((await readFunctionError(error)) ?? "Could not retry. Please try again in a moment.");
        }
      } finally {
        setRunning((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        onSettled?.();
      }
    },
    [running, onSettled],
  );

  return { retry, isRetrying };
};
