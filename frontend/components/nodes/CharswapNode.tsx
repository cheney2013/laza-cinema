'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { provides } from '@/lib/nodeRegistry';
import { areNodePropsEqual, copyTextToClipboard } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { CharswapNode as CharswapNodeType } from '@/lib/types';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import NodeShell from './NodeShell';
import { useAutoHeightNode } from '@/hooks/useAutoHeightNode';
import GeneratingLine from './GeneratingLine';
import VideoAssetPlayer from './VideoAssetPlayer';
import { NodeActionButton, NodeActionRow } from './nodeChrome';
import NodeErrorBanner from './NodeErrorBanner';
import { SeedControl, resolveSeedForGeneration } from './SeedControl';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult, useActiveBatchInfo } from '@/hooks/useJobPoller';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { t } from '@/lib/i18n';
import { charswapRequest, swapMode, swapTargets, swapEngine, h3Accel, h3Size, swapPose } from '@/lib/charswapRequest';
import SwapTargetPicker from './SwapTargetPicker';

/**
 * Swap the performer in a clip for the person in one still — Viggle-Animate.
 *
 * Two inputs and nothing else: the still decides who, the driving clip decides
 * everything else — blocking, camera, handheld motion, the set, the light, the other
 * people. **There is no prompt on this route.** The model's text encoder is replaced by a
 * frozen 362-token embedding, so this node deliberately has no prompt port: a prompt
 * field here would be a control that does nothing.
 *
 * It replaced the Ref2VA + matting route on 2026-09-07 because it lands the swap with no
 * matting on the case that route needs matting for (a reference in the same wardrobe as
 * the source performer), holding identity across the whole clip with no bleed from the
 * reference still's own background.
 *
 * Wire the person's own photo; the node makes the reference. 换人 and 换头 first repaint one frame of
 * the driving clip with Qwen and use that frame as the reference, because a reference that does not
 * match the clip (a sunlit full-length photo for a dark indoor clip) comes out as the wrong person.
 * 换人 takes the whole person, clothes included; 换头 the face, hair colour and bangs (the clip's
 * hair length and clothes stay). 原样 sends the wired picture to Viggle untouched (a reference made
 * by hand). There is no face-only mode: Qwen kept handing back the clip's own face, and the swap
 * that followed gave a stranger. docs/CHARSWAP.md.
 *
 * A clip with several people: wire several photos and, in 换人, point at the people on a frame of the
 * clip (选要换的人). Point i is replaced with photo i, in the order the photos are wired; the people
 * not pointed at stay.
 *
 * Two things it will not do, both measured, both worth knowing before wiring it:
 *   * The face is a **blend** — hair and fringe come from the still, the bone structure
 *     stays the driving performer's. Nothing in the parameters moves this.
 *   * **Held props are lost.** Whatever the performer is holding is repainted away with
 *     them. A shot whose story is a raised prop belongs on the Ref2VA route.
 */

function SwapIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h13l-3-3" />
      <path d="M20 16H7l3 3" />
    </svg>
  );
}

function CharswapNode({ id, data, selected }: NodeProps<CharswapNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);

  const batchInfo = useActiveBatchInfo(data.jobId as string | undefined);
  const jobResult = useJobResult(data.jobId as string | undefined);

  const driveNode = connected.find((n) => provides(n, 'video'));
  const driveUrl = (driveNode?.generatedUrl || driveNode?.url) as string | undefined;

  const refUrls = connected
    .filter((n) => provides(n, 'character'))
    .map((n) => (n.generatedUrl || n.url) as string)
    .filter(Boolean);
  const refUrl = refUrls[0];

  useEffect(() => {
    if (!jobResult) return;
    if (jobResult.status === 'done' && jobResult.url) {
      const used = jobResult as { mode?: string; reference?: { url?: string }; face_prompt?: string };
      updateNodeData(id, {
        status: 'done', generatedUrl: jobResult.url as string, jobId: undefined,
        faceReferenceUrl: used.reference?.url,
        facePromptUsed: used.face_prompt,
      });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('换人失败'), jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
    }
  }, [jobResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const engine = swapEngine(data.swapEngine);
  const isH3 = engine === 'h3';
  const accel = h3Accel(data.h3Accel);
  const size = h3Size(data.h3Size);
  const pose = swapPose(data.swapPose);
  const [promptCopied, setPromptCopied] = useState(false);
  const mode = isH3 ? 'person' : swapMode(data.swapMode);
  const points = swapTargets(data.swapTargets);
  // Several photos can only be told apart by pointing at the people they become.
  const pointsOk = mode !== 'person' || refUrls.length <= 1 || points.length > 0;

  // A cancel that lands before the server has answered with a job id has no job to stop yet: it is
  // remembered here and the job is stopped the moment its id arrives.
  const cancelledRef = useRef(false);

  const run = useCallback(async () => {
    if (!driveUrl || !refUrl || !pointsOk) return;
    cancelledRef.current = false;
    const { effectiveSeed, nextSeedToStore } = resolveSeedForGeneration(
      data.seed as number | undefined,
      data.seedMode as any,
    );
    updateNodeData(id, { status: 'generating', error: undefined, seed: nextSeedToStore });
    try {
      const { job_id } = await api.charswap(charswapRequest(driveUrl, refUrls, effectiveSeed, data));
      if (cancelledRef.current) {
        await api.cancelJob(job_id).catch(() => {});
        return;
      }
      updateNodeData(id, { jobId: job_id });
    } catch (e: any) {
      if (!cancelledRef.current) updateNodeData(id, { status: 'error', error: e?.message || t('提交失败') });
    }
  }, [driveUrl, refUrl, refUrls.join('|'), pointsOk, data, id, updateNodeData]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = useCallback(async () => {
    cancelledRef.current = true;
    if (data.jobId) await api.cancelJob(data.jobId as string).catch(() => {});
    updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
  }, [data.jobId, id, updateNodeData]);

  const busy = data.status === 'generating';
  const [picking, setPicking] = useState(false);
  const ready = Boolean(driveUrl) && Boolean(refUrl) && pointsOk;

  const [isHovered, setIsHovered] = useState(false);

  // The card's height is its own layout (chrome rows at their natural height, the picture in an aspect-ratio box); only the
  // width is kept. See hooks/useAutoHeightNode.
  const sizing = useAutoHeightNode({
    id,
    ratioSources: [
      { width: data.width as number | undefined, height: data.height as number | undefined },
    ],
    hasMedia: Boolean(data.generatedUrl),
    userWidth: data.userWidth as number | undefined,
    defaultW: 451,
  });

  return (
    <NodeShell
      nodeId={id}
      spec={sizing.spec}
      selected={selected}
      onResizeEnd={sizing.onResizeEnd}
      autoHeight
    >
      <div className="node-shell-headwrap" style={{ position: 'relative', flex: '0 0 auto' }}>
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <SwapIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('换人 · Viggle')}</span>
        </div>
        <div className="flex items-center gap-1">
          {!isH3 && (
            <span className="text-[8px] font-mono text-amber-300 bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 rounded-full"
                  title={t('这条链没有提示词：身份只来自参考图，其余全来自驱动视频。人物手里拿着的东西会被一起重绘掉')}>
              {t('无提示词 · 道具会丢')}
            </span>
          )}
          <span className="text-[10px] font-mono text-zinc-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">
            {isH3 ? (accel === 'taomate3' ? 3 : 8) : 4}  {t('步')}
          </span>
        </div>
      </div>

      <div data-chrome-row="mode" className="nodrag flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2 py-1.5 text-[10px]">
        <div className="flex overflow-hidden rounded-md border border-white/10">
          {(['viggle', 'h3'] as const).map((e) => (
            <button
              key={e}
              type="button"
              disabled={busy}
              title={e === 'viggle'
                ? t('Viggle：先把驱动视频的一帧改成新人物，再用它换人。约 2 分钟，参考帧要选对；片子里姿态变化很大时会重影')
                : t('H3 原生：把整段原片和参考照片交给 H3 编辑，提示词由视觉模型看图自动写。姿态变化大的片子更稳，但更慢；只换整个人，画面里有几个人时可以点选')}
              onClick={() => updateNodeData(id, { swapEngine: e })}
              className={`px-2 py-0.5 ${engine === e ? 'bg-violet-500/25 text-violet-200' : 'bg-white/[0.03] text-zinc-400 hover:text-zinc-200'}`}
            >
              {e === 'viggle' ? 'Viggle' : t('H3 原生')}
            </button>
          ))}
        </div>
        {isH3 && (
          <>
            <div className="flex overflow-hidden rounded-md border border-white/10">
              {(['turbo8', 'taomate3'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  disabled={busy}
                  title={a === 'taomate3'
                    ? t('TaoMate 加速：3 步，约快 2.5 倍；但配合换人 LoRA 时会凭空多出原片里没有的人，不建议')
                    : t('标准加速：8 步（默认），配合换人 LoRA 能保住原片的机位、背景和其他人')}
                  onClick={() => updateNodeData(id, { h3Accel: a })}
                  className={`px-2 py-0.5 ${accel === a ? 'bg-teal-500/25 text-teal-200' : 'bg-white/[0.03] text-zinc-400 hover:text-zinc-200'}`}
                >
                  {a === 'turbo8' ? t('8 步 · 稳') : t('3 步 · 快')}
                </button>
              ))}
            </div>
            <div className="flex overflow-hidden rounded-md border border-white/10">
              {(['source', 'small'] as const).map((z) => (
                <button
                  key={z}
                  type="button"
                  disabled={busy}
                  title={z === 'source'
                    ? t('原分辨率：按驱动视频自己的尺寸（最长边最多 1376）')
                    : t('小尺寸：最长边 864，约快 4 倍，细节略软')}
                  onClick={() => updateNodeData(id, { h3Size: z })}
                  className={`px-2 py-0.5 ${size === z ? 'bg-teal-500/25 text-teal-200' : 'bg-white/[0.03] text-zinc-400 hover:text-zinc-200'}`}
                >
                  {z === 'source' ? t('原分辨率') : t('小尺寸')}
                </button>
              ))}
            </div>
            {points.length === 0 && (
              <div className="flex overflow-hidden rounded-md border border-white/10">
                {(['auto', 'follow', 'upright'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={busy}
                    title={p === 'auto'
                      ? t('姿态自动：原片主体是动物、照片是人时，让人站立行走，并按原片首尾帧写明身体和头的朝向；其他情况不加')
                      : p === 'follow'
                        ? t('姿态照原片：不加姿态说明（动物换人时人可能被画成趴着的"人形动物"）')
                        : t('姿态站立：总是让人站立行走，并按原片首尾帧写明身体和头的朝向')}
                    onClick={() => updateNodeData(id, { swapPose: p })}
                    className={`px-2 py-0.5 ${pose === p ? 'bg-teal-500/25 text-teal-200' : 'bg-white/[0.03] text-zinc-400 hover:text-zinc-200'}`}
                  >
                    {p === 'auto' ? t('姿态自动') : p === 'follow' ? t('照原片') : t('站立行走')}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {!isH3 && (
        <div className="flex overflow-hidden rounded-md border border-white/10">
          {(['person', 'head', 'reference'] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={busy}
              title={m === 'person'
                ? t('整个人换成参考照片里的人，衣服也以参考照片为准：先把驱动视频的一帧改成这个人，再用它换人')
                : m === 'head'
                  ? t('脸、发色和刘海换成参考照片的，发长和衣服保持源片；先把驱动视频的一帧改好再用它换人，姿态和光线保持原样')
                  : t('接入的图已经是做好的参考图（和驱动视频同姿态、同机位），原样交给 Viggle，不再重画')}
              onClick={() => updateNodeData(id, { swapMode: m })}
              className={`px-2 py-0.5 ${mode === m ? 'bg-teal-500/25 text-teal-200' : 'bg-white/[0.03] text-zinc-400 hover:text-zinc-200'}`}
            >
              {m === 'person' ? t('换人') : m === 'head' ? t('换头') : t('原样')}
            </button>
          ))}
        </div>
        )}
        {mode === 'person' && Boolean(driveUrl) && (
          <button
            type="button"
            disabled={busy}
            title={t('画面里有几个人时，在帧上点出要换的人：第 N 个点换成接入的第 N 张参考图，没点的人保持原样。H3 原生每个被点的人单独渲染一次，人越多越慢')}
            onClick={() => setPicking((v) => !v)}
            className={`rounded-md border border-white/10 px-2 py-0.5 ${picking || points.length ? 'bg-teal-500/25 text-teal-200' : 'bg-white/[0.03] text-zinc-400 hover:text-zinc-200'}`}
          >
            {t('选要换的人')}{points.length ? ` · ${points.length}` : ''}
          </button>
        )}
        {!isH3 && mode !== 'reference' && (
        <label className="flex items-center gap-1 text-zinc-400" title={t('取驱动视频的哪一秒来改脸。选脸朝向镜头的那一帧；留空取中间')}>
          {t('取脸帧（秒）')}
          <input
            type="number"
            min={0}
            step={0.1}
            value={typeof data.faceFrameSeconds === 'number' ? data.faceFrameSeconds : ''}
            placeholder={t('中间')}
            disabled={busy}
            onChange={(e) => updateNodeData(id, {
              faceFrameSeconds: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)),
            })}
            className="w-12 rounded border border-white/10 bg-black/30 px-1 py-0.5 text-zinc-200"
          />
        </label>
        )}
        {mode === 'person' && picking && driveUrl && (
          <SwapTargetPicker
            videoSrc={`${API_BASE}${driveUrl}`}
            photoSrcs={refUrls.map((u) => `${API_BASE}${u}`)}
            seconds={typeof data.faceFrameSeconds === 'number' ? data.faceFrameSeconds : undefined}
            points={points}
            disabled={busy}
            onSeconds={(s) => updateNodeData(id, { faceFrameSeconds: s })}
            onPoints={(p) => updateNodeData(id, { swapTargets: p })}
          />
        )}
        {mode !== 'reference' && (
        <textarea
          rows={2}
          value={typeof data.facePrompt === 'string' ? data.facePrompt : ''}
          placeholder={isH3 ? t('H3 提示词（留空=自动，由视觉模型看原片的几帧和照片来写六段式提示词）') : t('改脸提示词（留空=自动，由视觉模型看图来写）')}
          title={t('Qwen 改脸用的完整提示词，<image 1> 是驱动视频的那一帧，<image 2> 是参考照片。留空时由视觉模型看这两张图自动写；想自己控制就写清帧里是谁、穿什么、在哪，哪些必须不变，新的发型是什么')}
          disabled={busy}
          onChange={(e) => updateNodeData(id, { facePrompt: e.target.value })}
          className="nowheel order-last w-full basis-full resize-none rounded border border-white/10 bg-black/30 px-1.5 py-1 leading-snug text-zinc-200 placeholder:text-zinc-600"
        />
        )}
        {(() => {
          // The instruction of the last run (written by the vision model unless typed) or, before any run, the typed one:
          // copied to be read in a translator.
          const shown = (typeof data.facePromptUsed === 'string' && data.facePromptUsed.trim())
            || (typeof data.facePrompt === 'string' ? data.facePrompt.trim() : '');
          return shown ? (
            <button
              type="button"
              title={t('复制这次实际用的提示词（留空时是视觉模型自动写的那条），可以粘贴到翻译软件里看')}
              onClick={() => void copyTextToClipboard(shown)
                .then(() => { setPromptCopied(true); setTimeout(() => setPromptCopied(false), 1500); })
                .catch(() => undefined)}
              className="rounded border border-white/10 bg-white/[0.03] px-2 py-0.5 text-zinc-400 hover:text-zinc-200"
            >
              {promptCopied ? t('✓ 已复制') : t('复制提示词')}
            </button>
          ) : null;
        })()}
        {typeof data.faceReferenceUrl === 'string' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${API_BASE}${data.faceReferenceUrl}`}
            alt=""
            title={`${t('这次用的参考图（驱动视频的一帧改脸后的结果）')}${
              typeof data.facePromptUsed === 'string' && data.facePromptUsed ? `\n\n${data.facePromptUsed}` : ''}`}
            className="ml-auto h-6 rounded border border-white/10"
          />
        )}
      </div>
      </div>

      <div
        style={{ ...cardBody, flex: '0 0 auto', display: 'flex', flexDirection: 'column', overflow: 'hidden',
                 boxShadow: selected ? selectedShadow : defaultShadow }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* The picture's box has the picture's own ratio, so the card is exactly as tall as its media needs. */}
        <div style={{ aspectRatio: String(sizing.ratio), display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {data.generatedUrl ? (
          <VideoAssetPlayer
            nodeId={id}
            src={`${API_BASE}${data.generatedUrl}`}
            fps={data.fps as number | undefined}
            onMediaSize={sizing.onMediaSize}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-1 px-4 text-center">
            <div className="text-[11px] text-zinc-500">
              {!driveUrl
                ? t('接入驱动视频')
                : !refUrl
                  ? t('接入角色参考图')
                  : !pointsOk
                    ? t('接了多张参考图：先点「选要换的人」，在帧上点出每张图对应的人')
                    : t('就绪')}
            </div>
            <div className="text-[9px] text-zinc-600 leading-relaxed">
              
              {t('参考图决定是谁，驱动视频决定走位、机位、')}<br />{t('场景和其他人。不用抠图，也没有提示词')}
            </div>
          </div>
        )}
        </div>

        <GeneratingLine active={busy} jobId={data.jobId as string | undefined} statusText={batchInfo || '生成中'} onCancel={cancel} />
        <NodeErrorBanner error={data.error as string | undefined} onClear={() => updateNodeData(id, { error: undefined })} />

        <NodeActionRow visible={isHovered || !data.generatedUrl}>
          <SeedControl
            seed={data.seed as number | undefined}
            seedMode={data.seedMode as any}
            onChange={(newSeed, newMode) => updateNodeData(id, { seed: newSeed, seedMode: newMode })}
            compact
          />
          <NodeActionButton accent="teal" grow onClick={run} disabled={!ready || busy || !comfyuiOnline}>
            
            {t('生成')}
          </NodeActionButton>
        </NodeActionRow>
      </div>

      <IconHandle type="target" id="in-video" portType="video" nodeId={id} style={{ top: '35%' }} title={t('驱动视频（走位、机位、场景、其他人都来自它）')} />
      <IconHandle type="target" id="in-character" portType="character" nodeId={id} style={{ top: '65%' }} title={t('角色参考图（只决定换成谁）。画面里有几个人时可接多张，按接入顺序对应点选的第 N 个人')} />
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} title={t('输出换人后的视频')} />
    </NodeShell>
  );
}

export default memo(CharswapNode, areNodePropsEqual);
