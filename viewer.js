// 閲覧モード: ページを縦に並べて大きく表示する(文字の選択・コピーにも対応)
// 画面の近くにあるページだけを描画し、離れたページは描画結果を捨ててメモリを抑える。

import { TextLayer } from './lib/pdf.min.mjs';

export const VIEW_ZOOM_LEVELS = [50, 75, 100, 125, 150, 200, 300, 400]; // 表示倍率(%)。100%が実寸
const CSS_PX_PER_PT = 96 / 72;
const FIT_MAX_ZOOM = 200; // 「幅に合わせる」で大きくなりすぎないようにする上限(%)
const MAX_CANVAS_PIXELS = 16_000_000;
const SIDE_MARGIN = 24;

export class Viewer {
  // root: ページを並べる要素 / getTopInset: 上に重なっているツールバーの高さを返す関数
  constructor(root, { getTopInset, onPageChange, onZoomChange }) {
    this.root = root;
    this.getTopInset = getTopInset;
    this.onPageChange = onPageChange;
    this.onZoomChange = onZoomChange;
    this.items = [];
    this.zoom = 'fit'; // 'fit' または VIEW_ZOOM_LEVELS のいずれか
    this.scale = 1; // CSSピクセル / ポイント
    this.current = 0;
    this.token = 0;
    this.observer = new IntersectionObserver((entries) => this.#onIntersect(entries), { rootMargin: '150% 0px' });
    this.onScroll = () => {
      if (this.scrollFrame) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = 0;
        this.#updateCurrent();
      });
    };
    this.onResize = () => {
      if (this.zoom === 'fit') this.#applyScale();
    };
  }

  get pageCount() {
    return this.items.length;
  }

  // pages: 表示するページ並び / getPage: ページ並びの要素から pdf.js のページを取得する関数
  async open(pages, getPage, startIndex = 0) {
    const token = ++this.token;
    this.#teardown();
    const items = [];
    for (const p of pages) {
      const page = await getPage(p);
      if (token !== this.token) return; // 読み込み中に閉じられた・開き直された
      const rotation = (page.rotate + p.rotation) % 360;
      const { width, height } = page.getViewport({ scale: 1, rotation });
      items.push({ page, rotation, width, height, el: null, canvas: null, task: null, textLayer: null, renderedScale: 0 });
    }
    this.items = items;

    const frag = document.createDocumentFragment();
    items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'view-page';
      el.dataset.index = i;
      el.setAttribute('aria-label', `${i + 1}ページ`);
      item.el = el;
      frag.appendChild(el);
    });
    this.root.replaceChildren(frag);
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onResize);

    this.#applyScale({ keepPosition: false });
    for (const item of items) this.observer.observe(item.el);
    this.current = -1;
    this.scrollToPage(startIndex);
    this.#updateCurrent();
  }

  close() {
    this.token++;
    this.#teardown();
  }

  scrollToPage(index) {
    const item = this.items[Math.max(0, Math.min(index, this.items.length - 1))];
    if (!item) return;
    window.scrollBy(0, item.el.getBoundingClientRect().top - this.getTopInset() - 12);
  }

  setZoom(zoom) {
    this.zoom = zoom;
    this.#applyScale();
  }

  stepZoom(delta) {
    const now = this.scale / CSS_PX_PER_PT * 100;
    const next = delta > 0
      ? VIEW_ZOOM_LEVELS.find((z) => z > now + 0.5)
      : [...VIEW_ZOOM_LEVELS].reverse().find((z) => z < now - 0.5);
    if (next) this.setZoom(next);
  }

  // 今の倍率(%)と、スライダー上の最も近い段階
  zoomState() {
    const percent = Math.round(this.scale / CSS_PX_PER_PT * 100);
    let index = 0;
    VIEW_ZOOM_LEVELS.forEach((z, i) => {
      if (Math.abs(z - percent) < Math.abs(VIEW_ZOOM_LEVELS[index] - percent)) index = i;
    });
    return { percent, index, fit: this.zoom === 'fit' };
  }

  #computeScale() {
    if (this.zoom !== 'fit') return this.zoom / 100 * CSS_PX_PER_PT;
    const maxWidth = Math.max(...this.items.map((it) => it.width));
    const available = this.root.clientWidth - SIDE_MARGIN * 2;
    return Math.max(0.1, Math.min(available / maxWidth, FIT_MAX_ZOOM / 100 * CSS_PX_PER_PT));
  }

  #applyScale({ keepPosition = true } = {}) {
    if (!this.items.length) return;
    const anchor = keepPosition ? this.#positionAnchor() : null;
    this.scale = this.#computeScale();
    for (const item of this.items) {
      item.el.style.width = `${Math.floor(item.width * this.scale)}px`;
      item.el.style.height = `${Math.floor(item.height * this.scale)}px`;
      item.el.style.setProperty('--scale-factor', this.scale);
      // 描き直すまでの間は、今の画像を拡大・縮小して見せておく(canvasは幅100%で表示)
      if (item.visible) this.#render(item);
    }
    if (anchor) this.#restoreAnchor(anchor);
    this.onZoomChange?.(this.zoomState());
  }

  // 倍率を変えても、今読んでいる位置が画面上で動かないようにする
  #positionAnchor() {
    const item = this.items[this.current];
    if (!item) return null;
    const rect = item.el.getBoundingClientRect();
    return { item, ratio: (this.getTopInset() - rect.top) / rect.height, offset: this.getTopInset() };
  }

  #restoreAnchor({ item, ratio, offset }) {
    const rect = item.el.getBoundingClientRect();
    window.scrollBy(0, rect.top + ratio * rect.height - offset);
  }

  #onIntersect(entries) {
    for (const entry of entries) {
      const item = this.items[Number(entry.target.dataset.index)];
      if (!item) continue;
      item.visible = entry.isIntersecting;
      if (item.visible) this.#render(item);
      else this.#release(item);
    }
  }

  async #render(item) {
    if (item.renderedScale === this.scale || item.pendingScale === this.scale) return;
    item.task?.cancel();
    item.textLayer?.cancel();
    const scale = this.scale;
    item.pendingScale = scale;
    const viewport = item.page.getViewport({ scale, rotation: item.rotation });
    const outputScale = Math.min(window.devicePixelRatio || 1,
      Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    const task = item.page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    });
    item.task = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.error(err);
      if (item.task === task) item.task = item.pendingScale = null;
      return;
    }
    if (item.task !== task) return; // もっと新しい描画が始まっている
    item.task = null;
    item.pendingScale = null;
    if (item.canvas) item.canvas.replaceWith(canvas);
    else item.el.prepend(canvas);
    item.canvas = canvas;
    item.renderedScale = scale;

    // 文字を選択・コピーできるよう、透明な文字を画像の上に重ねる
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    const textLayer = new TextLayer({ textContentSource: item.page.streamTextContent(), container: textDiv, viewport });
    item.textLayer = textLayer;
    try {
      await textLayer.render();
    } catch {
      return; // 文字情報が取れないページ(スキャン画像など)は選択できないだけで、表示には影響しない
    }
    if (item.textLayer !== textLayer) return;
    item.el.querySelector('.textLayer')?.remove();
    item.el.appendChild(textDiv);
  }

  #release(item) {
    item.task?.cancel();
    item.textLayer?.cancel();
    item.task = item.textLayer = item.pendingScale = null;
    if (item.canvas) {
      item.canvas.width = item.canvas.height = 0;
      item.canvas.remove();
      item.canvas = null;
    }
    item.el.querySelector('.textLayer')?.remove();
    item.renderedScale = 0;
  }

  // 画面の上から3割の位置にあるページを「今のページ」とする
  #updateCurrent() {
    const top = this.getTopInset();
    const line = top + (window.innerHeight - top) * 0.3;
    let index = this.items.findIndex((it) => it.el.getBoundingClientRect().bottom > line);
    if (index < 0) index = this.items.length - 1;
    if (index !== this.current) {
      this.current = index;
      this.onPageChange?.(index);
    }
  }

  #teardown() {
    this.observer.disconnect();
    for (const item of this.items) this.#release(item);
    this.items = [];
    this.root.replaceChildren();
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onResize);
  }
}
