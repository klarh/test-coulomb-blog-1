/**
 * Cubehelix Fourier symmetry identicons.
 *
 * Direct port of the Python implementation in coulomb/render.py.
 * Generates identical SVGs so PWA feed and published site match.
 *
 * Green 2011: http://adsabs.harvard.edu/abs/2011BASI...39..289G
 */

const { PI, cos, sin, max, min, floor } = Math;
const TAU = 2 * PI;

function cubehelixRgb(lam, s = 0, r = 1, h = 1.2, gamma = 1) {
  lam = max(0, min(1, lam));
  const lg = lam ** gamma;
  const phi = TAU * (s / 3 + r * lam);
  const a = h * lg * (1 - lg) * 0.5;
  const cp = cos(phi), sp = sin(phi);
  return [
    max(0, min(1, lg + a * (-0.14861 * cp + 1.78277 * sp))),
    max(0, min(1, lg + a * (-0.29227 * cp - 0.90649 * sp))),
    max(0, min(1, lg + a * (1.97294 * cp))),
  ];
}

function rgbHex(r, g, b) {
  const c = v => floor(v * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Generate an identicon SVG string from a hex ID.
 * @param {string} idString - Hex string (author ID)
 * @param {number} size - SVG width/height in pixels
 * @returns {string} SVG markup
 */
export function generateIdenticonSVG(idString, size = 80) {
  let h = idString;
  while (h.length < 64) h += h;

  const chStart = parseInt(h.slice(0, 2), 16) / 256 * 3;
  const chRot = parseInt(h[2], 16) / 15;
  const n = [3, 4, 5, 6, 8][parseInt(h[3], 16) % 5];
  const cx = size / 2, cy = size / 2;
  const maxR = size * 0.45;
  const numRings = 2 + parseInt(h[4], 16) % 2;

  const ringLambdas = [];
  for (let ring = 0; ring < numRings; ring++) {
    ringLambdas.push(0.35 + 0.25 * ring / max(numRings - 1, 1));
  }

  let paths = '';
  for (let ring = numRings - 1; ring >= 0; ring--) {
    const baseR = maxR * (ring + 1) / numRings * 0.8;
    const points = [];

    for (let s = 0; s < 64; s++) {
      const theta = s / 64 * TAU;
      let r = baseR;
      for (let k = 1; k <= 3; k++) {
        const idx = 5 + ring * 8 + k * 2;
        const amp = parseInt(h[idx % h.length], 16) / 15 * baseR * 0.4;
        const phase = parseInt(h[(idx + 1) % h.length], 16) / 15 * TAU;
        r += amp * cos(n * k * theta + phase);
      }
      r = max(0, min(maxR, r));
      points.push(`${(cx + r * cos(theta)).toFixed(1)},${(cy + r * sin(theta)).toFixed(1)}`);
    }

    const [cr, cg, cb] = cubehelixRgb(ringLambdas[ring], chStart, chRot, 1.4);
    const fill = rgbHex(cr, cg, cb);
    paths += `<path d="M ${points.join(' L ')} Z" fill="${fill}"/>`;
  }

  const [br, bg_, bb] = cubehelixRgb(0.08, chStart, chRot, 0.6);
  const bgFill = rgbHex(br, bg_, bb);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${cx}" cy="${cy}" r="${size / 2}" fill="${bgFill}"/>` +
    `${paths}</svg>`
  );
}

/**
 * Return an identicon as a data: URI for use in img src.
 */
export function identiconDataURI(idString, size = 80) {
  const svg = generateIdenticonSVG(idString, size);
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
