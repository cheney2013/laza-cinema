'use client';

import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { BACKEND_URL as API_BASE } from '@/lib/config';

/**
 * 抽帧 —— 把播放头当前那一帧落成画布上的图片节点。
 *
 * 这件事原本只长在 H3 生成节点和视频编辑节点上，各写了一份几乎一样的代码；
 * 素材、超分、补帧、换人、对比这些同样在播视频的卡片上没有，义哥要用某一帧当
 * 参考图时只能先下载再拖回来。现在只此一份，所有挂视频的节点共用。
 *
 * 两个要点，都是踩过的：
 *  - 必须回传后端存成文件。`data:` URL 在 <img> 里显示正常，但这张图之后被当作
 *    参考图使用时解析不到文件。
 *  - 存进画布的是后端相对路径，绝不是带 host 的绝对地址：API_BASE 取自打开页面的
 *    地址，写死进画布后换一台机器打开同一项目就指向不存在的 localhost。
 */
export function useFrameGrab() {
  const { getNodes, setNodes } = useReactFlow();

  return useCallback(
    async (video: HTMLVideoElement | null | undefined, sourceNodeId?: string) => {
      if (!video) return null;
      try {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height || video.readyState < 2) return null;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/png');

        let imageUrl = dataUrl;
        try {
          const res = await fetch(`${API_BASE}/upload-image-base64`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: dataUrl, purpose: 'frame' }),
          });
          if (!res.ok) throw new Error(`upload failed: ${res.status}`);
          const { url } = await res.json();
          imageUrl = url;
        } catch (upErr) {
          console.error('Frame grab upload failed, keeping inline data URL:', upErr);
        }

        const srcNode = sourceNodeId ? getNodes().find((n) => n.id === sourceNodeId) : undefined;
        const position = srcNode
          ? { x: srcNode.position.x + (srcNode.measured?.width || 340) + 40, y: srcNode.position.y }
          : { x: 100, y: 100 };
        const newNodeId = `upload-${Date.now()}`;

        setNodes((nds) => [
          ...nds,
          {
            id: newNodeId,
            type: 'image',
            position,
            data: { url: imageUrl, width, height, mediaType: 'image' },
          },
        ]);
        return newNodeId;
      } catch (err) {
        // 跨域画面会污染 canvas，drawImage 之后 toDataURL 直接抛
        console.error('Frame grab failed (CORS/tainted canvas):', err);
        return null;
      }
    },
    [getNodes, setNodes],
  );
}

