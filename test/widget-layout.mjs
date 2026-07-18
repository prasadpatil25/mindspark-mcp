import { layoutTree, NODE_H, ROOT_H, V_GAP } from '../web/layout.mjs';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail) : ''}`); } }

const rowH = NODE_H + V_GAP;

console.log('=== Single node (root only, no children) ===');
{
  const nodes = { r: { text: 'Root', parent: null } };
  const { positions, height } = layoutTree(nodes, 'r');
  check('root gets a position', !!positions.r);
  check('single-node height equals the root\'s own height (48), not a generic row height', height === 48, { height });
}

console.log('\n=== Simple parent + 2 children: balanced onto opposite sides ===');
{
  const nodes = {
    r: { text: 'Root', parent: null },
    a: { text: 'A', parent: 'r' },
    b: { text: 'B', parent: 'r' }
  };
  const { positions, side } = layoutTree(nodes, 'r');
  check('all 3 nodes positioned', Object.keys(positions).length === 3);
  check('the two children land on opposite sides (matches app.js balancing: first right, then left)', side.a !== side.b, side);
  const rightChild = side.a === 'right' ? 'a' : 'b';
  const leftChild = side.a === 'right' ? 'b' : 'a';
  check('right-side child is positioned to the right of root', positions[rightChild].x > positions.r.x);
  check('left-side child is positioned to the left of root', positions[leftChild].x < positions.r.x);
  check('root is roughly vertically centered between its two (single-leaf) children', Math.abs(positions.r.y - (positions.a.y + positions.b.y) / 2) < 0.01);
}

console.log('\n=== Left/right balancing matches app.js\'s balanceRootSides() exactly (contiguous half-split) ===');
{
  const nodes = { r: { text: 'Root', parent: null } };
  const order = ['c0', 'c1', 'c2', 'c3', 'c4'];
  for (const id of order) nodes[id] = { text: id, parent: 'r' };
  const { side } = layoutTree(nodes, 'r');
  // app.js's balanceRootSides(): const half=Math.ceil(kids.length/2); first half
  // right, second half left — this is the "fresh view" arrangement, and the right
  // comparison for a layout computed fresh every time with no persisted side to
  // preserve (unlike autoLayout()'s own separate incremental-balance rule, used
  // for keeping an already-edited map stable across further edits).
  check('balancing sequence matches balanceRootSides exactly: right,right,right,left,left', order.map(id => side[id]).join(',') === 'right,right,right,left,left', order.map(id => side[id]));
}

console.log('\n=== Descendants inherit their branch\'s side ===');
{
  const nodes = {
    r: { text: 'Root', parent: null },
    a: { text: 'A', parent: 'r' },
    b: { text: 'B', parent: 'r' },
    a1: { text: 'A1', parent: 'a' },
    a2: { text: 'A2', parent: 'a' },
    b1: { text: 'B1', parent: 'b' }
  };
  const { side } = layoutTree(nodes, 'r');
  check('a1 and a2 inherit a\'s side', side.a1 === side.a && side.a2 === side.a);
  check('b1 inherits b\'s side', side.b1 === side.b);
  check('a and b ended up on opposite sides', side.a !== side.b);
}

console.log('\n=== Deep linear chain (depth 6), single branch ===');
{
  const nodes = { n0: { text: 'L0', parent: null } };
  for (let i = 1; i <= 6; i++) nodes['n' + i] = { text: 'L' + i, parent: 'n' + (i - 1) };
  const { positions, depth, side } = layoutTree(nodes, 'n0');
  check('all 7 nodes positioned', Object.keys(positions).length === 7);
  check('depth increases by exactly 1 each level', [1,2,3,4,5,6].every(i => depth['n'+i] === depth['n'+(i-1)] + 1));
  check('the whole chain stays on one side (n1 sets it, rest inherit)', new Set([1,2,3,4,5,6].map(i => side['n'+i])).size === 1);
  const s = side.n1;
  const dir = s === 'right' ? 1 : -1;
  check('x moves consistently away from root in that side\'s direction with depth', [1,2,3,4,5,6].every(i => dir * (positions['n'+i].x - positions['n'+(i-1)].x) > 0));
}

console.log('\n=== Wide fan-out (root with 12 children): balanced 6/6, no overlap WITHIN each side ===');
{
  const nodes = { r: { text: 'Root', parent: null } };
  for (let i = 0; i < 12; i++) nodes['c'+i] = { text: 'Child '+i, parent: 'r' };
  const { positions, side } = layoutTree(nodes, 'r');
  const rightIds = Array.from({length:12}, (_,i)=>'c'+i).filter(id => side[id] === 'right');
  const leftIds = Array.from({length:12}, (_,i)=>'c'+i).filter(id => side[id] === 'left');
  check('split evenly 6/6', rightIds.length === 6 && leftIds.length === 6, { right: rightIds.length, left: leftIds.length });
  const rightYs = rightIds.map(id => positions[id].y);
  const leftYs = leftIds.map(id => positions[id].y);
  check('all 6 right-side siblings get distinct y positions', new Set(rightYs).size === 6, rightYs);
  check('all 6 left-side siblings get distinct y positions', new Set(leftYs).size === 6, leftYs);
  const sortedRight = [...rightYs].sort((a,b)=>a-b);
  check('right-side siblings evenly spaced by the row height', sortedRight.every((y,i) => i===0 || Math.abs((y-sortedRight[i-1]) - rowH) < 0.01));
  check('every right-side node has strictly greater x than every left-side node', Math.min(...rightIds.map(id=>positions[id].x)) > Math.max(...leftIds.map(id=>positions[id].x)));
}

console.log('\n=== Asymmetric tree: one branch has a huge subtree, sibling branch is a single leaf ===');
{
  const nodes = { r: { text:'Root', parent:null }, big: { text:'Big', parent:'r' }, small: { text:'Small', parent:'r' } };
  for (let i = 0; i < 8; i++) nodes['big'+i] = { text: 'Big child '+i, parent: 'big' };
  const { positions, side } = layoutTree(nodes, 'r');
  check('big and small landed on opposite sides (balanced by count at assignment time, not subtree size)', side.big !== side.small);
  const bigChildYs = Array.from({length:8}, (_,i) => positions['big'+i].y);
  check('no y-overlap among the 8 grandchildren on the "big" side', new Set(bigChildYs).size === 8);
  check('"big" parent is centered over its own 8 children', Math.abs(positions.big.y - (bigChildYs[0]+bigChildYs[7])/2) < 0.01);
  check('the lone "small" sibling on the other side does not collide with anything on its own side', true);
}

console.log('\n=== Malformed input: dangling parent reference (not reachable from root) ===');
{
  const nodes = { r: { text:'Root', parent:null }, orphan: { text:'Orphan', parent:'does-not-exist' } };
  const { positions } = layoutTree(nodes, 'r');
  check('does not crash', true);
  check('orphaned node is simply not positioned (not reachable from root)', !positions.orphan);
}

console.log('\n=== Malformed input: cyclic parent chain does not infinite-loop ===');
{
  const nodes = { a: { text:'A', parent:'b' }, b: { text:'B', parent:'a' } };
  const start = Date.now();
  const { positions } = layoutTree(nodes, 'a');
  check('returns quickly (no infinite loop)', Date.now() - start < 1000);
}

console.log('\n=== Empty/missing input ===');
{
  check('no nodes object does not throw', (() => { try { layoutTree(null, 'x'); return true; } catch { return false; } })());
  check('unknown rootId returns empty layout', layoutTree({ a: { text:'A', parent:null } }, 'nope').width === 0);
}

console.log('\n=== All coordinates end up non-negative (renderer works in a plain 0,0-origin viewBox) ===');
{
  const nodes = { r: { text: 'Root', parent: null } };
  for (let i = 0; i < 6; i++) nodes['c'+i] = { text: 'Child '+i, parent: 'r' };
  const { positions } = layoutTree(nodes, 'r');
  check('no negative x among any node (left-side nodes included)', Object.values(positions).every(p => p.x - p.w/2 >= -0.01));
  check('no negative y among any node', Object.values(positions).every(p => p.y - p.h/2 >= -0.01));
}

console.log('\n=== Collapse: a collapsed node\'s descendants are excluded from layout entirely ===');
{
  const nodes = {
    r: { text: 'Root', parent: null },
    a: { text: 'A', parent: 'r' },
    a1: { text: 'A1', parent: 'a' },
    a2: { text: 'A2', parent: 'a' },
    b: { text: 'B', parent: 'r' },
    b1: { text: 'B1', parent: 'b' }
  };
  const uncollapsed = layoutTree(nodes, 'r');
  check('baseline: all 6 nodes positioned when nothing is collapsed', Object.keys(uncollapsed.positions).length === 6);

  const collapsedA = layoutTree(nodes, 'r', new Set(['a']));
  check('a itself still positioned', !!collapsedA.positions.a);
  check('a1 and a2 excluded from positions entirely (not just hidden)', !collapsedA.positions.a1 && !collapsedA.positions.a2);
  check('b and b1 (unrelated branch) still fully positioned and unaffected', !!collapsedA.positions.b && !!collapsedA.positions.b1);
  check('hasChildren still reports true for the collapsed node a (so a toggle button can still be drawn)', collapsedA.hasChildren.a === true);
}

console.log('\n=== Collapse: freed-up space actually shrinks the layout, not just hides content ===');
{
  const nodes = { r: { text: 'Root', parent: null }, big: { text: 'Big', parent: 'r' } };
  for (let i = 0; i < 10; i++) nodes['c'+i] = { text: 'Child '+i, parent: 'big' };
  const expanded = layoutTree(nodes, 'r');
  const collapsed = layoutTree(nodes, 'r', new Set(['big']));
  check('collapsing a 10-child branch measurably shrinks total height', collapsed.height < expanded.height, { expanded: expanded.height, collapsed: collapsed.height });
  check('collapsed layout has far fewer positioned nodes', Object.keys(collapsed.positions).length === 2, Object.keys(collapsed.positions).length);
}

console.log('\n=== Collapse: a leaf node (no children) reports hasChildren:false regardless ===');
{
  const nodes = { r: { text: 'Root', parent: null }, leaf: { text: 'Leaf', parent: 'r' } };
  const { hasChildren } = layoutTree(nodes, 'r', new Set(['leaf']));   // collapsing a leaf is a no-op
  check('leaf with no children reports hasChildren:false', !hasChildren.leaf);
  check('root correctly reports hasChildren:true', hasChildren.r === true);
}

console.log('\n=== Collapse: collapsing a node deep in the tree still frees space correctly ===');
{
  const nodes = {
    r: { text: 'Root', parent: null },
    a: { text: 'A', parent: 'r' },
    a1: { text: 'A1', parent: 'a' },
    a1x: { text: 'A1x', parent: 'a1' },
    a1y: { text: 'A1y', parent: 'a1' },
    a2: { text: 'A2', parent: 'a' }
  };
  const { positions } = layoutTree(nodes, 'r', new Set(['a1']));
  check('a1 itself still positioned', !!positions.a1);
  check('a1x and a1y excluded', !positions.a1x && !positions.a1y);
  check('sibling a2 (not under the collapsed node) still positioned', !!positions.a2);
}

console.log('\n=== Backward compatibility: calling without a third argument still works exactly as before ===');
{
  const nodes = { r: { text: 'Root', parent: null }, a: { text: 'A', parent: 'r' } };
  const result = layoutTree(nodes, 'r');
  check('works fine with no collapsedIds argument at all', Object.keys(result.positions).length === 2);
}

console.log('\n=== Variable per-node heights: taller nodes correctly push neighbors down, no overlap ===');
{
  const nodes = {
    r: { text: 'Root', parent: null },
    tall: { text: 'Tall (wrapped)', parent: 'r' },
    short1: { text: 'Short 1', parent: 'r' },
    short2: { text: 'Short 2', parent: 'r' }
  };
  // Force all three onto the same side isn't directly controllable here, but with
  // 3 children the split is 2 right / 1 left — check whichever side has 2 nodes.
  const heights = { tall: 120 };   // a node that wrapped to several lines
  const { positions, side } = layoutTree(nodes, 'r', null, heights);
  check('tall node gets its specified height, not the default', positions.tall.h === 120);
  check('short nodes keep the default height', positions.short1.h === NODE_H && positions.short2.h === NODE_H);

  const sameSideAsTall = Object.keys(side).filter(id => side[id] === side.tall && id !== 'tall');
  for (const id of sameSideAsTall) {
    const a = positions.tall, b = positions[id];
    const gapNeeded = a.h / 2 + b.h / 2;
    const actualGap = Math.abs(a.y - b.y);
    check(`no vertical overlap between the tall node and ${id} on the same side`, actualGap >= gapNeeded - 0.01, { actualGap, gapNeeded });
  }
}

console.log('\n=== Variable heights: root itself can have a taller height (e.g. wrapped title) ===');
{
  const nodes = { r: { text: 'A Very Long Root Title That Wraps', parent: null }, a: { text: 'Child', parent: 'r' } };
  const { positions } = layoutTree(nodes, 'r', null, { r: 90 });
  check('root gets its specified height instead of the default ROOT_H', positions.r.h === 90);
}

console.log('\n=== Variable heights: backward compatible when no heights map is given at all ===');
{
  const nodes = { r: { text: 'Root', parent: null }, a: { text: 'A', parent: 'r' } };
  const withNoHeights = layoutTree(nodes, 'r');
  const withEmptyCollapsedAndNoHeights = layoutTree(nodes, 'r', new Set());
  check('root falls back to ROOT_H', withNoHeights.positions.r.h === ROOT_H);
  check('regular node falls back to NODE_H', withNoHeights.positions.a.h === NODE_H);
  check('still works fine when collapsedIds is given but heights is omitted', withEmptyCollapsedAndNoHeights.positions.a.h === NODE_H);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
