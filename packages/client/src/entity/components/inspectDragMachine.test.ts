import { describe, test, expect } from 'vitest';
import { initialState, reduce, DRAG_THRESHOLD_PX } from './inspectDragMachine';

function down(opts: Partial<{ cardId: string; originIdx: number; x: number; y: number; offsetX: number; offsetY: number }> = {}) {
  return {
    kind:      'pointerdown' as const,
    cardId:    opts.cardId    ?? 'c1',
    originIdx: opts.originIdx ?? 0,
    x:         opts.x         ?? 100,
    y:         opts.y         ?? 100,
    offsetX:   opts.offsetX   ?? 5,
    offsetY:   opts.offsetY   ?? 5,
  };
}

describe('inspectDragMachine', () => {
  test('down-then-up-without-move → cancel', () => {
    const s0 = initialState();
    const s1 = reduce(s0, down());
    expect(s1.next.kind).toBe('dragging');
    expect(s1.effect).toBe('none');
    const s2 = reduce(s1.next, { kind: 'pointerup', x: 100, y: 100, insideGrid: true });
    expect(s2.effect).toBe('cancel');
    expect(s2.next.kind).toBe('idle');
  });

  test('down-move-up-inside-grid (past threshold) → reorder', () => {
    const s0 = initialState();
    const s1 = reduce(s0, down({ x: 100, y: 100 }));
    const s2 = reduce(s1.next, { kind: 'pointermove', x: 100 + DRAG_THRESHOLD_PX + 1, y: 100 });
    expect(s2.next.kind).toBe('dragging');
    if (s2.next.kind !== 'dragging') throw new Error();
    expect(s2.next.exceededThreshold).toBe(true);
    const s3 = reduce(s2.next, { kind: 'pointerup', x: 200, y: 100, insideGrid: true });
    expect(s3.effect).toBe('reorder');
    expect(s3.next.kind).toBe('idle');
  });

  test('down-move-up-outside-grid → extract', () => {
    const s0 = initialState();
    const s1 = reduce(s0, down({ x: 100, y: 100 }));
    const s2 = reduce(s1.next, { kind: 'pointermove', x: 200, y: 100 });
    const s3 = reduce(s2.next, { kind: 'pointerup', x: 400, y: 400, insideGrid: false });
    expect(s3.effect).toBe('extract');
    expect(s3.next.kind).toBe('idle');
  });

  test('threshold not exceeded → cancel even with movement', () => {
    const s0 = initialState();
    const s1 = reduce(s0, down({ x: 100, y: 100 }));
    // Move just under threshold
    const s2 = reduce(s1.next, { kind: 'pointermove', x: 100 + DRAG_THRESHOLD_PX - 1, y: 100 });
    if (s2.next.kind !== 'dragging') throw new Error();
    expect(s2.next.exceededThreshold).toBe(false);
    const s3 = reduce(s2.next, { kind: 'pointerup', x: 100 + DRAG_THRESHOLD_PX - 1, y: 100, insideGrid: true });
    expect(s3.effect).toBe('cancel');
  });

  test('threshold latches once exceeded (further moves do not unset)', () => {
    const s0 = initialState();
    const s1 = reduce(s0, down({ x: 100, y: 100 }));
    const s2 = reduce(s1.next, { kind: 'pointermove', x: 200, y: 200 });
    const s3 = reduce(s2.next, { kind: 'pointermove', x: 100, y: 100 });
    if (s3.next.kind !== 'dragging') throw new Error();
    expect(s3.next.exceededThreshold).toBe(true);
  });

  test('idle ignores stray pointermove/pointerup', () => {
    const s0 = initialState();
    const m = reduce(s0, { kind: 'pointermove', x: 1, y: 1 });
    expect(m.next.kind).toBe('idle');
    const u = reduce(s0, { kind: 'pointerup', x: 1, y: 1, insideGrid: true });
    expect(u.next.kind).toBe('idle');
  });

  test('records cardId and originIdx through to commit', () => {
    const s0 = initialState();
    const s1 = reduce(s0, down({ cardId: 'cardX', originIdx: 7, x: 0, y: 0 }));
    if (s1.next.kind !== 'dragging') throw new Error();
    expect(s1.next.cardId).toBe('cardX');
    expect(s1.next.originIdx).toBe(7);
    expect(s1.next.offsetX).toBe(5);
  });
});
