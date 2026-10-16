// 保存するPDFから、削除したページのデータを取り除く
//
// pdf-lib の copyPages は、残したページから参照されているものを丸ごとコピーする。そのため次の場合に
// 削除したページのデータが保存後のPDFに残ってしまう。
//  1. 全ページで共有されたリソース(画像などの一覧)を使っているPDF
//     → 残したページと一緒に、削除したページだけで使っていた画像もコピーされる
//  2. 残したページに、削除したページへのリンクや参照がある
//     → リンク先として、削除したページが中身ごとコピーされる
// ここでは (1) ページの描画命令で使われていない画像をリソースから外し、
// (2) 保存しないページへの参照を切り、最後に (3) どこからも参照されなくなったデータを消す。

const { PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFRawStream, PDFNull, decodePDFRawStream } = window.PDFLib;

const N = (name) => PDFName.of(name);

export function removeUnusedData(doc) {
  const keptPages = new Set(doc.getPages().map((p) => p.ref));
  for (const page of doc.getPages()) {
    removeUnusedXObjects(doc, page.node);
    removeLinksToDroppedPages(doc, page.node, keptPages);
  }
  removeUnreachableObjects(doc, keptPages);
}

// ---- (1) ページで使っていない画像(XObject)をリソースから外す ----
function removeUnusedXObjects(doc, pageNode) {
  const resources = pageNode.lookup(N('Resources'));
  if (!(resources instanceof PDFDict)) return;
  const xobjects = resources.lookup(N('XObject'));
  if (!(xobjects instanceof PDFDict)) return;

  const used = usedXObjectNames(doc, pageNode);
  if (!used) return; // 描画命令を読めないページは、安全のため何もしない
  const names = new Set(xobjects.keys().map((k) => k.asString()));
  // 描画命令に出てくる名前がリソースに見つからない場合は、名前の解釈が合っていない可能性があるので触らない
  if ([...used].some((name) => !names.has(name))) return;
  const unused = xobjects.keys().filter((k) => !used.has(k.asString()));
  if (!unused.length) return;

  // リソースは他のページと共有されていることがあるので、このページ用に複製してから外す
  const ownXObjects = xobjects.clone(doc.context);
  for (const key of unused) ownXObjects.delete(key);
  const ownResources = resources.clone(doc.context);
  ownResources.set(N('XObject'), ownXObjects);
  pageNode.set(N('Resources'), ownResources);
}

// ページの描画命令(コンテンツストリーム)の中で「/名前 Do」として使われている画像の名前
function usedXObjectNames(doc, pageNode) {
  const contents = pageNode.lookup(N('Contents'));
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((ref) => doc.context.lookup(ref))
    : [contents];
  let text = '';
  for (const stream of streams) {
    if (!stream) continue;
    if (!(stream instanceof PDFRawStream)) return null;
    try {
      text += ' ' + latin1(decodePDFRawStream(stream).decode());
    } catch {
      return null; // 対応していない圧縮形式
    }
  }
  const used = new Set();
  for (const m of text.matchAll(/(\/[^\s/[\]()<>{}%]+)\s+Do(?![^\s/[\]()<>{}%])/g)) used.add(m[1]);
  return used;
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

// ---- (2) 削除したページへのリンクを外す ----
function removeLinksToDroppedPages(doc, pageNode, keptPages) {
  const annots = pageNode.lookup(N('Annots'));
  if (!(annots instanceof PDFArray)) return;
  const kept = annots.asArray().filter((ref) => {
    const annot = doc.context.lookup(ref);
    return !(annot instanceof PDFDict && linkTargetsDroppedPage(doc, annot, keptPages));
  });
  if (kept.length === annots.size()) return;
  pageNode.set(N('Annots'), doc.context.obj(kept));
}

function linkTargetsDroppedPage(doc, annot, keptPages) {
  const action = annot.lookup(N('A'));
  const dest = annot.lookup(N('Dest')) ?? (action instanceof PDFDict ? action.lookup(N('D')) : undefined);
  if (!(dest instanceof PDFArray) || dest.size() === 0) return false;
  const target = dest.get(0);
  return target instanceof PDFRef && isPage(doc, target) && !keptPages.has(target);
}

function isPage(doc, ref) {
  const obj = doc.context.lookup(ref);
  return obj instanceof PDFDict && obj.get(N('Type')) === N('Page');
}

// ---- (3) どこからも参照されていないデータを消す ----
// 文書の起点(Root・Info)からたどれるものだけを残す。たどる途中で保存しないページへの参照
// (注釈の /P など)が見つかったら、その参照を切ってページの中身までたどらないようにする。
function removeUnreachableObjects(doc, keptPages) {
  const ctx = doc.context;
  const reachable = new Set();
  const dropped = (value) => value instanceof PDFRef && !keptPages.has(value) && isPage(doc, value);
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter(Boolean);

  while (stack.length) {
    const value = stack.pop();
    if (value instanceof PDFRef) {
      if (reachable.has(value)) continue;
      reachable.add(value);
      const obj = ctx.lookup(value);
      if (obj) stack.push(obj);
    } else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) {
        if (dropped(child)) value.delete(key);
        else stack.push(child);
      }
    } else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) {
        const child = value.get(i);
        if (dropped(child)) value.set(i, PDFNull);
        else stack.push(child);
      }
    } else if (value instanceof PDFStream) {
      stack.push(value.dict);
    }
  }

  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) ctx.delete(ref);
  }
}
