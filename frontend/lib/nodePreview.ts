import { posterUrl, resolveAssetUrl } from './config';

/**
 * What to show for a node in a small space: a picture, a clip's poster, or a line
 * of text. Used by the edge hover cards and by the outline-mode thumbnails.
 */
export function nodePreview(data: Record<string, unknown> | undefined, type?: string): { image: string | null; text: string } {
  const d = (data || {}) as Record<string, any>;
  const url: string | null = d.generatedUrl || d.url || d.imageUrl || d.videoUrl || d.previewUrl || null;
  const text = String(d.label || d.alias || d.text || d.prompt || type || '').slice(0, 60);
  if (!url || d.mediaType === 'audio' || /\.(wav|mp3|m4a|flac|ogg)(\?|$)/i.test(url)) return { image: null, text };
  const abs = resolveAssetUrl(url);
  return { image: /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url) ? posterUrl(abs) : abs, text };
}
