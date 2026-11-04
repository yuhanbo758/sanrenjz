(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ImageOptimizerCodecs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clampDimension(value, fallback) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) && number > 0 ? Math.min(number, 8192) : fallback;
  }

  function resolveDimensions(sourceWidth, sourceHeight, width, height, keepRatio) {
    const sourceW = clampDimension(sourceWidth, 1);
    const sourceH = clampDimension(sourceHeight, 1);
    let targetW = clampDimension(width, 0);
    let targetH = clampDimension(height, 0);

    if (!targetW && !targetH) return { width: sourceW, height: sourceH };
    if (!keepRatio) {
      return {
        width: targetW || sourceW,
        height: targetH || sourceH
      };
    }
    if (targetW && targetH) return { width: targetW, height: targetH };
    if (targetW) targetH = Math.max(1, Math.round(sourceH * targetW / sourceW));
    else targetW = Math.max(1, Math.round(sourceW * targetH / sourceH));
    return { width: targetW, height: targetH };
  }

  function encodeIco(pngBytes, width, height) {
    const png = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);
    const targetWidth = clampDimension(width, 256);
    const targetHeight = clampDimension(height, 256);
    if (targetWidth > 256 || targetHeight > 256) throw new Error('ICO 格式的宽高不能超过 256 像素');

    const result = new Uint8Array(22 + png.length);
    const view = new DataView(result.buffer);
    view.setUint16(0, 0, true);
    view.setUint16(2, 1, true);
    view.setUint16(4, 1, true);
    result[6] = targetWidth === 256 ? 0 : targetWidth;
    result[7] = targetHeight === 256 ? 0 : targetHeight;
    result[8] = 0;
    result[9] = 0;
    view.setUint16(10, 1, true);
    view.setUint16(12, 32, true);
    view.setUint32(14, png.length, true);
    view.setUint32(18, 22, true);
    result.set(png, 22);
    return result;
  }

  function encodeBmp(imageData) {
    const width = clampDimension(imageData && imageData.width, 0);
    const height = clampDimension(imageData && imageData.height, 0);
    const rgba = imageData && imageData.data;
    if (!width || !height || !rgba || rgba.length < width * height * 4) throw new Error('无法生成 BMP：像素数据无效');

    const pixelBytes = width * height * 4;
    const result = new Uint8Array(54 + pixelBytes);
    const view = new DataView(result.buffer);
    result[0] = 0x42;
    result[1] = 0x4d;
    view.setUint32(2, result.length, true);
    view.setUint32(10, 54, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, width, true);
    view.setInt32(22, -height, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 32, true);
    view.setUint32(34, pixelBytes, true);
    for (let source = 0, target = 54; source < pixelBytes; source += 4, target += 4) {
      result[target] = rgba[source + 2];
      result[target + 1] = rgba[source + 1];
      result[target + 2] = rgba[source];
      result[target + 3] = rgba[source + 3];
    }
    return result;
  }

  return { resolveDimensions, encodeIco, encodeBmp };
});
