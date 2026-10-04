/**
 * 钉末帧: a re-run ends on the last frame of an earlier version, so the shots already
 * chained onto that ending need no re-run.
 *
 * Which version that is used to be "whichever one the node is showing when you press
 * run", so switching versions, or a new take landing, silently re-pointed the pin
 * (2026-09-30: a C11 re-run pinned an unaccepted take's ending). The pin now records the
 * version it was set on, and stays on it until it is changed on purpose.
 */

interface PinData {
  pinLastFrame?: unknown;
  pinLastFrameOf?: unknown;
  generatedUrl?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The clip whose last frame the next run is pinned to; undefined when the pin is off. */
export function pinnedSource(data: PinData): string | undefined {
  if (!data.pinLastFrame) return undefined;
  // A pin saved before it recorded its version follows the shown version, as it always did.
  return str(data.pinLastFrameOf) ?? str(data.generatedUrl);
}

/** Eight-hex tag of an H3 output file name, for showing which version is meant. */
export function fileTag(url: string | undefined): string {
  return /_([0-9a-f]{8})(?:_\d+_?)?\.\w+$/.exec(url ?? '')?.[1] ?? '';
}

/** What pressing the button changes: pin the shown version, or drop the pin. */
export function togglePin(data: PinData): { pinLastFrame: boolean; pinLastFrameOf: string | undefined } {
  return data.pinLastFrame
    ? { pinLastFrame: false, pinLastFrameOf: undefined }
    : { pinLastFrame: true, pinLastFrameOf: str(data.generatedUrl) };
}

/** Move an existing pin to the version now shown. */
export function repin(data: PinData): { pinLastFrame: boolean; pinLastFrameOf: string | undefined } {
  return { pinLastFrame: true, pinLastFrameOf: str(data.generatedUrl) };
}

/** True when the pin is on but points at a version other than the one shown. */
export function pinIsElsewhere(data: PinData): boolean {
  const pinned = pinnedSource(data);
  return Boolean(pinned) && pinned !== str(data.generatedUrl);
}
