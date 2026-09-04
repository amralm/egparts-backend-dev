'use strict';

/**
 * Standard Code 128B Barcode SVG Generator
 * Zero external dependencies, pure mathematical rendering.
 */

const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
];

function generateBarcode128Svg(text, options = {}) {
  const height = options.height || 50;
  const moduleWidth = options.moduleWidth || 2;
  const quietZone = options.quietZone !== false;
  const showText = options.showText !== false;

  const cleanText = String(text || '').replace(/[^\x20-\x7E]/g, '');
  if (!cleanText) return '';

  const codes = [104]; // Start B
  let checkSum = 104;

  for (let i = 0; i < cleanText.length; i++) {
    const val = cleanText.charCodeAt(i) - 32;
    codes.push(val);
    checkSum += val * (i + 1);
  }

  codes.push(checkSum % 103);
  codes.push(106); // Stop B

  const qzModules = quietZone ? 10 : 0;
  let totalModules = qzModules * 2;

  const patterns = codes.map(c => PATTERNS[c]);
  for (const p of patterns) {
    for (const char of p) {
      totalModules += parseInt(char, 10);
    }
  }

  const svgWidth = totalModules * moduleWidth;
  const svgHeight = showText ? height + 16 : height;

  let x = qzModules * moduleWidth;
  let rects = '';

  for (const p of patterns) {
    let isBar = true;
    for (let j = 0; j < p.length; j++) {
      const w = parseInt(p[j], 10) * moduleWidth;
      if (isBar) {
        rects += `<rect x="${x}" y="0" width="${w}" height="${height}" fill="#000000"/>`;
      }
      x += w;
      isBar = !isBar;
    }
  }

  let textSvg = '';
  if (showText) {
    textSvg = `<text x="${svgWidth / 2}" y="${height + 13}" font-family="monospace, Courier, sans-serif" font-size="12" font-weight="bold" fill="#000000" text-anchor="middle" letter-spacing="2">${cleanText}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}"><rect width="100%" height="100%" fill="#ffffff"/>${rects}${textSvg}</svg>`;
}

module.exports = { generateBarcode128Svg };
