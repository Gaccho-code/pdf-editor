// PDFのファイルサイズ圧縮
// - recompressImages: PDF内のJPEG画像を縮小・再圧縮する(文字やベクター図形はそのまま)
// - rasterizePages:   各ページを1枚のJPEG画像にしたPDFを作る(確実に小さくなるが、文字の選択・検索はできなくなる)

const { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray, PDFStream } = window.PDFLib;

export const COMPRESS_LEVELS = {
  light: { dpi: 200, quality: 0.85, rasterize: false },
  standard: { dpi: 150, quality: 0.75, rasterize: false },
  max: { dpi: 120, quality: 0.65, rasterize: true },
};

const MAX_CANVAS_PIXELS = 16_000_000; // ブラウザのcanvas上限より十分小さく抑える

const N = (name) => PDFName.of(name);

// ---- 画像の再圧縮 ----
export async function recompressImages(doc, { dpi, quality }, onProgress = () => {}) {
  // 画像がどのページにどの大きさで置かれているかまでは調べず、
  // 「最も大きいページ全体に表示されても dpi を下回らない」大きさを上限にする
  const longestInch = Math.max(...doc.getPages().map((pg) => {
    const { width, height } = pg.getSize();
    return Math.max(width, height) / 72;
  }));
  const maxPx = Math.ceil(longestInch * dpi);

  const targets = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && isRecompressible(doc, obj.dict)) targets.push([ref, obj]);
  }

  let done = 0;
  for (const [ref, obj] of targets) {
    onProgress(++done, targets.length);
    try {
      const replaced = await reencodeJpeg(obj.contents, maxPx, quality);
      if (!replaced || replaced.bytes.length >= obj.contents.length) continue; // 小さくならなければ元のまま
      const dict = obj.dict.clone(doc.context);
      dict.set(N('Width'), PDFNumber.of(replaced.width));
      dict.set(N('Height'), PDFNumber.of(replaced.height));
      dict.set(N('ColorSpace'), N('DeviceRGB')); // canvasの出力は常にRGBのJPEG
      dict.set(N('BitsPerComponent'), PDFNumber.of(8));
      dict.set(N('Filter'), N('DCTDecode'));
      dict.delete(N('DecodeParms'));
      doc.context.assign(ref, PDFRawStream.of(dict, replaced.bytes));
    } catch (err) {
      console.warn('画像を圧縮できなかったため元のまま残します', err);
    }
  }
}

// ブラウザでそのままデコードできるJPEG(グレー・RGB)だけを対象にする
function isRecompressible(doc, dict) {
  if (dict.get(N('Subtype')) !== N('Image')) return false;
  if (dict.get(N('ImageMask')) || dict.has(N('Decode'))) return false;
  const filter = dict.lookup(N('Filter'));
  const isDct = filter === N('DCTDecode') ||
    (filter instanceof PDFArray && filter.size() === 1 && filter.lookup(0) === N('DCTDecode'));
  if (!isDct) return false;
  const components = colorComponents(doc, dict.lookup(N('ColorSpace')));
  return components === 1 || components === 3; // CMYKなどは色が変わるおそれがあるので触らない
}

function colorComponents(doc, cs) {
  if (cs === N('DeviceGray') || cs === N('CalGray')) return 1;
  if (cs === N('DeviceRGB') || cs === N('CalRGB')) return 3;
  if (cs instanceof PDFArray) {
    const family = cs.lookup(0);
    if (family === N('CalGray')) return 1;
    if (family === N('CalRGB')) return 3;
    if (family === N('ICCBased')) {
      const stream = cs.lookup(1);
      const n = stream instanceof PDFStream ? stream.dict.lookup(N('N')) : null;
      return n ? n.asNumber() : 0;
    }
  }
  return 0;
}

async function reencodeJpeg(bytes, maxPx, quality) {
  // PDF内のJPEGはEXIFの向きや色プロファイルを無視して扱う決まりなので、ブラウザの自動補正を止める
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), {
    imageOrientation: 'none',
    colorSpaceConversion: 'none',
  });
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height),
    Math.sqrt(MAX_CANVAS_PIXELS / (bitmap.width * bitmap.height)));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { width, height, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

// ---- ページの画像化 ----
// items: [{ getPage: () => Promise<pdf.jsのページ>, rotation: 追加の回転角度 }]
export async function rasterizePages(items, { dpi, quality }, onProgress = () => {}) {
  const out = await PDFDocument.create();
  for (let i = 0; i < items.length; i++) {
    onProgress(i + 1, items.length);
    const page = await items[i].getPage();
    const rotation = (page.rotate + items[i].rotation) % 360;
    const size = page.getViewport({ scale: 1, rotation }); // 単位はポイント(1/72インチ)
    const scale = Math.min(dpi / 72, Math.sqrt(MAX_CANVAS_PIXELS / (size.width * size.height)));
    const viewport = page.getViewport({ scale, rotation });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // JPEGは透明を扱えないので白で塗っておく
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    canvas.width = canvas.height = 0; // メモリをすぐ解放する

    const image = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    out.addPage([size.width, size.height]).drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
  }
  return out.save();
}
