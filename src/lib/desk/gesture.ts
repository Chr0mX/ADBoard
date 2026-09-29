import type { GestureSample, MacroStep, SavedMacro } from "@/lib/desk/store";

export type { GestureSample };

function nextId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function recordedMacros(macros: SavedMacro[]): SavedMacro[] {
  return macros.filter((macro) => macro.steps.some((step) => step.kind === "gesture" && (step.samples?.length ?? 0) > 0));
}

export function gestureStep(macro: SavedMacro | null | undefined): MacroStep | null {
  return macro?.steps.find((step) => step.kind === "gesture" && (step.samples?.length ?? 0) > 0) ?? null;
}

/** Close an open finger so replay does not leave the pointer down. */
export function finishGesture(samples: GestureSample[]): GestureSample[] {
  if (samples.length === 0) return samples;
  const last = samples[samples.length - 1];
  if (last.phase === "up" || last.phase === "cancel") return samples;
  return [...samples, { ...last, phase: "up", t: last.t + 16 }];
}

export function makeRecordedMacro(
  samples: GestureSample[],
  name: string,
  frameWidth: number,
  frameHeight: number,
): SavedMacro {
  const path = finishGesture(samples);
  return {
    id: nextId("macro"),
    name,
    folder: "Recorded",
    steps: [
      {
        id: nextId("step"),
        kind: "gesture",
        samples: path,
        frameWidth,
        frameHeight,
      },
    ],
  };
}

export async function replayGesture(
  samples: GestureSample[],
  send: (sample: GestureSample) => Promise<unknown> | void,
  options?: { sleep?: (ms: number) => Promise<void>; shouldStop?: () => boolean },
): Promise<void> {
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last = 0;
  for (const sample of samples) {
    if (options?.shouldStop?.()) return;
    const wait = sample.t - last;
    if (wait > 0) await sleep(wait);
    if (options?.shouldStop?.()) return;
    last = sample.t;
    await send(sample);
  }
}
