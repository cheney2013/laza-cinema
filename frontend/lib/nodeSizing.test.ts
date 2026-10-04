import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  clampNodeSize,
  constrainResizeChanges,
  getNodeSizeSpec,
  registerNodeSize,
  resolveMediaRatio,
  solveNodeSize,
  unregisterNodeSize,
  FALLBACK_RATIO,
} from './nodeSizing';

const LANDSCAPE = 1376 / 768;
const PORTRAIT = 768 / 1376;

describe('尺寸方程', () => {
  it('minH 是算出来的，不是常量：同一节点竖屏下限远高于横屏', () => {
    const wide = getNodeSizeSpec('video', LANDSCAPE, null);
    const tall = getNodeSizeSpec('video', PORTRAIT, null);
    assert.equal(wide.minW, tall.minW);
    assert.ok(
      tall.minH > wide.minH * 2,
      `竖屏 minH 应远大于横屏，实际 ${tall.minH} vs ${wide.minH}`,
    );
  });

  it('minH = chromeH + minW / ratio', () => {
    const spec = getNodeSizeSpec('video', LANDSCAPE, null);
    assert.equal(spec.minH, Math.round(spec.chromeH + spec.minW / spec.ratio));
  });

  it('没有媒体时下限与比例无关 —— 纯控件视图不该被比例撑高', () => {
    const wide = getNodeSizeSpec('video', LANDSCAPE, null, { hasMedia: false });
    const tall = getNodeSizeSpec('video', PORTRAIT, null, { hasMedia: false });
    assert.equal(wide.minH, tall.minH);
  });

  it('解出来的高度让媒体区恰好等于媒体比例', () => {
    for (const ratio of [LANDSCAPE, PORTRAIT, 1, 2.39]) {
      const spec = getNodeSizeSpec('video', ratio, null);
      const { width, height } = solveNodeSize(spec, 400);
      const mediaH = height - spec.chromeH;
      assert.ok(
        Math.abs(mediaH - width / ratio) <= 1,
        `比例 ${ratio}: 媒体高 ${mediaH} 应约等于 ${width / ratio}`,
      );
    }
  });

  it('宽度被夹在 [minW, maxW] 内', () => {
    const spec = getNodeSizeSpec('video', LANDSCAPE, null);
    assert.equal(solveNodeSize(spec, 10).width, spec.minW);
    assert.equal(solveNodeSize(spec, 99999).width, spec.maxW);
  });

  it('高度永远不低于下限', () => {
    const spec = getNodeSizeSpec('image', 20, null); // 极端超宽比例
    assert.ok(solveNodeSize(spec, spec.minW).height >= spec.minH);
  });

  it('实测标定值只会抬高下限，不会低于兜底', () => {
    const floor = getNodeSizeSpec('video', LANDSCAPE, null);
    const measured = getNodeSizeSpec('video', LANDSCAPE, { minW: 999, chromeH: 999 });
    assert.ok(measured.minW > floor.minW);
    const tooSmall = getNodeSizeSpec('video', LANDSCAPE, { minW: 1, chromeH: 1 });
    assert.equal(tooSmall.minW, floor.minW);
    assert.equal(tooSmall.chromeH, floor.chromeH);
  });

  it('chromeH 可由调用方按当前视图在场的行覆盖', () => {
    const a = getNodeSizeSpec('video', LANDSCAPE, null, { chromeH: 40 });
    assert.equal(a.chromeH, 40);
    assert.equal(a.minH, Math.round(40 + a.minW / a.ratio));
  });
});

describe('clampNodeSize', () => {
  it('只抬不降：已经够大的高度原样保留', () => {
    const spec = getNodeSizeSpec('video', LANDSCAPE, null);
    assert.equal(clampNodeSize(spec, 400, 900).height, 900);
  });

  it('偏小的旧尺寸被抬到下限', () => {
    const spec = getNodeSizeSpec('video', PORTRAIT, null);
    // 旧代码把竖屏节点算成 200 宽，比标题栏那排按钮还窄
    const fixed = clampNodeSize(spec, 200, 356);
    assert.ok(fixed.width >= spec.minW);
    assert.ok(fixed.height >= spec.minH);
  });
});

describe('resolveMediaRatio', () => {
  it('按优先级取第一个有效来源', () => {
    assert.equal(resolveMediaRatio({ width: 100, height: 50 }, { width: 3, height: 1 }), 2);
  });

  it('跳过缺失或为零的来源', () => {
    assert.equal(resolveMediaRatio(null, { width: 0, height: 0 }, { width: 4, height: 2 }), 2);
  });

  it('全都拿不到时退回 16:9', () => {
    assert.equal(resolveMediaRatio(null, undefined, { width: 0, height: 5 }), FALLBACK_RATIO);
  });
});

describe('拖拽期的等比例约束', () => {
  const spec = getNodeSizeSpec('video', LANDSCAPE, null);
  const mediaH = (h: number) => h - spec.chromeH;

  /** 轴向来自手柄的 resizeDirection，resizer 以 setAttributes 的形式带在变更里 */
  const dim = (width: number, height: number, setAttributes: boolean | 'width' | 'height' = true) => ({
    id: 'n1',
    type: 'dimensions',
    resizing: true,
    setAttributes,
    dimensions: { width, height },
  });
  const pos = (x: number, y: number) => ({ id: 'n1', type: 'position', position: { x, y } });

  function withNode(
    node: { width?: number; height?: number; position?: { x: number; y: number } },
    run: (getNode: (id: string) => typeof node | undefined) => void,
  ) {
    registerNodeSize('n1', spec);
    try {
      run((id) => (id === 'n1' ? node : undefined));
    } finally {
      unregisterNodeSize('n1');
    }
  }

  it('横向拖：高度被改写成 chromeH + 宽度/比例', () => {
    withNode({ width: 400, height: solveNodeSize(spec, 400).height }, (getNode) => {
      // resizer 交上来的高度是错的（它按节点框比例算），应被改写
      const out = constrainResizeChanges([dim(500, 999, 'width')], getNode) as any[];
      const d = out[0].dimensions;
      assert.equal(d.width, 500);
      assert.ok(Math.abs(mediaH(d.height) - 500 / spec.ratio) <= 1);
    });
  });

  it('改写后 setAttributes 必须是 true，否则算出来的宽度会被丢掉', () => {
    withNode({ width: 400, height: solveNodeSize(spec, 400).height }, (getNode) => {
      const out = constrainResizeChanges([dim(400, 800, 'height')], getNode) as any[];
      assert.equal(out[0].setAttributes, true);
    });
  });

  it('纵向拖：宽度由高度反解，否则上下边手柄拖了没反应', () => {
    withNode({ width: 400, height: solveNodeSize(spec, 400).height }, (getNode) => {
      const targetMedia = 300;
      const out = constrainResizeChanges(
        [dim(400, spec.chromeH + targetMedia, 'height')],
        getNode,
      ) as any[];
      const d = out[0].dimensions;
      assert.ok(
        Math.abs(d.width - targetMedia * spec.ratio) <= 2,
        `宽度应反解为 ${targetMedia * spec.ratio}，实际 ${d.width}`,
      );
      assert.ok(Math.abs(mediaH(d.height) - d.width / spec.ratio) <= 1);
    });
  });

  it('纵向连拖不抖：宽度始终由高度决定，不受 store 里已被改写的宽度影响', () => {
    // 这是当初抖动的成因：靠"宽度这一帧变没变"猜轴向，而 store 里的宽度上一帧刚被自己改过，
    // 判断在两种分支间来回翻，宽度每帧在两个值之间弹。轴向必须来自 setAttributes。
    const startW = 400;
    const node = { width: startW, height: solveNodeSize(spec, startW).height };
    registerNodeSize('n1', spec);
    try {
      const widths: number[] = [];
      for (const media of [150, 170, 190]) {
        const out = constrainResizeChanges(
          [dim(startW, spec.chromeH + media, 'height')],
          () => node,
        ) as any[];
        const d = out[0].dimensions;
        widths.push(d.width);
        node.width = d.width; // 模拟改写结果回写进 store
        node.height = d.height;
      }
      assert.ok(
        widths[0] < widths[1] && widths[1] < widths[2],
        `宽度应随高度单调变化，实际 ${widths.join(' → ')}`,
      );
      // 抖动的形态是在两个值之间来回弹，单调性之外再钉一次
      assert.notEqual(widths[0], widths[2], `宽度弹回了原值：${widths.join(' → ')}`);
    } finally {
      unregisterNodeSize('n1');
    }
  });

  it('宽度仍被夹在 [minW, maxW] 内', () => {
    withNode({ width: 400, height: solveNodeSize(spec, 400).height }, (getNode) => {
      const out = constrainResizeChanges([dim(99999, 99999)], getNode) as any[];
      assert.equal(out[0].dimensions.width, spec.maxW);
    });
  });

  it('顶边手柄：高度被改写后 y 跟着补，底边不动', () => {
    const h0 = solveNodeSize(spec, 400).height;
    withNode({ width: 400, height: h0, position: { x: 0, y: 1000 } }, (getNode) => {
      const resizerH = h0 + 200;
      const resizerY = 1000 - 200; // resizer 按它自己的高度让底边不动
      const bottom = resizerY + resizerH;
      const out = constrainResizeChanges([pos(0, resizerY), dim(500, resizerH, 'width')], getNode) as any[];
      const d = out.find((c) => c.type === 'dimensions').dimensions;
      const p = out.find((c) => c.type === 'position').position;
      assert.equal(p.y + d.height, bottom, '底边应保持不动');
    });
  });

  it('底边手柄：y 没动过就不该被碰', () => {
    const h0 = solveNodeSize(spec, 400).height;
    withNode({ width: 400, height: h0, position: { x: 0, y: 1000 } }, (getNode) => {
      const out = constrainResizeChanges([pos(50, 1000), dim(500, h0 + 200, 'width')], getNode) as any[];
      assert.equal(out.find((c) => c.type === 'position').position.y, 1000);
    });
  });

  it('尺寸已经在方程上时原样返回，不制造多余更新', () => {
    const solved = solveNodeSize(spec, 400);
    withNode({ width: solved.width, height: solved.height }, (getNode) => {
      const changes = [dim(solved.width, solved.height, true)];
      assert.equal(constrainResizeChanges(changes, getNode), changes);
    });
  });

  it('没有媒体的节点自由缩放，不受约束', () => {
    registerNodeSize('n2', getNodeSizeSpec('prompt', LANDSCAPE, null, { hasMedia: false }));
    try {
      const changes = [
        { id: 'n2', type: 'dimensions', resizing: true, setAttributes: true as const, dimensions: { width: 500, height: 137 } },
      ];
      assert.equal(constrainResizeChanges(changes, () => undefined), changes, '应原样返回');
    } finally {
      unregisterNodeSize('n2');
    }
  });

  it('未登记的节点原样放行', () => {
    const changes = [
      { id: 'unknown', type: 'dimensions', resizing: true, setAttributes: true as const, dimensions: { width: 1, height: 1 } },
    ];
    assert.equal(constrainResizeChanges(changes, () => undefined), changes);
  });

  it('非拖拽期的尺寸变更不干预', () => {
    registerNodeSize('n1', spec);
    try {
      const changes = [{ id: 'n1', type: 'dimensions', setAttributes: true as const, dimensions: { width: 500, height: 111 } }];
      assert.equal(constrainResizeChanges(changes, () => undefined), changes);
    } finally {
      unregisterNodeSize('n1');
    }
  });
});

// Parity with backend/node_sizing.py: the backend lifts nodes on every canvas save with
// the same floors, and lib/nodeFloors.cases.json is the shared set of expected answers.
import nodeFloorCases from './nodeFloors.cases.json';
import { migrateNodeSizes as migrateSizesForParity } from './migrations';

describe('size floors shared with the backend', () => {
  it('migrateNodeSizes lifts nodes to the same floors the backend enforces', () => {
  for (const c of nodeFloorCases as Array<{ name: string; node: any; floor: [number, number] }>) {
    const { nodes } = migrateSizesForParity([{ position: { x: 0, y: 0 }, ...c.node } as any]);
    assert.deepEqual([nodes[0].width, nodes[0].height], c.floor, c.name);
  }
});
});
