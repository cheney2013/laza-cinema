import { BACKEND_URL, resolveAssetUrl } from './config';

export const MSE_MIME = 'video/mp4; codecs="avc1.640029, mp4a.40.2"';

export interface MseClip {
  url: string;
  start?: number;
  duration: number;
}

export interface MseSequenceOptions {
  width: number;
  height: number;
  fps?: number;
  /** Where to put the playhead once the stream is open (a re-attach resumes here). */
  startTime?: number;
  /** Start playing as soon as the first data is in (a re-attach while playing). */
  autoplay?: boolean;
  onError?: (error: Error) => void;
}

/**
 * Feed independent fMP4 clips into one browser timeline. The backend only
 * normalises each clip; concatenation exists solely inside SourceBuffer.
 */
export function attachMseSequence(
  video: HTMLVideoElement,
  clips: MseClip[],
  options: MseSequenceOptions
): () => void {
  if (!('MediaSource' in window) || !MediaSource.isTypeSupported(MSE_MIME)) {
    options.onError?.(new Error('此浏览器不支持 MSE H.264/AAC 连续播放'));
    return () => {};
  }

  const controller = new AbortController();
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  let disposed = false;
  video.src = objectUrl;

  const fail = (reason: unknown) => {
    if (disposed) return;
    options.onError?.(reason instanceof Error ? reason : new Error(String(reason)));
  };

  // Clips are fetched in order, but only as far as the playhead needs: opening a
  // cut must not download every shot in it. Clips are appended back to back,
  // so a seek far ahead fetches everything up to there, in order.
  const LOOKAHEAD_S = 30;
  let sourceBuffer: SourceBuffer | null = null;
  let next = 0;
  let appendedEnd = 0;
  let loading = false;

  const fps = options.fps ?? 24;
  // Whole frames. A length read off a <video> is the longer of its two streams
  // (the sound usually runs a few ms past the last picture); placed at that
  // length the next clip would start after a hole in the picture, and the
  // browser stalls at any hole in the buffer instead of playing on.
  const lengthOf = (clip: MseClip) => Math.max(1, Math.round(clip.duration * fps)) / fps;

  const appendClip = async (clip: MseClip) => {
    if (!Number.isFinite(clip.duration) || clip.duration <= 0) {
      throw new Error('MSE 片段时长无效');
    }
    const duration = lengthOf(clip);
    const response = await fetch(`${BACKEND_URL}/preview/mse-fragment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        video_url: resolveAssetUrl(clip.url),
        start: clip.start ?? 0,
        duration,
        width: options.width,
        height: options.height,
        fps,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const bytes = await response.arrayBuffer();
    const buffer = sourceBuffer!;
    // Each clip is placed at its own timeline start and cut to its own length.
    // Sequence mode instead continues from the end of whatever was longest in the
    // last clip -- the AAC audio runs a frame past the picture -- so every join
    // slid later than the timeline (and the export) by a frame or two.
    buffer.appendWindowEnd = Infinity;
    buffer.appendWindowStart = appendedEnd;
    buffer.appendWindowEnd = appendedEnd + duration;
    buffer.timestampOffset = appendedEnd;
    await new Promise<void>((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const error = () => { cleanup(); reject(new Error('MSE 分片追加失败')); };
      const cleanup = () => {
        buffer.removeEventListener('updateend', done);
        buffer.removeEventListener('error', error);
      };
      buffer.addEventListener('updateend', done, { once: true });
      buffer.addEventListener('error', error, { once: true });
      buffer.appendBuffer(bytes);
    });
    appendedEnd += duration;
  };

  const pump = async () => {
    if (loading || disposed || !sourceBuffer) return;
    loading = true;
    try {
      while (!disposed && next < clips.length && appendedEnd < video.currentTime + LOOKAHEAD_S) {
        await appendClip(clips[next]);
        next += 1;
      }
      if (!disposed && next >= clips.length && mediaSource.readyState === 'open') mediaSource.endOfStream();
    } catch (error) {
      if (!controller.signal.aborted) fail(error);
      if (!disposed && mediaSource.readyState === 'open') {
        try { mediaSource.endOfStream('decode'); } catch { /* already closed */ }
      }
      next = clips.length;
    } finally {
      loading = false;
    }
    // The playhead may have moved on while a clip was loading.
    if (!disposed && next < clips.length && appendedEnd < video.currentTime + LOOKAHEAD_S) void pump();
  };
  const wake = () => void pump();
  // 'waiting' fires when the playhead reaches the end of what is buffered: fetch
  // on at once instead of sitting stalled until the next timeupdate, which never
  // comes while the element is starved.
  const onWaiting = () => {
    void pump().then(() => {
      if (!disposed && wantPlay && video.paused && video.readyState >= 3) void video.play().catch(() => {});
    });
  };
  let wantPlay = Boolean(options.autoplay);
  const onPlay = () => { wantPlay = true; wake(); };
  const onPause = () => { if (!video.seeking) wantPlay = false; };
  video.addEventListener('timeupdate', wake);
  video.addEventListener('seeking', wake);
  video.addEventListener('play', onPlay);
  video.addEventListener('pause', onPause);
  video.addEventListener('waiting', onWaiting);
  video.addEventListener('stalled', onWaiting);

  mediaSource.addEventListener('sourceopen', () => {
    if (disposed) return;
    try {
      sourceBuffer = mediaSource.addSourceBuffer(MSE_MIME);
      sourceBuffer.mode = 'segments';
      // The whole length up front: without it a seek past what has been appended
      // is clamped to the appended end and never asks for the clips beyond it.
      const total = clips.reduce((sum, clip) => sum + (Number.isFinite(clip.duration) && clip.duration > 0 ? lengthOf(clip) : 0), 0);
      if (total > 0) mediaSource.duration = total;
    } catch (error) {
      fail(error);
      return;
    }
    const start = options.startTime ?? 0;
    if (start > 0) {
      const total = mediaSource.duration;
      video.currentTime = Number.isFinite(total) ? Math.min(start, Math.max(0, total - 0.05)) : start;
    }
    void pump().then(() => {
      if (!disposed && options.autoplay) void video.play().catch(() => {});
    });
  }, { once: true });

  return () => {
    disposed = true;
    controller.abort();
    video.removeEventListener('timeupdate', wake);
    video.removeEventListener('seeking', wake);
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('waiting', onWaiting);
    video.removeEventListener('stalled', onWaiting);
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  };
}
