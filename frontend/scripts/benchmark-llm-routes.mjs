import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const origin = process.argv[2] || 'http://127.0.0.1:4000';
const imagePath = process.argv[3] ? resolve(process.argv[3]) : null;
const selected = new Set((process.argv[4] || '').split(',').filter(Boolean));

async function dataUrl(path) {
  if (!path) return null;
  const mime = extname(path).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${(await readFile(path)).toString('base64')}`;
}

const image = await dataUrl(imagePath);
const cases = [
  ['assistant', '/api/assistant', {
    messages: [{ role: 'user', content: '创建一个1280x720的雨夜街道图像节点，只返回可执行JSON。' }],
    nodes: [], edges: [], selectedNodeIds: [],
  }],
  ['translate', '/api/translate', { text: '一名穿红色雨衣的女孩在霓虹雨夜街道奔跑', targetLang: 'en' }],
  ['optimize', '/api/translate', { text: '女孩在雨夜街道奔跑', mode: 'optimize' }],
  ['h3-prompt', '/api/h3-prompt', {
    mode: 't2va', userIntent: '一名穿红色雨衣的女孩在雨夜街道奔跑，镜头跟随，只有雨声和脚步声',
    refImagesCount: 0, refVideosCount: 0, refAudiosCount: 0, audioStrategy: 'new', duration: 5.1,
  }],
  ['director-field', '/api/h3-director/field', {
    field: 'action', value: '', intent: '女孩在雨中全速奔跑并跃过水坑', context: { subject: '<Subject 1>' },
  }],
  ['director-draft', '/api/h3-director/draft', {
    sketch: 'A girl in a red raincoat runs through a neon alley and jumps a puddle.', mode: 't2va',
    assets: [], totalFrames: 124, fps: 24, shotCount: 2,
  }],
  ['director-translate', '/api/h3-director/translate', {
    text: '<Subject 1> runs through neon rain. <Picture 1> remains unchanged.', direction: 'en2zh',
  }],
  ...(image ? [
    ['describe-subject', '/api/describe-subject', { imageDataUrl: image, kind: 'person' }],
  ] : []),
];

const results = [];
for (const [name, path, payload] of cases) {
  if (selected.size && !selected.has(name)) continue;
  const started = performance.now();
  try {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    results.push({ name, status: response.status, latencyMs: Math.round(performance.now() - started), body });
  } catch (error) {
    results.push({ name, status: 0, latencyMs: Math.round(performance.now() - started), error: error.message });
  }
}

const report = { testedAt: new Date().toISOString(), origin, model: 'server default', results };
const output = resolve('llm-route-benchmark.json');
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.error(`Saved ${output}`);
