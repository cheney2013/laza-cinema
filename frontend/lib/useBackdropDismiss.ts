import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Close-on-backdrop that needs a whole click, not just a release.
 *
 * `onClick` on an overlay fires whenever press and release share an ancestor, so
 * a drag that starts inside the dialog — selecting text in a prompt, pulling a
 * slider, resizing something — and happens to end over the backdrop counts as a
 * click on the backdrop and throws the dialog away, unsaved work included.
 *
 * Here the press has to land on the backdrop itself AND the release has to land
 * on that same backdrop. Anything that begins inside the panel is ignored no
 * matter where it ends up, and a press that starts on the backdrop but ends
 * inside the panel is ignored too.
 *
 * Spread the result onto the element that IS the backdrop:
 *   const dismiss = useBackdropDismiss(onClose);
 *   <div className="fixed inset-0 …" {...dismiss}>
 */
export function useBackdropDismiss(onDismiss: () => void) {
  const armedRef = useRef(false);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // Only a primary press on the backdrop itself arms a dismissal.
    armedRef.current = event.target === event.currentTarget && event.button === 0;
  }, []);

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const armed = armedRef.current;
      armedRef.current = false;
      if (armed && event.target === event.currentTarget) onDismiss();
    },
    [onDismiss]
  );

  // A pointer that leaves the window mid-drag never releases here; disarm so the
  // next release cannot close something the user never pressed on.
  const onPointerCancel = useCallback(() => {
    armedRef.current = false;
  }, []);

  return { onPointerDown, onPointerUp, onPointerCancel };
}
