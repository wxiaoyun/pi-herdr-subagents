/**
 * layout.ts: pure decisions over a herdr `pane layout` snapshot. Where the next
 * split child goes, and which `pane resize` calls give every leaf an equal
 * share. herdr has no balance command, so the ratios are computed here.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  panes: Array<{ pane_id: string; rect: Rect }>;
  splits: Array<{ direction: "right" | "down"; ratio: number; rect: Rect }>;
}

export type Direction = "left" | "right" | "up" | "down";

export interface ResizeOp {
  pane: string;
  direction: Direction;
  amount: number;
}

/**
 * Split the biggest pane along its longer axis. Ties go to a child pane so the
 * parent keeps its size. A terminal cell is about twice as tall as wide, and a
 * column narrower than half the screen is unusable, so a pane only splits
 * right when it is clearly wider than tall.
 */
export function pickSplit(
  layout: Layout,
  parent: string,
): { pane: string; direction: "right" | "down" } {
  const area = (r: Rect) => r.width * r.height;
  let best = layout.panes[0];
  for (const p of layout.panes) {
    const d = area(p.rect) - area(best.rect);
    if (d > 0 || (d === 0 && best.pane_id === parent)) best = p;
  }
  return {
    pane: best.pane_id,
    direction: best.rect.width > 2.5 * best.rect.height ? "right" : "down",
  };
}

const inside = (p: Rect, r: Rect) =>
  p.x >= r.x &&
  p.y >= r.y &&
  p.x + p.width <= r.x + r.width &&
  p.y + p.height <= r.y + r.height;

/** One resize per split whose ratio is off from leaves-first / leaves-total. */
export function balanceOps(layout: Layout): ResizeOp[] {
  const ops: ResizeOp[] = [];
  for (const s of layout.splits) {
    const horizontal = s.direction === "right";
    const panes = layout.panes.filter((p) => inside(p.rect, s.rect));
    const boundary = horizontal
      ? s.rect.x + s.ratio * s.rect.width
      : s.rect.y + s.ratio * s.rect.height;
    const first = panes.filter((p) =>
      horizontal
        ? p.rect.x + p.rect.width / 2 < boundary
        : p.rect.y + p.rect.height / 2 < boundary,
    );
    if (!first.length || first.length === panes.length) continue;
    const want = first.length / panes.length;
    const delta = want - s.ratio;
    if (Math.abs(delta) < 0.01) continue;
    // Any first-side pane touching the boundary; its far edge is the split.
    const edge = first.reduce((a, b) => {
      const ea = horizontal ? a.rect.x + a.rect.width : a.rect.y + a.rect.height;
      const eb = horizontal ? b.rect.x + b.rect.width : b.rect.y + b.rect.height;
      return eb > ea ? b : a;
    });
    ops.push({
      pane: edge.pane_id,
      direction: horizontal
        ? delta > 0
          ? "right"
          : "left"
        : delta > 0
          ? "down"
          : "up",
      amount: Number(Math.abs(delta).toFixed(4)),
    });
  }
  return ops;
}

/** Workspace label for children of `label`. Idempotent. */
export const CHILD_WS_SUFFIX = "-agents";
export const childWorkspaceLabel = (label: string): string =>
  label.endsWith(CHILD_WS_SUFFIX) ? label : `${label}${CHILD_WS_SUFFIX}`;
