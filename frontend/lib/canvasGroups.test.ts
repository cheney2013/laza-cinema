import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Node, type NodeChange, type NodePositionChange } from '@xyflow/react';

import {
  GROUP_HEADER_H,
  collapsedMemberIds,
  createGroupNode,
  frameAround,
  groupsFirst,
  memberIds,
  reconcileGroups,
  transitiveMemberIds,
  withGroupMemberMoves,
} from './canvasGroups';

// 160x100: getNodeBounds 的下限是 160x80，比这更小的尺寸会被夹住，
// 用夹不到的尺寸写用例，算出来的中心才是用例里那个中心。
const node = (id: string, x: number, y: number, w = 160, h = 100): Node => ({
  id,
  type: 'image',
  position: { x, y },
  width: w,
  height: h,
  data: {},
});

const group = (id: string, x: number, y: number, w: number, h: number, data = {}): Node => ({
  id,
  type: 'group',
  position: { x, y },
  width: w,
  height: h,
  data: { title: id, color: '#3f4756', collapsed: false, ...data },
});

describe('成员判定', () => {
  const frame = group('g1', 0, 0, 400, 400);

  it('中心在框体内就算成员', () => {
    assert.deepEqual(memberIds(frame, [frame, node('a', 100, 100)]), ['a']);
  });

  it('框体不含标题栏：贴在标题栏下的节点算进来，压在标题栏上的不算', () => {
    const under = node('under', 100, GROUP_HEADER_H + 10);
    const over = node('over', 100, -60);
    assert.deepEqual(memberIds(frame, [frame, under, over]), ['under']);
  });

  it('中心在外就不算，哪怕有重叠', () => {
    // 右边缘探进框里 20px，中心 (-60) 仍在框外
    assert.deepEqual(memberIds(frame, [frame, node('edge', -140, 100)]), []);
  });

  it('两个重叠的组按中心各分各的，不会都认领', () => {
    const a = group('ga', 0, 0, 300, 300);
    const b = group('gb', 200, 0, 300, 300);
    const inA = node('inA', 20, 100);
    const inB = node('inB', 380, 100);
    const nodes = [a, b, inA, inB];
    assert.deepEqual(memberIds(a, nodes), ['inA']);
    assert.deepEqual(memberIds(b, nodes), ['inB']);
  });

  it('不会把自己算成成员', () => {
    assert.ok(!memberIds(frame, [frame]).includes('g1'));
  });
});

describe('嵌套', () => {
  it('拖外层组要带上内层组和它的节点', () => {
    const outer = group('outer', 0, 0, 600, 600);
    const inner = group('inner', 100, 100, 300, 300);
    const leaf = node('leaf', 200, 250);
    const nodes = [outer, inner, leaf];
    assert.deepEqual(transitiveMemberIds(outer, nodes).sort(), ['inner', 'leaf']);
  });

  it('互相包含的两个组不会转圈', () => {
    const a = group('ga', 0, 0, 400, 400);
    const b = group('gb', 10, 10, 380, 380);
    const nodes = [a, b];
    assert.deepEqual(transitiveMemberIds(a, nodes), ['gb']);
    assert.deepEqual(transitiveMemberIds(b, nodes), ['ga']);
  });
});

describe('折叠', () => {
  it('折叠时记下的成员就是它此后携带的成员', () => {
    const folded = group('g', 0, 0, 400, 400, {
      collapsed: true,
      collapsedMemberIds: ['a', 'b'],
    });
    // 几何上此刻框里还有 c，但折叠组只认记下的那两个
    assert.deepEqual(memberIds(folded, [folded, node('c', 100, 100)]), ['a', 'b']);
  });

  it('折叠组的成员计入隐藏集合', () => {
    const folded = group('g', 0, 0, 400, 400, {
      collapsed: true,
      collapsedMemberIds: ['a'],
    });
    assert.deepEqual([...collapsedMemberIds([folded, node('a', 100, 100)])], ['a']);
  });

  it('没有折叠组时隐藏集合为空', () => {
    assert.equal(collapsedMemberIds([group('g', 0, 0, 400, 400), node('a', 100, 100)]).size, 0);
  });
});

describe('框体拟合', () => {
  it('框住选中节点，并在顶部留出标题栏', () => {
    const rect = frameAround([node('a', 100, 100), node('b', 300, 200)], 20);
    assert.equal(rect.x, 80);
    assert.equal(rect.y, 100 - 20 - GROUP_HEADER_H);
    assert.equal(rect.width, 300 + 160 - 100 + 40);
    assert.equal(rect.height, 200 + 100 - 100 + 40 + GROUP_HEADER_H);
  });

  it('拟合出来的组真的装得下它拟合的那些节点', () => {
    const members = [node('a', 100, 100), node('b', 300, 200)];
    const g = createGroupNode(members, '测试');
    assert.deepEqual(memberIds(g, [g, ...members]).sort(), ['a', 'b']);
  });

  it('只有标题栏可拖动', () => {
    assert.equal(createGroupNode([node('a', 0, 0)]).dragHandle, '.canvas-group-handle');
  });
});

describe('绘制顺序', () => {
  it('组排在前面（画在节点背后），大的更靠后', () => {
    const small = group('small', 0, 0, 200, 200);
    const big = group('big', 0, 0, 800, 800);
    const leaf = node('leaf', 10, 10);
    assert.deepEqual(
      groupsFirst([leaf, small, big]).map((n) => n.id),
      ['big', 'small', 'leaf'],
    );
  });

  it('没有组时原样返回同一个数组', () => {
    const input = [node('a', 0, 0)];
    assert.equal(groupsFirst(input), input);
  });
});

describe('折叠的落实', () => {
  it('折叠时记下成员、存下展开高度、把框收成标题栏', () => {
    const g = group('g', 0, 0, 400, 400, { collapsed: true });
    const a = node('a', 100, 100);
    const [settled] = reconcileGroups([g, a]) as [Node, Node];
    assert.deepEqual((settled.data as any).collapsedMemberIds, ['a']);
    assert.equal((settled.data as any).expandedHeight, 400);
    assert.equal(settled.height, GROUP_HEADER_H);
  });

  it('展开时还原用户画的那个高度，并清掉记录', () => {
    const g = group('g', 0, 0, 400, GROUP_HEADER_H, {
      collapsed: false,
      collapsedMemberIds: ['a'],
      expandedHeight: 400,
    });
    const [settled] = reconcileGroups([g]) as [Node];
    assert.equal(settled.height, 400);
    assert.equal((settled.data as any).collapsedMemberIds, undefined);
    assert.equal((settled.data as any).expandedHeight, undefined);
  });

  it('没有变化时返回同一个数组', () => {
    const input = [group('g', 0, 0, 400, 400), node('a', 100, 100)];
    assert.equal(reconcileGroups(input), input);
  });
});

describe('拖动带走成员', () => {
  const g = group('g', 0, 0, 400, 400);
  const a = node('a', 100, 100);
  const b = node('b', 150, 200);

  const move = (id: string, x: number, y: number): NodePositionChange => ({
    id, type: 'position', position: { x, y }, dragging: true,
  });

  it('拖组时成员按同一位移跟着走', () => {
    const out = withGroupMemberMoves([move('g', 50, 20)], [g, a, b]) as NodePositionChange[];
    const carried = out.filter((c) => c.id !== 'g');
    assert.deepEqual(carried.map((c) => [c.id, c.position!.x, c.position!.y]).sort(),
      [['a', 150, 120], ['b', 200, 220]]);
  });

  it('同批里已经自己在动的成员不会被移动两次', () => {
    const out = withGroupMemberMoves([move('g', 50, 20), move('a', 999, 999)], [g, a, b]) as NodePositionChange[];
    assert.equal(out.filter((c) => c.id === 'a').length, 1);
  });

  it('组没动就什么都不加', () => {
    const changes = [move('g', 0, 0)];
    assert.equal(withGroupMemberMoves(changes, [g, a]), changes);
  });

  it('拖普通节点不牵连任何人', () => {
    const changes = [move('a', 10, 10)];
    assert.equal(withGroupMemberMoves(changes, [g, a, b]), changes);
  });
});
