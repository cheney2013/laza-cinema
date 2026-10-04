'use client';

import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import AudioPlayer from './AudioPlayer';
import NodeShell from './NodeShell';
import GeneratingLine from './GeneratingLine';
import { SeedControl, resolveSeedForGeneration } from './SeedControl';
import { AudioGenNode as AudioGenNodeType, AudioGenNodeData } from '@/lib/types';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { cardBody, header, label } from './PromptNode';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult, useActiveBatchInfo } from '@/hooks/useJobPoller';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { areNodePropsEqual, downloadFile } from '@/lib/utils';
import { t } from '@/lib/i18n';

/**
 * 配音 / 换音色.
 *
 * speak:   台词 + 音色描述和/或 in-ref-audio -> H3 说这句话，只留声音。
 * convert: in-source-audio 的台词和节奏不变，换成 in-ref-audio 的音色（Seed-VC）；
 *          没接参考音频时先让 H3 按音色描述说一句样本，再用样本当音色。
 */
function AudioGenNode({ id, data, selected }: NodeProps<AudioGenNodeType>) {
  const { updateNodeData, setNodes } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const cancelledRef = useRef(false);
  // With a result on the node the player is the content; the form is behind ⚙.
  const [editing, setEditing] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const batchInfo = useActiveBatchInfo(data.jobId as string | undefined);
  const jobResult = useJobResult(data.jobId as string | undefined);

  useEffect(() => {
    if (!jobResult || cancelledRef.current) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, {
        status: 'done', generatedUrl: jobResult.url as string, jobId: undefined,
        compiledPrompt: (jobResult.compiled_prompt as string) ?? null,
        sampleUrl: (jobResult.sample_url as string) ?? null,
      });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('生成失败'), jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
    }
  }, [jobResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // The box follows what it shows: a player strip once there is a result, the
  // full form otherwise. Height is written top-level (React Flow v12 ignores
  // style.height once it has measured the node).
  const compact = !!data.generatedUrl && !editing;
  useEffect(() => {
    const height = compact ? 190 : 420;
    setNodes((nodes) => nodes.map((n) => (n.id === id && n.height !== height ? { ...n, height } : n)));
  }, [compact, id, setNodes]);

  const urlOn = (handle: string) => {
    const n = connected.find((c) => c.targetHandle === handle);
    return n ? ((n.generatedUrl || n.url) as string | null) : null;
  };
  const refAudioUrl = urlOn('in-ref-audio');
  const sourceAudioUrl = urlOn('in-source-audio');

  const mode = data.mode || 'speak';
  const hasVoice = !!refAudioUrl || !!(data.voiceDescription || '').trim();
  const missing = mode === 'speak'
    ? (!(data.text || '').trim() ? t('填写台词') : !hasVoice ? t('填写音色描述或接参考音频') : null)
    : (!sourceAudioUrl ? t('接入要换音色的音频') : !hasVoice ? t('填写音色描述或接参考音频') : null);
  const isGenerating = data.status === 'generating';
  const canGenerate = comfyuiOnline && !missing && !isGenerating;

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    cancelledRef.current = false;
    const { effectiveSeed, nextSeedToStore } = resolveSeedForGeneration(data.seed, data.seedMode, 81000);
    updateNodeData(id, {
      status: 'generating', jobId: undefined, error: undefined,
      ...(data.seedMode === 'random' ? { seed: nextSeedToStore } : {}),
    });
    try {
      const { job_id } = await api.generateSpeech({
        mode,
        text: data.text || '',
        voice_description: data.voiceDescription || '',
        delivery: data.delivery || '',
        ref_audio_url: refAudioUrl,
        source_audio_url: mode === 'convert' ? sourceAudioUrl : null,
        length: data.length || 0,
        seed: effectiveSeed,
        trim_silence: data.trimSilence ?? true,
        diffusion_steps: data.diffusionSteps ?? 30,
        semitone_shift: data.semitoneShift ?? 0,
      });
      if (cancelledRef.current) return;
      updateNodeData(id, { jobId: job_id });
    } catch (e: any) {
      if (!cancelledRef.current) updateNodeData(id, { status: 'error', error: e.message, jobId: undefined });
    }
  }, [canGenerate, data, mode, refAudioUrl, sourceAudioUrl, id, updateNodeData]);

  const handleCancel = useCallback(async () => {
    cancelledRef.current = true;
    if (data.jobId) {
      try { await api.cancelJob(data.jobId as string); } catch {}
    }
    updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
  }, [id, updateNodeData, data.jobId]);

  const sizing = useNodeSizing({
    id,
    type: 'audioGen',
    rows: ['header'],
    hasMedia: false,
    userWidth: data.userWidth as number | undefined,
    deps: [mode, data.generatedUrl, data.status, editing],
  });

  const focusIn = () => window.dispatchEvent(new Event('inputFocused'));
  const focusOut = () => window.dispatchEvent(new Event('inputBlurred'));
  const field: React.CSSProperties = {
    width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 8, padding: '6px 8px', color: '#eee', fontSize: 12, outline: 'none',
    fontFamily: 'inherit', resize: 'vertical',
  };
  const small: React.CSSProperties = { fontSize: 10, color: '#888', marginBottom: 3 };
  const tab = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '4px 0', borderRadius: 8, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
    border: '1px solid ' + (active ? 'rgba(255,255,255,0.25)' : 'transparent'),
    background: active ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.04)',
    color: active ? '#fff' : '#999',
  });
  const numberRow = (lbl: string, value: number, set: (v: number) => void, min: number, max: number) => (
    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: '#bbb' }}>
      <span>{lbl}</span>
      <input type="number" className="nodrag" value={value} min={min} max={max}
        onChange={(e) => set(+e.target.value)} onFocus={focusIn} onBlur={focusOut}
        style={{ ...field, width: 72, padding: '2px 8px', textAlign: 'right', resize: undefined }} />
    </label>
  );

  return (
    <NodeShell nodeId={id} spec={sizing.spec} selected={selected} onResizeEnd={sizing.onResizeEnd} shellRef={sizing.shellRef}>
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <span style={label} className="text-zinc-200" data-chrome="label">{t('配音 / 换音色')}</span>
        </div>
      </div>

      <div style={{ ...cardBody, position: 'relative', flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.generatedUrl && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#888' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={data.text || ''}>
                {mode === 'speak' ? (data.text || '') : t('换音色')}
              </span>
              <button className="nodrag" title={t('下载')}
                onClick={() => void downloadFile(`${API_BASE}${data.generatedUrl}`, (data.generatedUrl || '').split('/').pop() || 'speech.wav', data.alias as string | undefined)}
                style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 13 }}>↓</button>
              <button className="nodrag" title={t('设置')} onClick={() => setEditing((v) => !v)}
                style={{ background: editing ? 'rgba(255,255,255,0.15)' : 'none', border: 'none', borderRadius: 6, color: editing ? '#fff' : '#aaa', cursor: 'pointer', fontSize: 13 }}>⚙</button>
            </div>
            <div style={{ borderRadius: 14, background: 'rgba(0,0,0,0.55)', padding: '14px 12px' }}>
              <AudioPlayer src={`${API_BASE}${data.generatedUrl}`} paused={isGenerating} />
            </div>
          </div>
        )}

        {(!data.generatedUrl || editing) && (<>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="nodrag" style={tab(mode === 'speak')} onClick={() => updateNodeData(id, { mode: 'speak' })}>{t('说台词')}</button>
          <button className="nodrag" style={tab(mode === 'convert')} onClick={() => updateNodeData(id, { mode: 'convert' })}>{t('换音色')}</button>
        </div>

        <div>
          <div style={small}>{mode === 'speak' ? t('台词') : t('样本台词（仅在没接参考音频时用，可留空）')}</div>
          <textarea className="nodrag nowheel" rows={mode === 'speak' ? 3 : 2} style={field}
            value={data.text || ''} onChange={(e) => updateNodeData(id, { text: e.target.value })}
            onFocus={focusIn} onBlur={focusOut} />
        </div>
        <div>
          <div style={small}>{t('音色描述（建议英文，例如 a tired middle-aged man with a low raspy voice）')}</div>
          <textarea className="nodrag nowheel" rows={2} style={field}
            value={data.voiceDescription || ''} onChange={(e) => updateNodeData(id, { voiceDescription: e.target.value })}
            onFocus={focusIn} onBlur={focusOut} />
        </div>
        {mode === 'speak' && (
          <div>
            <div style={small}>{t('语气（可选，例如 quietly, almost whispering）')}</div>
            <input className="nodrag" style={field}
              value={data.delivery || ''} onChange={(e) => updateNodeData(id, { delivery: e.target.value })}
              onFocus={focusIn} onBlur={focusOut} />
          </div>
        )}

        <div style={{ fontSize: 10, color: '#777', lineHeight: 1.5 }}>
          {t('参考音频')}：{refAudioUrl ? refAudioUrl.split('/').pop() : t('未接')}
          {mode === 'convert' && (<><br />{t('要换音色的音频')}：{sourceAudioUrl ? sourceAudioUrl.split('/').pop() : t('未接')}</>)}
        </div>

        <div className="nodrag" style={{ fontSize: 11, color: '#aaa' }}>
          <button type="button" style={{ cursor: 'pointer' }} onClick={() => setShowParams((v) => !v)}>
            {showParams ? '▾' : '▸'} {t('参数')}
          </button>
          {showParams && (
          <div data-node-expand style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {mode === 'convert' ? (
              <>
                {numberRow(t('扩散步数'), data.diffusionSteps ?? 30, (v) => updateNodeData(id, { diffusionSteps: v }), 4, 100)}
                {numberRow(t('变调（半音）'), data.semitoneShift ?? 0, (v) => updateNodeData(id, { semitoneShift: v }), -24, 24)}
              </>
            ) : (
              <>
                {numberRow(t('帧数（0 = 按台词估算）'), data.length ?? 0, (v) => updateNodeData(id, { length: v }), 0, 430)}
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: '#bbb' }}>
                  <span>{t('去掉首尾静音')}</span>
                  <input type="checkbox" className="nodrag" checked={data.trimSilence ?? true}
                    onChange={(e) => updateNodeData(id, { trimSilence: e.target.checked })} />
                </label>
              </>
            )}
            <SeedControl seed={data.seed} seedMode={data.seedMode}
              onChange={(seed, seedMode) => updateNodeData(id, { seed, seedMode })} />
          </div>
          )}
        </div>

        </>)}

        {data.status === 'error' && (
          <div style={{ fontSize: 11, color: '#f87171', lineHeight: 1.4, wordBreak: 'break-word' }}>{data.error || t('处理失败')}</div>
        )}

        <button className="nodrag" onClick={handleGenerate} disabled={!canGenerate} title={missing || ''}
          style={{
            width: '100%', padding: '8px 0', borderRadius: 10, fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
            background: canGenerate ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)',
            color: canGenerate ? '#fff' : '#666',
            border: canGenerate ? '1px solid rgba(255,255,255,0.2)' : '1px solid transparent',
            cursor: canGenerate ? 'pointer' : 'not-allowed',
          }}>
          {missing || (mode === 'speak' ? t('生成配音 (H3)') : t('换音色 (Seed-VC)'))}
        </button>
        <GeneratingLine active={isGenerating} jobId={data.jobId as string | undefined} steps={1} statusText={batchInfo} onCancel={handleCancel} />
      </div>

      <IconHandle type="target" id="in-ref-audio" portType="audio" nodeId={id} style={{ top: '35%' }} title={t('参考音色')} />
      <IconHandle type="target" id="in-source-audio" portType="audio" nodeId={id} style={{ top: '65%' }} title={t('要换音色的音频')} />
      <IconHandle type="source" id="out-audio" portType="audio" nodeId={id} title={t('音频')} />
    </NodeShell>
  );
}

export default memo(AudioGenNode, areNodePropsEqual);
