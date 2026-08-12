/**
 * Fixed-height virtual list.
 *
 * With a few thousand notes, rendering every row costs tens of milliseconds
 * per scope switch and leaves thousands of nodes in the document. Only the
 * visible window plus a small overscan is built, so cost is bounded by the
 * viewport rather than the vault.
 */

export interface VirtualListOptions<T> {
  scroller: HTMLElement;
  rowHeight: number;
  /** Rows rendered beyond each edge, to hide scroll latency. */
  overscan?: number;
  /** Items laid out per row; >1 turns the list into a grid. */
  columns?: number;
  gap?: number;
  render: (item: T, index: number) => HTMLElement;
  key: (item: T) => string;
}

export class VirtualList<T> {
  private readonly opts: Required<Omit<VirtualListOptions<T>, "render" | "key" | "scroller">> &
    Pick<VirtualListOptions<T>, "render" | "key" | "scroller">;

  private readonly sizer: HTMLElement;
  private readonly window: HTMLElement;
  private items: T[] = [];
  private rendered = new Map<string, HTMLElement>();
  private firstRow = -1;
  private lastRow = -1;
  private frame = 0;
  private observer: ResizeObserver | null = null;

  constructor(options: VirtualListOptions<T>) {
    this.opts = {
      overscan: 6,
      columns: 1,
      gap: 0,
      ...options,
    };

    this.sizer = document.createElement("div");
    this.sizer.className = "vlist__sizer";
    this.window = document.createElement("div");
    this.window.className = "vlist__window";
    this.sizer.appendChild(this.window);

    this.opts.scroller.replaceChildren(this.sizer);
    this.opts.scroller.addEventListener("scroll", this.onScroll, { passive: true });

    this.observer = new ResizeObserver(() => this.schedule(true));
    this.observer.observe(this.opts.scroller);
  }

  private onScroll = (): void => this.schedule(false);

  private schedule(force: boolean): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint(force);
    });
  }

  setItems(items: T[], options: { preserveScroll?: boolean } = {}): void {
    this.items = items;
    if (!options.preserveScroll) this.opts.scroller.scrollTop = 0;
    this.rendered.clear();
    this.window.replaceChildren();
    this.firstRow = -1;
    this.lastRow = -1;
    this.paint(true);
  }

  /** Re-renders in place, keeping the scroll position (used for selection changes). */
  refresh(): void {
    this.rendered.clear();
    this.window.replaceChildren();
    this.firstRow = -1;
    this.lastRow = -1;
    this.paint(true);
  }

  private get rowStride(): number {
    return this.opts.rowHeight + this.opts.gap;
  }

  private get rowCount(): number {
    return Math.ceil(this.items.length / this.opts.columns);
  }

  private paint(force: boolean): void {
    const { scroller, overscan, columns } = this.opts;

    // The host swaps in an empty-state element when there is nothing to show,
    // which detaches the sizer. Re-attaching here keeps the list self-healing
    // instead of making every caller remember the handshake.
    if (this.sizer.parentNode !== scroller) {
      scroller.replaceChildren(this.sizer);
    }

    const stride = this.rowStride;
    const total = Math.max(0, this.rowCount * stride - this.opts.gap);
    this.sizer.style.height = `${total}px`;

    const viewport = scroller.clientHeight || 1;
    const scrollTop = scroller.scrollTop;

    const first = Math.max(0, Math.floor(scrollTop / stride) - overscan);
    const visible = Math.ceil(viewport / stride) + overscan * 2;
    const last = Math.min(this.rowCount - 1, first + visible);

    if (!force && first === this.firstRow && last === this.lastRow) return;
    this.firstRow = first;
    this.lastRow = last;

    const wanted = new Map<string, HTMLElement>();
    const fragment = document.createDocumentFragment();

    for (let row = first; row <= last; row++) {
      for (let col = 0; col < columns; col++) {
        const index = row * columns + col;
        if (index >= this.items.length) break;

        const item = this.items[index];
        const id = this.opts.key(item);
        let node = this.rendered.get(id);
        if (!node) {
          node = this.opts.render(item, index);
          node.style.position = "absolute";
          node.style.top = `${row * stride}px`;
          if (columns > 1) {
            const width = `calc((100% - ${(columns - 1) * this.opts.gap}px) / ${columns})`;
            node.style.left = `calc((${width} + ${this.opts.gap}px) * ${col})`;
            node.style.width = width;
          } else {
            node.style.left = "0";
            node.style.right = "0";
          }
          node.style.height = `${this.opts.rowHeight}px`;
          fragment.appendChild(node);
        } else {
          node.style.top = `${row * stride}px`;
        }
        wanted.set(id, node);
      }
    }

    for (const [id, node] of this.rendered) {
      if (!wanted.has(id)) node.remove();
    }
    this.rendered = wanted;
    if (fragment.childNodes.length > 0) this.window.appendChild(fragment);
  }

  /** Scrolls an item into view, used when selection moves by keyboard. */
  scrollToIndex(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    const row = Math.floor(index / this.opts.columns);
    const stride = this.rowStride;
    const top = row * stride;
    const bottom = top + this.opts.rowHeight;
    const scroller = this.opts.scroller;

    if (top < scroller.scrollTop) {
      scroller.scrollTop = top;
    } else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight;
    }
  }

  setColumns(columns: number): void {
    if (this.opts.columns === columns) return;
    this.opts.columns = columns;
    this.refresh();
  }

  setRowHeight(height: number, gap = this.opts.gap): void {
    if (this.opts.rowHeight === height && this.opts.gap === gap) return;
    this.opts.rowHeight = height;
    this.opts.gap = gap;
    this.refresh();
  }

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.opts.scroller.removeEventListener("scroll", this.onScroll);
    this.observer?.disconnect();
    this.observer = null;
    this.rendered.clear();
  }
}
