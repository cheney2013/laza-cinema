'use client';

import { memo, useRef } from 'react';
import { useVersionedSrc } from '@/lib/assetVersions';
import { useFrameGrab } from '@/lib/frameGrab';
import { MediaCameraIcon, MediaCloseIcon, MediaMaximizeIcon, MediaSpinnerIcon, MediaUploadIcon } from './mediaChrome';
import NodeVideoPlayer from './NodeVideoPlayer';
import { t } from '@/lib/i18n';

/**
 * Asset-node video: the shared node player (the H3 node's) with the asset
 * actions -- grab frame, replace, expand, remove -- in its action row.
 */

interface Props {
  nodeId: string;
  src: string;
  /** Kept for callers; the shared player has no frame stepping. */
  fps?: number;
  uploading?: boolean;
  onMediaSize?: (width: number, height: number) => void;
  onDuration?: (duration: number) => void;
  onReplace?: () => void;
  onRemove?: (e: React.MouseEvent) => void;
  onExpand?: () => void;
  /** External request to pause (e.g. a preview modal opened). */
  paused?: boolean;
  /** Duration/size not recorded yet: load the video on mount, not on hover. */
  needsMetadata?: boolean;
}

const btn = 'p-1 rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer';

function VideoAssetPlayer({ nodeId, src: rawSrc, uploading, onMediaSize, onDuration, onReplace, onRemove, onExpand, paused, needsMetadata }: Props) {
  // An asset overwritten in place keeps its URL; the version makes <video> fetch it again.
  const src = useVersionedSrc(rawSrc);
  const videoRef = useRef<HTMLVideoElement>(null);
  const grabFrame = useFrameGrab();

  return (
    <div className="video-asset-player relative flex-1 min-h-0 overflow-hidden rounded-2xl bg-black">
      <NodeVideoPlayer
        nodeId={nodeId}
        src={src}
        videoRef={videoRef}
        paused={paused}
        eager={needsMetadata}
        onMediaSize={onMediaSize}
        onDuration={onDuration}
        actions={<>
          <div className="node-shell-btnrow flex items-center gap-1">
            <button className={btn} title={t('抽取当前帧至画布')} onClick={() => void grabFrame(videoRef.current, nodeId)}>
              <MediaCameraIcon />
            </button>
            {onExpand && (
              <button className={btn} title={t('放大查看')} onClick={() => { videoRef.current?.pause(); onExpand(); }}>
                <MediaMaximizeIcon />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {onReplace && (
              <button className={btn} title={t('替换素材（也可直接把文件拖到节点上）')} onClick={() => onReplace()}>
                {uploading ? <MediaSpinnerIcon /> : <MediaUploadIcon />}
              </button>
            )}
            {onRemove && (
              <button className={`${btn} hover:!text-red-400`} title={t('移除素材')} onClick={(e) => onRemove(e)}>
                <MediaCloseIcon />
              </button>
            )}
          </div>
        </>}
      />
    </div>
  );
}

export default memo(VideoAssetPlayer);
