/**
 * What a clip wired into in-motion-context hands to the clip after it. Mirrors
 * _chain_carry / _chain_end_frame in backend/canvas_mcp_server.py so the studio's run
 * button submits what the MCP run would.
 *
 * Normally the join is the previous clip's saved latent. With data.motionContextAtFrame = N
 * the clip carries on from frame N of the previous one (a cutaway in between makes its end the
 * wrong place), which a latent cannot do: only the pictures are cut at N, so the video is sent.
 */
export type ChainParent = { type?: string; latentFilename?: string; generatedUrl?: string; url?: string } | undefined;

export type ChainRequest = {
  motion_context_latent?: string;
  motion_context_video?: string;
  motion_context_end_frame?: number;
};

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;

export function resolveChain(parent: ChainParent, manualLatent: unknown, atFrame: unknown): ChainRequest {
  const at = Math.round(Number(atFrame) || 0);
  if (at < 0) throw new Error(`motionContextAtFrame must be above 0 (got ${atFrame}); clear it to continue from the end.`);
  if (at > 0) {
    const url = String(parent?.generatedUrl || parent?.url || '');
    if (!url || !VIDEO_EXT.test(url.split('?')[0])) return {};
    return { motion_context_video: url, motion_context_end_frame: at };
  }
  const latent = String(parent?.latentFilename || manualLatent || '');
  if (latent) return { motion_context_latent: latent };
  // Anything else that is a video file has no latent but has pictures and sound: an uploaded clip, a trim,
  // an edit. The backend reads its frames and audio instead (what _chain_carry does for the canvas server).
  // This used to cover a trim only, so a shot wired to an uploaded clip started on its own with no
  // continuation and no overlap, without a word (c23b, 2026-10-02).
  const video = String(parent?.generatedUrl || parent?.url || '');
  if (video && VIDEO_EXT.test(video.split('?')[0])) return { motion_context_video: video };
  return {};
}
