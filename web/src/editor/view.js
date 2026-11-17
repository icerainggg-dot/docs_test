// 화면: 쪽 그리기(rHWP → canvas), 커서·선택 영역·다른 참여자 표시.

const PAGE_GAP_MARGIN = 600; // 화면 밖 이만큼까지 미리 그린다

export class View {
  constructor(editor, scroller) {
    this.editor = editor;
    this.scroller = scroller;
    this.zoom = 1;
    this.pages = [];
    this.frame = 0;
    this.followCaret = false;

    this.pagesEl = document.createElement('div');
    this.pagesEl.className = 'pages';
    scroller.append(this.pagesEl);

    // 글자 입력을 받는 숨은 입력란. 커서 자리에 두어 한글 입력기 창이 그 근처에 뜨게 한다.
    this.input = document.createElement('textarea');
    this.input.className = 'ime-input';
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('autocorrect', 'off');
    this.input.setAttribute('spellcheck', 'false');
    this.input.setAttribute('aria-label', '문서 편집');
    scroller.append(this.input);

    this.off = editor.on((type) => {
      if (type === 'selection') this.followCaret = true;
      this.schedule();
    });
    this.onScroll = () => this.schedule();
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onScroll);
    this.schedule();
  }

  destroy() {
    this.off();
    cancelAnimationFrame(this.frame);
    this.scroller.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onScroll);
    this.pagesEl.remove();
    this.input.remove();
  }

  setZoom(zoom) {
    this.zoom = Math.min(3, Math.max(0.4, zoom));
    for (const p of this.pages) p.rev = -1;
    this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  update() {
    this.layout();
    this.renderVisible();
    this.drawOverlays();
    if (this.followCaret) {
      this.followCaret = false;
      this.scrollCaretIntoView();
    }
  }

  layout() {
    const a = this.editor.adapter;
    let count = 1;
    try {
      count = a.pageCount();
    } catch {
      /* 그대로 */
    }
    while (this.pages.length > count) this.pages.pop().el.remove();
    for (let i = 0; i < count; i++) {
      let page = this.pages[i];
      if (!page) {
        const el = document.createElement('div');
        el.className = 'page';
        el.dataset.page = String(i);
        const canvas = document.createElement('canvas');
        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        el.append(canvas, overlay);
        this.pagesEl.append(el);
        page = this.pages[i] = { el, canvas, overlay, rev: -1, w: 0, h: 0 };
      }
      let info;
      try {
        info = a.pageInfo(i);
      } catch {
        continue;
      }
      if (page.w !== info.width || page.h !== info.height || page.zoom !== this.zoom) {
        page.w = info.width;
        page.h = info.height;
        page.zoom = this.zoom;
        page.el.style.width = `${info.width * this.zoom}px`;
        page.el.style.height = `${info.height * this.zoom}px`;
        page.rev = -1;
      }
    }
  }

  renderVisible() {
    const view = this.scroller.getBoundingClientRect();
    const scale = this.zoom * Math.min(window.devicePixelRatio || 1, 2);
    this.pages.forEach((page, i) => {
      if (page.rev === this.editor.rev) return;
      const r = page.el.getBoundingClientRect();
      if (r.bottom < view.top - PAGE_GAP_MARGIN || r.top > view.bottom + PAGE_GAP_MARGIN) return;
      try {
        this.editor.hwp.renderPageToCanvas(i, page.canvas, scale);
        page.rev = this.editor.rev;
      } catch (e) {
        console.error('쪽 그리기 실패', i, e);
      }
    });
  }

  box(pageIndex, cls, x, y, w, h, color) {
    const page = this.pages[pageIndex];
    if (!page) return null;
    const el = document.createElement('div');
    el.className = cls;
    const z = this.zoom;
    el.style.cssText = `left:${x * z}px;top:${y * z}px;width:${w * z}px;height:${h * z}px;`;
    if (color) el.style.setProperty('--c', color);
    page.overlay.append(el);
    return el;
  }

  drawRange(start, end, cls, color) {
    const ed = this.editor;
    const s = ed.hwpPos(start);
    const e = ed.hwpPos(end);
    if (!s || !e) return;
    let rects = [];
    try {
      rects = ed.adapter.selectionRects(s.ref, s.idx, s.off, e.idx, e.off);
    } catch {
      return;
    }
    for (const r of rects) this.box(r.pageIndex, cls, r.x, r.y, Math.max(r.width, 2), r.height, color);
  }

  caretRect(pos) {
    const hp = this.editor.hwpPos(pos);
    if (!hp) return null;
    try {
      return this.editor.adapter.cursorRect(hp.ref, hp.idx, hp.off);
    } catch {
      return null;
    }
  }

  drawOverlays() {
    const ed = this.editor;
    for (const p of this.pages) p.overlay.replaceChildren();
    this.caretEl = null;

    // 다른 참여자
    for (const peer of ed.peers()) {
      if (peer.me || !peer.sel) continue;
      const color = peer.user.color || '#888';
      const { start, end, head } = peer.sel;
      if (start.idx !== end.idx || start.off !== end.off) this.drawRange(start, end, 'sel remote', color);
      const r = this.caretRect(head);
      if (r) {
        const el = this.box(r.pageIndex, 'caret remote', r.x, r.y, 0, r.height, color);
        if (el) {
          const label = document.createElement('span');
          label.textContent = peer.user.name || '익명';
          el.append(label);
        }
      }
    }

    // 나
    const sel = ed.selection();
    if (!sel.collapsed) this.drawRange(sel.start, sel.end, 'sel');
    const comp = ed.compositionRange();
    if (comp) {
      this.drawRange({ ...comp, off: comp.from }, { ...comp, off: comp.to }, 'composing');
    }
    const r = this.caretRect(sel.head);
    if (r) {
      this.caretEl = this.box(r.pageIndex, 'caret', r.x, r.y, 0, r.height);
      const page = this.pages[r.pageIndex];
      if (page) {
        // 입력란을 커서 자리로 옮긴다.
        const z = this.zoom;
        this.input.style.left = `${page.el.offsetLeft + r.x * z}px`;
        this.input.style.top = `${page.el.offsetTop + r.y * z}px`;
        this.input.style.height = `${r.height * z}px`;
      }
    }
  }

  scrollCaretIntoView() {
    if (!this.caretEl) return;
    const c = this.caretEl.getBoundingClientRect();
    const v = this.scroller.getBoundingClientRect();
    const pad = 40;
    if (c.top < v.top + pad) this.scroller.scrollTop -= v.top + pad - c.top;
    else if (c.bottom > v.bottom - pad) this.scroller.scrollTop += c.bottom - (v.bottom - pad);
    if (c.left < v.left + pad) this.scroller.scrollLeft -= v.left + pad - c.left;
    else if (c.right > v.right - pad) this.scroller.scrollLeft += c.right - (v.right - pad);
  }

  /** 마우스 위치 → 편집 위치 */
  posFromPoint(clientX, clientY) {
    let best = null;
    for (let i = 0; i < this.pages.length; i++) {
      const r = this.pages[i].el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        best = { i, r };
        break;
      }
      if (clientY < r.top) {
        best = { i, r };
        break;
      }
      best = { i, r };
    }
    if (!best) return null;
    const x = Math.min(Math.max(clientX - best.r.left, 0), best.r.width) / this.zoom;
    const y = Math.min(Math.max(clientY - best.r.top, 0), best.r.height) / this.zoom;
    try {
      return this.editor.posFromHit(this.editor.adapter.hitTest(best.i, x, y));
    } catch {
      return null;
    }
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }
}
