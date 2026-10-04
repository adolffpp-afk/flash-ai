/** Width and height of a PNG, JPEG or WebP image, read from its header. Null for anything else. */
export function imageDimensions(data: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = (i: number, ...bytes: number[]) => bytes.every((b, j) => data[i + j] === b);
  // PNG: the IHDR chunk follows the 8-byte signature.
  if (data.length >= 24 && at(0, 0x89, 0x50, 0x4e, 0x47)) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (data.length >= 4 && at(0, 0xff, 0xd8)) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      const length = view.getUint16(i + 2);
      // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      }
      i += 2 + length;
    }
    return null;
  }
  // WebP: RIFF....WEBP, then a VP8, VP8L or VP8X chunk.
  if (data.length >= 30 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    const chunk = String.fromCharCode(data[12], data[13], data[14], data[15]);
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const w = data[24] | (data[25] << 8) | (data[26] << 16);
      const h = data[27] | (data[28] << 8) | (data[29] << 16);
      return { width: w + 1, height: h + 1 };
    }
  }
  return null;
}

// Photo edits are priced for images up to this many pixels in and out (2048 × 2048).
export const MAX_EDIT_PIXELS = 2048 * 2048;
