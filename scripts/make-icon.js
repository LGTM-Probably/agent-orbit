const fs = require("fs");
const path = require("path");

function renderIconBitmap(size) {
  const pixels = new Uint8Array(size * size * 4); // RGBA

  const cx = size / 2;
  const cy = size / 2;

  // Parameters proportional to size
  const rCore = size * 0.22;
  const rx = size * 0.40;
  const ry = size * 0.20;
  const angle = -25 * (Math.PI / 180);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  // Mint moon position on orbit
  const moonT = 0.8; // parametric angle
  const moonXLocal = rx * Math.cos(moonT);
  const moonYLocal = ry * Math.sin(moonT);
  const moonX = cx + (moonXLocal * cosA - moonYLocal * sinA);
  const moonY = cy + (moonXLocal * sinA + moonYLocal * cosA);
  const rMoon = size * 0.10;

  // Supersampling 3x3 for crisp anti-aliasing
  const sub = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let totalR = 0, totalG = 0, totalB = 0, totalA = 0;

      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const px = x + (sx + 0.5) / sub;
          const py = y + (sy + 0.5) / sub;

          const dx = px - cx;
          const dy = py - cy;

          // Rotate into ellipse frame
          const ex = dx * cosA + dy * sinA;
          const ey = -dx * sinA + dy * cosA;

          // Ellipse normalized radius
          const eDist = Math.sqrt((ex / rx) ** 2 + (ey / ry) ** 2);
          const ringWidth = 0.14; // normalized width
          const inRing = Math.abs(eDist - 1.0) <= ringWidth;

          // Core circle
          const distCore = Math.hypot(dx, dy);
          const inCore = distCore <= rCore;

          // Moon circle
          const distMoon = Math.hypot(px - moonX, py - moonY);
          const inMoon = distMoon <= rMoon;

          // Color priority: Moon (front), Core (center), Ring
          if (inMoon) {
            // Mint #34d399 (52, 211, 153)
            totalR += 52;
            totalG += 211;
            totalB += 153;
            totalA += 255;
          } else if (inCore) {
            // Coral #fb7185 (251, 113, 133)
            totalR += 251;
            totalG += 113;
            totalB += 133;
            totalA += 255;
          } else if (inRing) {
            // Violet #8b5cf6 (139, 92, 246)
            totalR += 139;
            totalG += 92;
            totalB += 246;
            totalA += 220;
          }
        }
      }

      const count = sub * sub;
      const idx = (y * size + x) * 4;
      pixels[idx + 0] = Math.round(totalR / count);
      pixels[idx + 1] = Math.round(totalG / count);
      pixels[idx + 2] = Math.round(totalB / count);
      pixels[idx + 3] = Math.round(totalA / count);
    }
  }

  return pixels;
}

function buildBmpData(size, rgba) {
  const andStride = Math.ceil(size / 32) * 4;
  const andSize = andStride * size;
  const xorSize = size * size * 4;
  const headerSize = 40;
  const totalSize = headerSize + xorSize + andSize;

  const buf = Buffer.alloc(totalSize);

  // BITMAPINFOHEADER
  buf.writeUInt32LE(headerSize, 0);       // biSize
  buf.writeInt32LE(size, 4);              // biWidth
  buf.writeInt32LE(size * 2, 8);          // biHeight (doubled for XOR+AND)
  buf.writeUInt16LE(1, 12);               // biPlanes
  buf.writeUInt16LE(32, 14);              // biBitCount (32 bpp RGBA)
  buf.writeUInt32LE(0, 16);               // biCompression (BI_RGB)
  buf.writeUInt32LE(xorSize + andSize, 20);// biSizeImage
  buf.writeInt32LE(0, 24);                // biXPelsPerMeter
  buf.writeInt32LE(0, 28);                // biYPelsPerMeter
  buf.writeUInt32LE(0, 32);               // biClrUsed
  buf.writeUInt32LE(0, 36);               // biClrImportant

  // XOR bitmap: bottom row to top row in BGRA format
  let offset = headerSize;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const srcIdx = (y * size + x) * 4;
      const r = rgba[srcIdx + 0];
      const g = rgba[srcIdx + 1];
      const b = rgba[srcIdx + 2];
      const a = rgba[srcIdx + 3];

      buf[offset + 0] = b;
      buf[offset + 1] = g;
      buf[offset + 2] = r;
      buf[offset + 3] = a;
      offset += 4;
    }
  }

  // AND mask: all 0 (since 32-bit alpha channel controls transparency)
  buf.fill(0, offset, offset + andSize);

  return buf;
}

function createIco(sizes) {
  const images = sizes.map(size => {
    const rgba = renderIconBitmap(size);
    const data = buildBmpData(size, rgba);
    return { size, data };
  });

  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + dirEntrySize * images.length;

  const entries = [];
  for (const img of images) {
    entries.push({
      size: img.size,
      dataSize: img.data.length,
      offset: offset,
      data: img.data,
    });
    offset += img.data.length;
  }

  const outBuf = Buffer.alloc(offset);

  // ICONHEADER
  outBuf.writeUInt16LE(0, 0);               // idReserved = 0
  outBuf.writeUInt16LE(1, 2);               // idType = 1 (ICO)
  outBuf.writeUInt16LE(images.length, 4);   // idCount

  // ICONDIRENTRY list
  let dirOffset = headerSize;
  for (const entry of entries) {
    outBuf.writeUInt8(entry.size >= 256 ? 0 : entry.size, dirOffset + 0); // bWidth
    outBuf.writeUInt8(entry.size >= 256 ? 0 : entry.size, dirOffset + 1); // bHeight
    outBuf.writeUInt8(0, dirOffset + 2);                                  // bColorCount
    outBuf.writeUInt8(0, dirOffset + 3);                                  // bReserved
    outBuf.writeUInt16LE(1, dirOffset + 4);                               // wPlanes
    outBuf.writeUInt16LE(32, dirOffset + 6);                              // wBitCount
    outBuf.writeUInt32LE(entry.dataSize, dirOffset + 8);                  // dwBytesInRes
    outBuf.writeUInt32LE(entry.offset, dirOffset + 12);                   // dwImageOffset
    dirOffset += dirEntrySize;
  }

  // Image data blocks
  for (const entry of entries) {
    entry.data.copy(outBuf, entry.offset);
  }

  return outBuf;
}

const assetsDir = path.resolve(__dirname, "../assets");
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

const icoBuffer = createIco([16, 32, 48, 64]);
const icoPath = path.join(assetsDir, "orbit.ico");
fs.writeFileSync(icoPath, icoBuffer);
console.log(`Generated ${icoPath} (${icoBuffer.length} bytes, sizes: 16, 32, 48, 64)`);
