'use client';

import { useEffect } from 'react';

/**
 * Turn picture-in-picture off, everywhere.
 *
 * Videos are created all over this app — nodes, the media bin, the cut room's
 * decoder pool, previews — so the attribute cannot be set at every call site and
 * stay set. This watches the document instead, and stamps every <video> that
 * appears. The CSS in globals.css hides the button on native controls; this
 * closes the rest: the context menu entry, the keyboard shortcut, and any
 * `requestPictureInPicture()` a browser feature triggers on its own.
 */
export default function DisablePictureInPicture() {
  useEffect(() => {
    const stamp = (root: ParentNode) => {
      const videos =
        root instanceof HTMLVideoElement ? [root] : Array.from(root.querySelectorAll('video'));
      for (const video of videos) {
        video.disablePictureInPicture = true;
        // Chrome hangs its own overflow menu off this attribute too.
        video.setAttribute('controlsList', 'nodownload noplaybackrate');
      }
    };

    stamp(document);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) stamp(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Last line of defence: if a video does get into PiP (an extension, a gesture
    // the attribute does not cover), put it straight back.
    const bounce = () => {
      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
    };
    document.addEventListener('enterpictureinpicture', bounce, true);

    return () => {
      observer.disconnect();
      document.removeEventListener('enterpictureinpicture', bounce, true);
    };
  }, []);

  return null;
}
