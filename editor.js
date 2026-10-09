// PDF Page Editor
// - 表示(サムネイル): pdf.js
// - 編集結果の書き出し: pdf-lib
// ファイルはすべてブラウザ内で処理し、外部には送信しない。

import * as pdfjsLib from './lib/pdf.min.mjs';
import { COMPRESS_LEVELS, recompressImages, rasterizePages } from './compress.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
const PDFJS_OPTIONS = {
  cMapUrl: new URL('./lib/cmaps/', import.meta.url).href, // 日本語などCIDフォントの表示に必要
  cMapPacked: true,
  standardFontDataUrl: new URL('./lib/standard_fonts/', import.meta.url).href,
  isEvalSupported: false, // 拡張機能のCSPでevalは使えない
};
const { PDFDocument, degrees, EncryptedPDFError } = window.PDFLib;

const ZOOM_LEVELS = [60, 80, 100, 150, 200, 300]; // 表示倍率(%)
const BASE_CARD_WIDTH = 170; // 100%のときのページ1枚分の幅(px)
const THUMB_SIZES = [320, 640, 1280]; // サムネイルの長辺(px)の段階

// ---- 状態 ----
// sources: 読み込んだPDF。{ name, viewDoc(pdf.js), editDoc(pdf-lib) }
// pages:   現在のページ並び。{ id, src, index, rotation }(rotationは元の向きに対する追加回転 0/90/180/270)
//          ページオブジェクトは不変として扱い、変更時は新しい配列を作る(Undoのため)
const sources = [];
let pages = [];
let selected = new Set();
let anchorId = null; // Shift+クリックの範囲選択の起点
let nextId = 1;
let dirty = false;
const undoStack = [];
const redoStack = [];
const thumbs = new Map(); // "src:index@size" -> Promise<objectURL>
const bestThumbs = new Map(); // "src:index" -> 描画済みで最も高解像度の { size, url }
let zoomLevel = loadZoom();
let thumbQueue = Promise.resolve();
let dragIds = null; // ページのドラッグ中に動かしているID

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const grid = $('grid');
const empty = $('empty');
const statusEl = $('status');
const fileInput = $('file-input');
const overlay = $('drop-overlay');
const zoomInput = $('zoom');
const zoomLabel = $('zoom-label');
const compressDialog = $('compress-dialog');
const compressResult = $('compress-result');
const btn = {
  compress: $('btn-compress'),
  compressRun: $('btn-compress-run'),
  compressDownload: $('btn-compress-download'),
  zoomIn: $('btn-zoom-in'),
  zoomOut: $('btn-zoom-out'),
  add: $('btn-add'),
  open: $('btn-open'),
  selectAll: $('btn-select-all'),
  rotateLeft: $('btn-rotate-left'),
  rotateRight: $('btn-rotate-right'),
  del: $('btn-delete'),
  undo: $('btn-undo'),
  redo: $('btn-redo'),
  reset: $('btn-reset'),
  save: $('btn-save'),
};

// ---- 履歴 ----
function commit(newPages) {
  undoStack.push(pages);
  redoStack.length = 0;
  pages = newPages;
  dirty = true;
  render();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(pages);
  pages = undoStack.pop();
  dirty = true;
  render();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(pages);
  pages = redoStack.pop();
  dirty = true;
  render();
}

// ---- 読み込み ----
async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) {
    flash('PDFファイルを選択してください。');
    return;
  }
  const added = [];
  const errors = [];
  for (const file of files) {
    setStatus(`読み込み中: ${file.name}`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // pdf-libは暗号化PDFを正しく書き出せないため、読み込み時点で弾く
      const editDoc = await PDFDocument.load(bytes);
      // pdf.jsはバッファをWorkerへ転送して使えなくするのでコピーを渡す
      const viewDoc = await pdfjsLib.getDocument({ ...PDFJS_OPTIONS, data: bytes.slice() }).promise;
      const src = sources.push({ name: file.name, viewDoc, editDoc }) - 1;
      for (let i = 0; i < viewDoc.numPages; i++) {
        added.push({ id: nextId++, src, index: i, rotation: 0 });
      }
    } catch (err) {
      console.error(err);
      const encrypted = err instanceof EncryptedPDFError || err?.name === 'PasswordException';
      errors.push(`${file.name}: ${encrypted ? 'パスワード保護・暗号化されたPDFには対応していません' : '読み込めませんでした'}`);
    }
  }
  if (added.length) commit([...pages, ...added]);
  else render();
  if (errors.length) alert(errors.join('\n'));
}

function reset() {
  if (dirty && pages.length && !confirm('保存していない編集内容は失われます。クリアしますか？')) return;
  for (const s of sources) s.viewDoc.destroy();
  sources.length = 0;
  for (const p of thumbs.values()) p.then((url) => url && URL.revokeObjectURL(url));
  thumbs.clear();
  bestThumbs.clear();
  pages = [];
  selected.clear();
  undoStack.length = 0;
  redoStack.length = 0;
  dirty = false;
  render();
}

// ---- サムネイル ----
function thumbKey(p) {
  return `${p.src}:${p.index}`;
}

// 表示倍率に応じて必要な解像度を選ぶ。画質の段階を限ることで、倍率を少し変えただけでは再描画しない
function thumbSize() {
  const need = cardWidth() * (window.devicePixelRatio || 1);
  return THUMB_SIZES.find((s) => s >= need) ?? THUMB_SIZES.at(-1);
}

function getThumb(p, size = thumbSize()) {
  // 同じか高い解像度の画像がすでに描画中・描画済みなら、それを使う
  const larger = THUMB_SIZES.filter((s) => s > size).map((s) => `${thumbKey(p)}@${s}`).find((k) => thumbs.has(k));
  if (larger) return thumbs.get(larger);
  const key = `${thumbKey(p)}@${size}`;
  if (!thumbs.has(key)) {
    // 一度に大量に描画するとメモリを食うので1枚ずつ順番に描画する
    const job = thumbQueue.then(() => renderThumb(p, size)).catch((err) => {
      console.error(err);
      return null;
    });
    thumbQueue = job;
    thumbs.set(key, job);
    job.then((url) => {
      const best = bestThumbs.get(thumbKey(p));
      if (url && (!best || best.size < size)) bestThumbs.set(thumbKey(p), { size, url });
    });
  }
  return thumbs.get(key);
}

async function renderThumb(p, size) {
  const page = await sources[p.src].viewDoc.getPage(p.index + 1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: size / Math.max(base.width, base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  page.cleanup();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return URL.createObjectURL(blob);
}

// ---- 描画 ----
function render() {
  const has = pages.length > 0;
  empty.hidden = has;
  grid.hidden = !has;

  // Undo/Redoで消えたページの選択は外す
  const ids = new Set(pages.map((p) => p.id));
  selected = new Set([...selected].filter((id) => ids.has(id)));

  const frag = document.createDocumentFragment();
  pages.forEach((p, i) => frag.appendChild(createCard(p, i)));
  grid.replaceChildren(frag);

  updateToolbar();
}

function createCard(p, i) {
  const card = document.createElement('div');
  card.className = 'card' + (selected.has(p.id) ? ' selected' : '');
  card.dataset.id = p.id;
  card.draggable = true;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const showImage = (url) => {
    const img = document.createElement('img');
    img.src = url;
    img.alt = `${i + 1}ページ`;
    img.style.transform = `rotate(${p.rotation}deg)`;
    thumb.replaceChildren(img);
  };
  // 拡大直後は高解像度版ができるまで、手元にある画像を仮に表示しておく
  const best = bestThumbs.get(thumbKey(p));
  if (best) showImage(best.url);
  else {
    const loading = document.createElement('span');
    loading.className = 'loading';
    loading.textContent = '読み込み中…';
    thumb.appendChild(loading);
  }
  const size = thumbSize();
  if (!best || best.size < size) {
    getThumb(p, size).then((url) => {
      if (url) showImage(url);
      else if (!best) thumb.firstChild.textContent = '表示できません';
    });
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = i + 1;
  const src = document.createElement('span');
  src.className = 'src';
  src.textContent = sources.length > 1 ? `${sources[p.src].name} p.${p.index + 1}` : `元 p.${p.index + 1}`;
  src.title = `${sources[p.src].name} の ${p.index + 1}ページ目`;
  meta.append(num, src);

  const tools = document.createElement('div');
  tools.className = 'card-tools';
  tools.append(
    toolButton('rotate-left', '⟲', '左に90°回転'),
    toolButton('rotate-right', '⟳', '右に90°回転'),
    toolButton('delete', '✕', 'このページを削除', 'del'),
  );

  card.append(thumb, meta, tools);
  return card;
}

function toolButton(action, label, title, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.action = action;
  b.textContent = label;
  b.title = title;
  if (cls) b.className = cls;
  return b;
}

function updateToolbar() {
  const n = selected.size;
  btn.rotateLeft.disabled = n === 0;
  btn.rotateRight.disabled = n === 0;
  btn.del.disabled = n === 0;
  btn.selectAll.disabled = pages.length === 0;
  btn.undo.disabled = undoStack.length === 0;
  btn.redo.disabled = redoStack.length === 0;
  btn.save.disabled = pages.length === 0;
  btn.compress.disabled = pages.length === 0;
  btn.reset.disabled = sources.length === 0;
  btn.add.textContent = sources.length ? '＋ PDFを追加(結合)' : '＋ PDFを開く';

  if (!pages.length) setStatus('');
  else {
    const fileCount = sources.length > 1 ? `${sources.length}ファイル / ` : '';
    setStatus(`${fileCount}${pages.length}ページ` + (n ? `・${n}ページ選択中` : '') +
      '　|　ドラッグで並べ替え・クリックで選択(⌘/Ctrl・Shiftで複数選択)');
  }
}

let flashTimer;
function setStatus(text) {
  clearTimeout(flashTimer);
  statusEl.textContent = text;
}
function flash(text) {
  setStatus(text);
  flashTimer = setTimeout(updateToolbar, 3000);
}

// ---- 編集操作 ----
function rotate(ids, delta) {
  if (!ids.size) return;
  commit(pages.map((p) => (ids.has(p.id) ? { ...p, rotation: (p.rotation + delta + 360) % 360 } : p)));
}

function remove(ids) {
  if (!ids.size) return;
  commit(pages.filter((p) => !ids.has(p.id)));
}

function move(ids, targetId, after) {
  if (ids.includes(targetId)) return;
  const moving = pages.filter((p) => ids.includes(p.id));
  const rest = pages.filter((p) => !ids.includes(p.id));
  let at = rest.findIndex((p) => p.id === targetId);
  if (after) at++;
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (next.every((p, i) => p === pages[i])) return; // 位置が変わらなければ履歴に積まない
  commit(next);
}

// ---- 表示倍率 ----
function loadZoom() {
  try {
    const saved = Number(localStorage.getItem('zoomLevel'));
    if (ZOOM_LEVELS.includes(saved)) return saved;
  } catch {}
  return 100;
}

function cardWidth() {
  return Math.round(BASE_CARD_WIDTH * zoomLevel / 100);
}

function setZoom(level) {
  const anchor = visibleAnchor();
  const before = thumbSize();
  zoomLevel = level;
  try { localStorage.setItem('zoomLevel', level); } catch {}
  applyZoom();
  if (thumbSize() > before) render(); // 拡大して画質が足りなくなったら描き直す
  restoreAnchor(anchor);
}

// 倍率を変えても見ていたページが画面の同じ高さに残るよう、画面上部のページを目印にする。
// 続けて倍率を変えたときに目印が少しずつずれないよう、スクロールするまでは同じページを使い続ける
let lastAnchor = null; // { id, scrollY }

function visibleAnchor() {
  const kept = lastAnchor && lastAnchor.scrollY === window.scrollY &&
    grid.querySelector(`.card[data-id="${lastAnchor.id}"]`);
  const top = document.querySelector('.toolbar').getBoundingClientRect().bottom;
  const card = kept || [...grid.children].find((el) => el.getBoundingClientRect().bottom > top);
  return card && { id: card.dataset.id, y: card.getBoundingClientRect().top };
}

function restoreAnchor(anchor) {
  if (!anchor) return;
  const card = grid.querySelector(`.card[data-id="${anchor.id}"]`);
  if (card) window.scrollBy(0, card.getBoundingClientRect().top - anchor.y);
  lastAnchor = { id: anchor.id, scrollY: window.scrollY };
}

function stepZoom(delta) {
  const i = ZOOM_LEVELS.indexOf(zoomLevel) + delta;
  if (i >= 0 && i < ZOOM_LEVELS.length) setZoom(ZOOM_LEVELS[i]);
}

function applyZoom() {
  const i = ZOOM_LEVELS.indexOf(zoomLevel);
  grid.style.setProperty('--card', `${cardWidth()}px`);
  zoomInput.value = i;
  zoomLabel.textContent = `${zoomLevel}%`;
  btn.zoomOut.disabled = i === 0;
  btn.zoomIn.disabled = i === ZOOM_LEVELS.length - 1;
}

function selectAll() {
  selected = new Set(pages.map((p) => p.id));
  render();
}

// ---- 保存 ----
// 現在のページ並びで新しいPDFを組み立てる(元ファイルのオブジェクトはコピーされるので、組み立て後に加工しても元は変わらない)
async function buildPdf() {
  const out = await PDFDocument.create();
  // 元ファイルごとにまとめてコピーする
  const bySrc = new Map();
  for (const p of pages) {
    if (!bySrc.has(p.src)) bySrc.set(p.src, []);
    bySrc.get(p.src).push(p.index);
  }
  const copied = new Map();
  for (const [src, indices] of bySrc) {
    const copies = await out.copyPages(sources[src].editDoc, indices);
    indices.forEach((index, k) => copied.set(`${src}:${index}`, copies[k]));
  }
  for (const p of pages) {
    const page = copied.get(thumbKey(p));
    if (p.rotation) page.setRotation(degrees((page.getRotation().angle + p.rotation) % 360));
    out.addPage(page);
  }
  return out;
}

async function save() {
  if (!pages.length) return;
  btn.save.disabled = true;
  setStatus('PDFを作成中…');
  try {
    const bytes = await (await buildPdf()).save();
    download(bytes, outputName());
    dirty = false;
    flash('保存しました。');
  } catch (err) {
    console.error(err);
    alert('PDFの作成に失敗しました。\n' + err.message);
    updateToolbar();
  } finally {
    btn.save.disabled = pages.length === 0;
  }
}

function outputName(suffix = sources.length > 1 ? 'merged' : 'edited') {
  const base = sources[0].name.replace(/\.pdf$/i, '');
  return `${base}_${suffix}.pdf`;
}

// ---- 圧縮して保存 ----
// 圧縮は時間がかかるので、結果のサイズを見せてから利用者がダウンロードする
let compressed = null; // { bytes, level }
let compressing = false;

function openCompressDialog() {
  if (!pages.length) return;
  resetCompressResult();
  compressDialog.showModal();
}

function resetCompressResult() {
  compressed = null;
  compressResult.hidden = true;
  compressResult.textContent = '';
  btn.compressRun.hidden = false;
  btn.compressDownload.hidden = true;
}

async function runCompress() {
  const level = compressDialog.querySelector('input[name="level"]:checked').value;
  const cfg = COMPRESS_LEVELS[level];
  compressing = true;
  btn.compressRun.disabled = true;
  compressDialog.querySelectorAll('input[name="level"]').forEach((el) => (el.disabled = true));
  compressResult.hidden = false;
  const progress = (label) => (done, total) => (compressResult.textContent = `${label}… ${done} / ${total}`);
  try {
    compressResult.textContent = '圧縮前のサイズを確認中…';
    const before = (await (await buildPdf()).save()).length;
    let bytes;
    if (cfg.rasterize) {
      const items = pages.map((p) => ({
        getPage: () => sources[p.src].viewDoc.getPage(p.index + 1),
        rotation: p.rotation,
      }));
      bytes = await rasterizePages(items, cfg, progress('ページを画像に変換中'));
    } else {
      const doc = await buildPdf();
      await recompressImages(doc, cfg, progress('画像を圧縮中'));
      compressResult.textContent = 'PDFを作成中…';
      bytes = await doc.save();
    }
    const after = bytes.length;
    if (after < before * 0.97) {
      compressed = { bytes, level };
      const rate = Math.round((1 - after / before) * 100);
      compressResult.innerHTML = `<b>${formatSize(before)} → ${formatSize(after)}</b>（${rate}%小さくなりました）`;
      btn.compressRun.hidden = true;
      btn.compressDownload.hidden = false;
      btn.compressDownload.focus();
    } else {
      compressResult.textContent = `これ以上小さくできませんでした（${formatSize(before)}）。` +
        // 小さなPDFは画像化するとかえって大きくなるので、ある程度大きいときだけ「最大」を勧める
        (!cfg.rasterize && before >= 500 * 1024 ? '文字が中心のPDFは「最大」を選ぶと小さくなる場合があります。' : '');
    }
  } catch (err) {
    console.error(err);
    compressResult.textContent = '圧縮に失敗しました。' + err.message;
  } finally {
    compressing = false;
    btn.compressRun.disabled = false;
    compressDialog.querySelectorAll('input[name="level"]').forEach((el) => (el.disabled = false));
  }
}

function downloadCompressed() {
  if (!compressed) return;
  download(compressed.bytes, outputName('compressed'));
  dirty = false;
  compressDialog.close();
  flash('圧縮したPDFを保存しました。');
}

function formatSize(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- イベント: ツールバー ----
btn.add.addEventListener('click', () => fileInput.click());
btn.open.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});
btn.selectAll.addEventListener('click', selectAll);
btn.rotateLeft.addEventListener('click', () => rotate(selected, -90));
btn.rotateRight.addEventListener('click', () => rotate(selected, 90));
btn.del.addEventListener('click', () => remove(selected));
btn.undo.addEventListener('click', undo);
btn.redo.addEventListener('click', redo);
btn.reset.addEventListener('click', reset);
btn.save.addEventListener('click', save);
btn.compress.addEventListener('click', openCompressDialog);
btn.compressRun.addEventListener('click', runCompress);
btn.compressDownload.addEventListener('click', downloadCompressed);
compressDialog.addEventListener('change', resetCompressResult); // 圧縮レベルを変えたら結果を捨ててやり直す
compressDialog.addEventListener('cancel', (e) => {
  if (compressing) e.preventDefault(); // 圧縮中はEscで閉じない
});
btn.zoomIn.addEventListener('click', () => stepZoom(1));
btn.zoomOut.addEventListener('click', () => stepZoom(-1));
zoomInput.addEventListener('input', () => setZoom(ZOOM_LEVELS[Number(zoomInput.value)]));

// ---- イベント: カードのクリック(選択・個別操作) ----
grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) {
    selected.clear();
    render();
    return;
  }
  const id = Number(card.dataset.id);
  const action = e.target.closest('button')?.dataset.action;
  if (action) {
    const ids = new Set([id]);
    if (action === 'rotate-left') rotate(ids, -90);
    if (action === 'rotate-right') rotate(ids, 90);
    if (action === 'delete') remove(ids);
    return;
  }

  if (e.shiftKey && anchorId !== null && pages.some((p) => p.id === anchorId)) {
    const a = pages.findIndex((p) => p.id === anchorId);
    const b = pages.findIndex((p) => p.id === id);
    const [from, to] = a < b ? [a, b] : [b, a];
    if (!(e.metaKey || e.ctrlKey)) selected.clear();
    pages.slice(from, to + 1).forEach((p) => selected.add(p.id));
  } else if (e.metaKey || e.ctrlKey) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
    anchorId = id;
  } else {
    selected = new Set(selected.size === 1 && selected.has(id) ? [] : [id]);
    anchorId = id;
  }
  render();
});

// ---- イベント: ページのドラッグ&ドロップ(並べ替え) ----
grid.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = Number(card.dataset.id);
  // 選択中のページをドラッグした場合は、選択中のページをまとめて動かす
  dragIds = selected.has(id) ? pages.filter((p) => selected.has(p.id)).map((p) => p.id) : [id];
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
  for (const el of grid.children) {
    if (dragIds.includes(Number(el.dataset.id))) el.classList.add('dragging');
  }
});

let dropTarget = null; // { id, after }
grid.addEventListener('dragover', (e) => {
  if (!dragIds) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const card = e.target.closest('.card');
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const after = e.clientX > rect.left + rect.width / 2;
  clearDropMarks();
  card.classList.add(after ? 'drop-after' : 'drop-before');
  dropTarget = { id: Number(card.dataset.id), after };
});

grid.addEventListener('drop', (e) => {
  if (!dragIds) return;
  e.preventDefault();
  e.stopPropagation();
  if (dropTarget) move(dragIds, dropTarget.id, dropTarget.after);
});

grid.addEventListener('dragend', () => {
  dragIds = null;
  dropTarget = null;
  clearDropMarks();
  for (const el of grid.querySelectorAll('.dragging')) el.classList.remove('dragging');
});

function clearDropMarks() {
  for (const el of grid.querySelectorAll('.drop-before, .drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

// ---- イベント: PDFファイルのドロップ(読み込み・結合) ----
const isFileDrag = (e) => !dragIds && e.dataTransfer?.types.includes('Files');

document.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  overlay.hidden = false;
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) overlay.hidden = true;
});
document.addEventListener('drop', (e) => {
  overlay.hidden = true;
  if (!isFileDrag(e)) return;
  e.preventDefault();
  addFiles(e.dataTransfer.files);
});

// ---- イベント: キーボードショートカット ----
document.addEventListener('keydown', (e) => {
  if (compressDialog.open) return; // ダイアログ表示中はページ操作のショートカットを止める
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    redo();
  } else if (mod && key === 'a') {
    e.preventDefault();
    selectAll();
  } else if (mod && key === 's') {
    e.preventDefault();
    save();
  } else if (key === 'delete' || key === 'backspace') {
    if (selected.size) {
      e.preventDefault();
      remove(selected);
    }
  } else if (!mod && (key === '+' || key === '=' || key === ';')) {
    stepZoom(1); // ⌘/Ctrl+＋ はブラウザ自体の拡大なので、修飾キーなしの＋／－を割り当てる
  } else if (!mod && key === '-') {
    stepZoom(-1);
  } else if (key === 'escape') {
    selected.clear();
    render();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty && pages.length) e.preventDefault();
});

applyZoom();
render();
