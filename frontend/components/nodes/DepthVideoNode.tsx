'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { NodeProps, useReactFlow } from '@xyflow/react';

import IconHandle from './IconHandle';
import NodeShell from './NodeShell';
import GeneratingLine from './GeneratingLine';
import NodeErrorBanner from './NodeErrorBanner';
import NodeVideoPlayer from './NodeVideoPlayer';
import { NodeActionButton, NodeHeaderIconButton } from './nodeChrome';
import { MediaBottomBar, MediaDownloadIcon, MediaMetaChip } from './mediaChrome';
import { GearIcon } from '@/components/ui/icons';
import { showAlert } from '@/components/ui/Dialog';
import { cardBody, defaultShadow, header, label, selectedShadow } from './PromptNode';
import { provides } from '@/lib/nodeRegistry';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult, useActiveBatchInfo } from '@/hooks/useJobPoller';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import { api } from '@/lib/api';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { t } from '@/lib/i18n';
import { useStore } from '@/lib/store';
import { DepthVideoNode as DepthVideoNodeType } from '@/lib/types';
import { areNodePropsEqual, downloadFile } from '@/lib/utils';

/** The model's working size, a multiple of 14; the result is scaled back to the clip's own size. */
const RESOLUTIONS = [
  { value: 392, label: '392（快）' },
  { value: 518, label: '518（默认）' },
  { value: 700, label: '700（细）' },
] as const;

const abs = (u: string) => (u.startsWith('http') || u.startsWith('blob:') ? u : `${API_BASE}${u}`);

/**
 * A clip's per-frame depth as a silent video (Depth Anything V2).
 *
 * Two uses: a camera reference on a video node's 运镜参考 port (H3 learns the space and the
 * camera move, and cannot copy faces, costumes or the look), or, with the video node's
 * useRefVideoAsControl set, the Fun ControlNet's control video. The whole clip is processed:
 * trim it with 视频剪切 first to use a part of it.
 */
function DepthVideoNode({ id, data, selected }: NodeProps<DepthVideoNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const cancelledRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [hovered, setHovered] = useState(false);
  const batchInfo = useActiveBatchInfo(data.jobId as string | undefined);

  const connectedVideo = connected.find((n) => provides(n, 'video'));
  const sourceVideoUrl = connectedVideo ? ((connectedVideo.generatedUrl || connectedVideo.url) as string | null) : null;
  const resolution = (data.resolution as number) || 518;
  const busy = data.status === 'generating';

  const jobResult = useJobResult(data.jobId as string | undefined);
  useEffect(() => {
    if (!jobResult || cancelledRef.current) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, { status: 'done', generatedUrl: jobResult.url as string, jobId: undefined, error: undefined });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('提取深度失败'), jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', error: undefined, jobId: undefined });
    }
  }, [jobResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show the depth once there is one, the source clip until then.
  const shownUrl = data.generatedUrl || sourceVideoUrl;
  const videoSrc = shownUrl ? abs(shownUrl as string) : null;

  const run = useCallback(async () => {
    if (!sourceVideoUrl || busy) return;
    cancelledRef.current = false;
    videoRef.current?.pause();
    updateNodeData(id, {
      status: 'generating', jobId: undefined, error: undefined, sourceUrl: sourceVideoUrl,
      width: connectedVideo?.width, height: connectedVideo?.height,
    });
    try {
      const { job_id } = await api.generateVideoDepth({ video_url: abs(sourceVideoUrl), resolution });
      if (cancelledRef.current) return;
      updateNodeData(id, { jobId: job_id });
    } catch (e: any) {
      if (!cancelledRef.current) updateNodeData(id, { status: 'error', error: e?.message || t('提交失败'), jobId: undefined });
    }
  }, [sourceVideoUrl, busy, resolution, id, updateNodeData, connectedVideo?.width, connectedVideo?.height]);

  const cancel = useCallback(async () => {
    cancelledRef.current = true;
    if (data.jobId) await api.cancelJob(data.jobId as string).catch(() => {});
    updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
  }, [data.jobId, id, updateNodeData]);

  const sizing = useNodeSizing({
    id,
    type: 'depthVideo',
    rows: ['header', 'settings'],
    activeRows: showSettings ? ['header', 'settings'] : ['header'],
    paddingX: 0,
    ratioSources: [{ width: connectedVideo?.width as number | undefined, height: connectedVideo?.height as number | undefined }],
    hasMedia: Boolean(videoSrc),
    userWidth: data.userWidth as number | undefined,
  });

  return (
    <NodeShell nodeId={id} spec={sizing.spec} selected={selected} onResizeEnd={sizing.onResizeEnd} shellRef={sizing.shellRef}>
      <div className="node-shell-headwrap" style={{ position: 'relative', flex: '0 0 auto' }}>
        <div style={header} data-chrome-row="header" className="node-shell-header flex items-center justify-between">
          <div className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.05] px-2 py-0.5 text-zinc-300">
            <DepthIcon />
            <span style={label} className="text-zinc-200" data-chrome="label">{t('深度视频')}</span>
          </div>
          <div className="flex items-center gap-1">
            <MediaMetaChip title={t('Depth Anything V2，整段视频')}>
              {data.generatedUrl ? t('深度') : t('原片')}
            </MediaMetaChip>
            <NodeHeaderIconButton active={showSettings} onClick={() => setShowSettings((v) => !v)} title={t('处理分辨率')}>
              <GearIcon />
            </NodeHeaderIconButton>
          </div>
        </div>

        {showSettings && (
          <div data-chrome-row="settings" className="node-shell-drawer nodrag nowheel p-3 space-y-2.5 text-[10px] animate-in fade-in duration-150">
            <label className="block space-y-1">
              <span className="text-zinc-400">{t('处理分辨率')}</span>
              <select
                value={resolution}
                onChange={(e) => updateNodeData(id, { resolution: Number(e.target.value) })}
                className="w-full rounded border border-white/10 bg-black/30 px-1.5 py-1 text-zinc-200"
              >
                {RESOLUTIONS.map((r) => <option key={r.value} value={r.value}>{t(r.label)}</option>)}
              </select>
            </label>
            <p className="text-[9px] leading-relaxed text-zinc-500">
              {t('整段视频逐帧估计深度，输出无声视频。只要其中一段，先用「视频剪切」截出来。接到视频节点的「运镜参考」口，H3 只能学到空间和机位，抄不到人脸和画面质感。')}
            </p>
          </div>
        )}
      </div>

      <div data-node-media
        style={{ ...cardBody, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', boxShadow: selected ? selectedShadow : defaultShadow }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {videoSrc ? (
          <NodeVideoPlayer
            nodeId={id}
            src={videoSrc}
            videoRef={videoRef}
            selected={selected}
            holdPlayback={busy}
            paused={showSettings}
            onMediaSize={sizing.onMediaSize}
            actions={<><span />{data.generatedUrl ? (
              <button
                type="button"
                className="nodrag"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc' }}
                title={t('下载')}
                onClick={(e) => {
                  e.stopPropagation();
                  void downloadFile(abs(data.generatedUrl as string), 'depth-video.mp4', data.alias as string | undefined)
                    .catch((error) => void showAlert(error.message));
                }}
              >
                <MediaDownloadIcon />
              </button>
            ) : <span />}</>}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-4 text-center text-[11px] text-zinc-500">
            {t('左侧接一段视频，点「提取深度」。')}
          </div>
        )}

        <GeneratingLine active={busy} jobId={data.jobId as string | undefined} steps={1} statusText={batchInfo || t('正在提取深度')} onCancel={cancel} />
        <NodeErrorBanner error={data.status === 'error' ? (data.error as string) : null} onClear={() => updateNodeData(id, { status: 'idle', error: undefined })} />

        <MediaBottomBar visible={hovered || !data.generatedUrl}>
          <NodeActionButton accent="sky" grow onClick={() => void run()} disabled={!sourceVideoUrl || busy || !comfyuiOnline}>
            {!sourceVideoUrl ? t('先接一段视频') : data.generatedUrl ? t('重新提取') : t('提取深度')}
          </NodeActionButton>
        </MediaBottomBar>
      </div>

      <IconHandle type="target" id="in-video" portType="video" nodeId={id} title={t('输入视频')} />
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} title={t('深度视频')} />
    </NodeShell>
  );
}

function DepthIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
      <path d="M3 17.5l9 5 9-5" opacity="0.5" />
    </svg>
  );
}

export default memo(DepthVideoNode, areNodePropsEqual);
