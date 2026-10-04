'use client';

import type { SubmittedResource, SubmittedResources } from '@/lib/types';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { useVideoProbe } from '@/lib/videoProbe';
import { t } from '@/lib/i18n';

/** One frame of the reference clip. A <video> per tile counted against Chrome's
 *  per-page player cap (2026-09-06); a still shows the same thing for free. */
function VideoThumb({ url }: { url: string }) {
  const probe = useVideoProbe(url);
  return probe?.poster ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={probe.poster} alt="" className="h-16 w-full object-cover" />
  ) : (
    <div className="h-16 w-full bg-black/40" />
  );
}

function mediaUrl(url: string) {
  return url.startsWith('http') || url.startsWith('blob:') || url.startsWith('data:')
    ? url
    : `${API_BASE}${url}`;
}

export default function SubmittedResourcesPanel({ resources }: { resources?: SubmittedResources }) {
  const allGroups: Array<{ label: string; kind: 'image' | 'video' | 'audio'; items: SubmittedResource[] }> = [
    { label: '首帧', kind: 'image', items: resources?.first_frame ? [resources.first_frame] : [] },
    { label: '尾帧', kind: 'image', items: resources?.last_frame ? [resources.last_frame] : [] },
    { label: '参考图', kind: 'image', items: resources?.reference_images || [] },
    { label: t('参考视频'), kind: 'video', items: resources?.reference_videos || [] },
    { label: t('参考音频'), kind: 'audio', items: resources?.reference_audios || [] },
  ];
  const groups = allGroups.filter((group) => group.items.length > 0);

  if (!groups.length) {
    return <p className="text-[9px] text-zinc-500">{t('本次生成没有提交外部参考资源。')}</p>;
  }

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="mb-1 text-[9px] font-mono text-zinc-500">{group.label} · {group.items.length}</div>
          <div className="grid grid-cols-3 gap-1.5">
            {group.items.map((item, index) => (
              <div key={`${group.label}-${index}-${item.url}`} className="overflow-hidden rounded-md border border-white/10 bg-black/40">
                {group.kind === 'image' ? (
                  <img src={mediaUrl(item.url)} alt={`${group.label} ${index + 1}`} className="h-16 w-full object-cover" />
                ) : group.kind === 'video' ? (
                  <VideoThumb url={mediaUrl(item.url)} />
                ) : (
                  <div className="flex h-16 items-center justify-center text-lg text-zinc-400">♪</div>
                )}
                <div className="truncate px-1.5 py-1 text-[8px] font-mono text-zinc-400" title={item.comfy_filename || item.url}>
                  {group.label}{index + 1} · {item.comfy_filename || item.url.split('/').pop()}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
