"use strict";
// SeedHammer Studio — raster image tracer.
//
// Turns a dropped raster (logo, signature, line art) into engravable strokes.
// The engraver is a single-stroke centerline machine with no fill, so two
// modes exist, picked automatically from the ink's mean stroke width:
//   outline    — boundary loops of the dark region (filled logos, bold art)
//   centerline — Zhang-Suen thinning to a 1px skeleton (thin line art,
//                signatures, rasterized text strokes)
// Both modes finish through the same pipeline: smooth the pixel staircase,
// decimate, detect corners, and fit cubic Béziers between them, so the
// output is a few smooth strokes instead of thousands of pixel steps.
// Output is a segs array (M/L/C runs) in image pixel space; the caller
// scales and centers it into a scene object. Pure in-browser canvas work,
// no toolchain, no network.
window.Tracer = (function () {
  const OUTLINE_DIM = 720; // boundary tracing is cheap; keep detail
  const THIN_DIM = 360;    // thinning is O(passes·pixels); cap the cost

  function loadImageData(file, maxdim) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height; const s = Math.min(1, maxdim / Math.max(w, h));
        w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h); cx.drawImage(img, 0, 0, w, h);
        resolve(cx.getImageData(0, 0, w, h));
      };
      img.onerror = () => reject("bad image");
      img.src = URL.createObjectURL(file);
    });
  }
  // luma + Otsu threshold -> binary (1 = ink/dark)
  function binarize(id) {
    const { width: w, height: h, data } = id, gray = new Uint8Array(w * h), hist = new Array(256).fill(0);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const a = data[i + 3] / 255;
      const l = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a + 255 * (1 - a);
      gray[j] = l | 0; hist[gray[j]]++;
    }
    const total = w * h; let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, max = 0, thr = 128;
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break; sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2; if (between > max) { max = between; thr = t; } }
    const bin = new Uint8Array(w * h); for (let i = 0; i < bin.length; i++) bin[i] = gray[i] < thr ? 1 : 0;
    return { bin, w, h };
  }
  // Mean ink stroke width ≈ 2·area/perimeter: filled shapes are wide,
  // line art is a few pixels. Decides outline vs centerline in auto mode.
  function inkWidth(b) {
    const { bin, w, h } = b; let area = 0, perim = 0;
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : bin[y * w + x];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue; area++;
      if (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1)) perim++;
    }
    return perim ? 2 * area / perim : 0;
  }
  // 1px morphological open (4-neighbour erode then dilate): antialiasing
  // speckle along thresholded edges vanishes, real shapes keep their size.
  // Outline mode only — centerline's thin strokes would not survive erosion.
  function open1(b) {
    const { bin, w, h } = b;
    const at = (a, x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : a[y * w + x];
    const er = new Uint8Array(w * h), di = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      er[y * w + x] = bin[y * w + x] && at(bin, x - 1, y) && at(bin, x + 1, y) && at(bin, x, y - 1) && at(bin, x, y + 1) ? 1 : 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      di[y * w + x] = er[y * w + x] || at(er, x - 1, y) || at(er, x + 1, y) || at(er, x, y - 1) || at(er, x, y + 1) ? 1 : 0;
    return { bin: di, w, h };
  }

  // ---- outline: boundary loops of the ink region -------------------------
  // Boundary decomposition on the pixel-corner grid (the crack contour,
  // potrace's own path decomposition): walk edges between ink and non-ink
  // keeping ink on the right of travel. Every region boundary — outer
  // rings and holes alike — comes out as exactly one closed loop; the
  // walk cannot fragment or short-circuit the way a pixel-neighbour
  // walk can.
  function outline(b, eps, dbg) {
    const { bin, w, h } = b;
    const ink = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : bin[y * w + x];
    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // R D L U; right turn = +1
    // pixels right/left of the edge leaving corner (cx,cy) in direction d
    const pr = (cx, cy, d) => d === 0 ? [cx, cy] : d === 1 ? [cx - 1, cy] : d === 2 ? [cx - 1, cy - 1] : [cx, cy - 1];
    const pl = (cx, cy, d) => d === 0 ? [cx, cy - 1] : d === 1 ? [cx, cy] : d === 2 ? [cx - 1, cy] : [cx - 1, cy - 1];
    const ok = (cx, cy, d) => { const R = pr(cx, cy, d), L = pl(cx, cy, d); return !!ink(R[0], R[1]) && !ink(L[0], L[1]); };
    const walked = new Set();
    const walk = (sx, sy) => {
      const pts = []; let cx = sx, cy = sy, d = 0;
      for (;;) {
        walked.add(cx + "," + cy + "," + d);
        pts.push([cx, cy]);
        cx += DIRS[d][0]; cy += DIRS[d][1];
        const r = (d + 1) % 4, l = (d + 3) % 4;
        if (ok(cx, cy, r)) d = r; else if (ok(cx, cy, d)) { } else if (ok(cx, cy, l)) d = l; else break;
        if (walked.has(cx + "," + cy + "," + d)) break;
      }
      return pts;
    };
    const loops = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!ink(x, y) || ink(x, y - 1) || walked.has(x + "," + y + ",0")) continue;
      const lp = walk(x, y);
      if (lp.length >= 4) loops.push(lp);
    }
    // Speck filter (potrace's turdsize): loops enclosing next to nothing
    // are threshold noise, not art. Scales with the working resolution.
    const turd = 3 * Math.max(1, (Math.max(w, h) / 360) ** 2);
    const segs = [];
    if (dbg) { dbg.loops = loops.length; dbg.areas = loops.map(l => Math.round(loopArea(l))).slice(0, 8); dbg.lens = loops.map(l => l.length).slice(0, 8); dbg.kept = 0; }
    for (const lp of loops) {
      if (Math.abs(loopArea(lp)) < turd) continue;
      if (dbg) dbg.kept++;
      emitFitted(segs, smoothClosed(lp), true, eps);
    }
    return segs;
  }
  function loopArea(pts) { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }

  // ---- centerline: Zhang-Suen thinning + skeleton walk -------------------
  function centerline(b, eps) {
    const { w, h } = b; let bin = b.bin.slice();
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : bin[y * w + x];
    let changed = true, guard = 0;
    while (changed && guard++ < 200) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        const del = [];
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
          if (!bin[y * w + x]) continue;
          const p = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
          let B = 0, A = 0; for (let i = 0; i < 8; i++) { B += p[i]; if (!p[i] && p[(i + 1) % 8]) A++; }
          if (B < 2 || B > 6 || A !== 1) continue;
          const c1 = step === 0 ? p[0] * p[2] * p[4] : p[0] * p[2] * p[6];
          const c2 = step === 0 ? p[2] * p[4] * p[6] : p[0] * p[4] * p[6];
          if (c1 === 0 && c2 === 0) del.push(y * w + x);
        }
        if (del.length) { changed = true; for (const idx of del) bin[idx] = 0; }
      }
    }
    const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const deg = (x, y) => { let n = 0; for (const [dx, dy] of N8) if (at(x + dx, y + dy)) n++; return n; };
    const used = new Uint8Array(w * h), segs = [];
    // Trace a stroke from (sx,sy): at each step continue to the unused
    // neighbour that best preserves the current heading, so the path runs
    // straight THROUGH self-crossings and diagonal staircases instead of
    // splitting at every pixel an 8-neighbour count mistakes for a junction.
    // That keeps a signature a few long strokes, not dozens of gapped stubs.
    const trace = (sx, sy) => {
      const line = [[sx, sy]]; used[sy * w + sx] = 1;
      let px = sx, py = sy, hx = 0, hy = 0;
      for (;;) {
        let best = null, score = -Infinity;
        for (const [ex, ey] of N8) {
          const ax = px + ex, ay = py + ey; if (!at(ax, ay) || used[ay * w + ax]) continue;
          const l = Math.hypot(ex, ey), ux = ex / l, uy = ey / l;
          const s = (hx || hy) ? hx * ux + hy * uy : 0; // prefer straight ahead
          if (s > score) { score = s; best = [ax, ay, ux, uy]; }
        }
        if (!best) break;
        used[best[1] * w + best[0]] = 1; line.push([best[0], best[1]]);
        hx = best[2]; hy = best[3]; px = best[0]; py = best[1];
      }
      return line;
    };
    // Start at endpoints (a clean stroke ends at a degree-1 pixel); then trace
    // whatever is left (closed loops that have no endpoint).
    const starts = [], lines = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bin[y * w + x] && deg(x, y) === 1) starts.push([x, y]);
    for (const [x, y] of starts) if (!used[y * w + x]) { const l = trace(x, y); if (l.length >= 2) lines.push(l); }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bin[y * w + x] && !used[y * w + x]) { const l = trace(x, y); if (l.length >= 2) lines.push(l); }
    // Bridge the ~1px gaps where two traces met at a crossing (endpoints within
    // JOIN px). The threshold is small, so genuine pen-lifts stay separate.
    for (const l of joinLines(lines, 2.5)) {
      if (l.length < 2) continue;
      emitFitted(segs, smoothOpen(l.map(p => [p[0] + 0.5, p[1] + 0.5])), false, eps);
    }
    return segs;
  }
  // Chain polylines whose endpoints nearly touch into longer runs, so a stroke
  // that the tracer split at a crossing becomes one continuous line again.
  function joinLines(lines, d) {
    lines = lines.filter(l => l.length >= 2); const d2 = d * d;
    const near = (a, b) => { const dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy <= d2; };
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < lines.length && !merged; i++) for (let j = i + 1; j < lines.length; j++) {
        const A = lines[i], B = lines[j], aS = A[0], aE = A[A.length - 1], bS = B[0], bE = B[B.length - 1];
        if (near(aE, bS)) { lines[i] = A.concat(B); }
        else if (near(aE, bE)) { lines[i] = A.concat(B.slice().reverse()); }
        else if (near(aS, bE)) { lines[i] = B.concat(A); }
        else if (near(aS, bS)) { lines[i] = A.slice().reverse().concat(B); }
        else continue;
        lines.splice(j, 1); merged = true; break;
      }
    }
    return lines;
  }

  // ---- staircase smoothing ------------------------------------------------
  // Small moving-average passes turn the 1px Moore/skeleton staircase into
  // sub-pixel-ish curves before fitting; window ±2 rounds a step without
  // eating real features at the working resolutions.
  function smoothClosed(pts, passes = 2, w = 2) {
    let cur = pts;
    for (let p = 0; p < passes; p++) {
      const n = cur.length, out = new Array(n);
      for (let i = 0; i < n; i++) {
        let sx = 0, sy = 0, c = 0;
        for (let k = -w; k <= w; k++) { const q = cur[(i + k + n) % n]; sx += q[0]; sy += q[1]; c++; }
        out[i] = [sx / c, sy / c];
      }
      cur = out;
    }
    return cur;
  }
  function smoothOpen(pts, passes = 2, w = 2) {
    let cur = pts;
    for (let p = 0; p < passes; p++) {
      const n = cur.length, out = cur.slice();
      for (let i = 1; i < n - 1; i++) {
        let sx = 0, sy = 0, c = 0;
        for (let k = -w; k <= w; k++) { const j = Math.min(n - 1, Math.max(0, i + k)); sx += cur[j][0]; sy += cur[j][1]; c++; }
        out[i] = [sx / c, sy / c];
      }
      cur = out;
    }
    return cur;
  }

  // ---- corner-aware cubic fitting ----------------------------------------
  // Decimate, split at corners (turns sharper than CORNER_DEG stay sharp),
  // and least-squares-fit cubic Béziers to every run between corners
  // (Schneider, Graphics Gems: chord-length parameterize, solve the two
  // tangent magnitudes, Newton-reparameterize, split at the worst point
  // when the error stays high).
  const CORNER_DEG = 55;
  function emitFitted(segs, pts, closed, eps) {
    let poly = rdp(pts, Math.max(0.4, eps * 0.6));
    if (closed) {
      // rdp keeps endpoints; for a loop rotate so the run starts at the
      // sharpest turn, giving the fit stable tangents at the seam.
      if (poly.length > 3 && dist2(poly[0], poly[poly.length - 1]) < 1e-12) poly = poly.slice(0, -1);
      if (poly.length < 3) return;
      let sharpest = 0, worst = 2;
      for (let i = 0; i < poly.length; i++) {
        const c = turnCos(poly, i, true);
        if (c < worst) { worst = c; sharpest = i; }
      }
      poly = poly.slice(sharpest).concat(poly.slice(0, sharpest));
      poly.push(poly[0].slice()); // reclose
    }
    if (poly.length < 2) return;
    if (poly.length === 2) { segs.push({ op: "M", p: [poly[0]] }, { op: "L", p: [poly[1]] }); return; }
    // corner indexes (interior; for closed runs the seam point is a cut already)
    const cornerCos = Math.cos(CORNER_DEG * Math.PI / 180);
    const cuts = [0];
    for (let i = 1; i < poly.length - 1; i++) if (turnCos(poly, i, false) < cornerCos) cuts.push(i);
    cuts.push(poly.length - 1);
    segs.push({ op: "M", p: [poly[0]] });
    const maxErr = Math.max(0.35, eps * 0.9) ** 2;
    for (let c = 0; c + 1 < cuts.length; c++) {
      const run = poly.slice(cuts[c], cuts[c + 1] + 1);
      if (run.length === 2) { segs.push({ op: "L", p: [run[1]] }); continue; }
      fitCubic(run, tangent(run, 0), tangent(run, run.length - 1, true), maxErr, segs);
    }
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  function norm(v) { const l = Math.hypot(v[0], v[1]); return l ? [v[0] / l, v[1] / l] : [0, 0]; }
  function turnCos(poly, i, closed) {
    const n = poly.length, at = j => poly[closed ? (j + n) % n : Math.min(n - 1, Math.max(0, j))];
    const u = norm(sub(poly[i], at(i - 1))), v = norm(sub(at(i + 1), poly[i]));
    return u[0] * v[0] + u[1] * v[1];
  }
  function tangent(run, i, end) {
    return norm(end ? sub(run[run.length - 2], run[run.length - 1]) : sub(run[1], run[0]));
  }
  function fitCubic(pts, tHat1, tHat2, err2, out, depth) {
    depth = depth || 0;
    if (pts.length === 2) {
      const d = Math.sqrt(dist2(pts[0], pts[1])) / 3;
      out.push({ op: "C", p: [[pts[0][0] + tHat1[0] * d, pts[0][1] + tHat1[1] * d], [pts[1][0] + tHat2[0] * d, pts[1][1] + tHat2[1] * d], pts[1]] });
      return;
    }
    let u = chordParam(pts);
    let bez = generateBezier(pts, u, tHat1, tHat2);
    let [maxD, split] = maxError(pts, bez, u);
    if (maxD < err2) { out.push({ op: "C", p: [bez[1], bez[2], bez[3]] }); return; }
    if (maxD < err2 * 16) {
      for (let i = 0; i < 3; i++) {
        u = reparam(pts, u, bez);
        bez = generateBezier(pts, u, tHat1, tHat2);
        [maxD, split] = maxError(pts, bez, u);
        if (maxD < err2) { out.push({ op: "C", p: [bez[1], bez[2], bez[3]] }); return; }
      }
    }
    if (depth > 24) { out.push({ op: "C", p: [bez[1], bez[2], bez[3]] }); return; }
    // split at the worst point, with a centered tangent
    const cT = norm(sub(pts[split - 1], pts[split + 1]));
    fitCubic(pts.slice(0, split + 1), tHat1, cT, err2, out, depth + 1);
    fitCubic(pts.slice(split), [-cT[0], -cT[1]], tHat2, err2, out, depth + 1);
  }
  function chordParam(pts) {
    const u = [0];
    for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + Math.sqrt(dist2(pts[i], pts[i - 1])));
    const t = u[u.length - 1] || 1;
    return u.map(v => v / t);
  }
  function generateBezier(pts, u, tHat1, tHat2) {
    const n = pts.length, first = pts[0], last = pts[n - 1];
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let i = 0; i < n; i++) {
      const t = u[i], b0 = (1 - t) ** 3, b1 = 3 * t * (1 - t) ** 2, b2 = 3 * t * t * (1 - t), b3 = t ** 3;
      const a1 = [tHat1[0] * b1, tHat1[1] * b1], a2 = [tHat2[0] * b2, tHat2[1] * b2];
      c00 += a1[0] * a1[0] + a1[1] * a1[1];
      c01 += a1[0] * a2[0] + a1[1] * a2[1];
      c11 += a2[0] * a2[0] + a2[1] * a2[1];
      const tmp = [pts[i][0] - (first[0] * (b0 + b1) + last[0] * (b2 + b3)), pts[i][1] - (first[1] * (b0 + b1) + last[1] * (b2 + b3))];
      x0 += a1[0] * tmp[0] + a1[1] * tmp[1];
      x1 += a2[0] * tmp[0] + a2[1] * tmp[1];
    }
    const det = c00 * c11 - c01 * c01;
    let a1 = det ? (x0 * c11 - x1 * c01) / det : 0;
    let a2 = det ? (c00 * x1 - c01 * x0) / det : 0;
    const segLen = Math.sqrt(dist2(first, last)), fb = segLen / 3;
    if (a1 <= 1e-6 * segLen || a2 <= 1e-6 * segLen) { a1 = a2 = fb; }
    return [first, [first[0] + tHat1[0] * a1, first[1] + tHat1[1] * a1], [last[0] + tHat2[0] * a2, last[1] + tHat2[1] * a2], last];
  }
  const bez = (b, t) => {
    const u = 1 - t;
    return [u * u * u * b[0][0] + 3 * u * u * t * b[1][0] + 3 * u * t * t * b[2][0] + t * t * t * b[3][0],
            u * u * u * b[0][1] + 3 * u * u * t * b[1][1] + 3 * u * t * t * b[2][1] + t * t * t * b[3][1]];
  };
  function maxError(pts, b, u) {
    let maxD = 0, split = pts.length >> 1;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = bez(b, u[i]), d = dist2(p, pts[i]);
      if (d > maxD) { maxD = d; split = i; }
    }
    return [maxD, Math.max(1, Math.min(pts.length - 2, split))];
  }
  function reparam(pts, u, b) {
    // one Newton-Raphson step per parameter
    const d1 = [[3 * (b[1][0] - b[0][0]), 3 * (b[1][1] - b[0][1])], [3 * (b[2][0] - b[1][0]), 3 * (b[2][1] - b[1][1])], [3 * (b[3][0] - b[2][0]), 3 * (b[3][1] - b[2][1])]];
    const q1 = t => { const v = 1 - t; return [v * v * d1[0][0] + 2 * v * t * d1[1][0] + t * t * d1[2][0], v * v * d1[0][1] + 2 * v * t * d1[1][1] + t * t * d1[2][1]]; };
    const d2 = [[2 * (d1[1][0] - d1[0][0]), 2 * (d1[1][1] - d1[0][1])], [2 * (d1[2][0] - d1[1][0]), 2 * (d1[2][1] - d1[1][1])]];
    const q2 = t => [(1 - t) * d2[0][0] + t * d2[1][0], (1 - t) * d2[0][1] + t * d2[1][1]];
    return u.map((t, i) => {
      if (i === 0 || i === u.length - 1) return t;
      const p = bez(b, t), dp = [p[0] - pts[i][0], p[1] - pts[i][1]];
      const q1t = q1(t), q2t = q2(t);
      const num = dp[0] * q1t[0] + dp[1] * q1t[1];
      const den = q1t[0] * q1t[0] + q1t[1] * q1t[1] + dp[0] * q2t[0] + dp[1] * q2t[1];
      const nt = den ? t - num / den : t;
      return Math.max(0, Math.min(1, nt));
    });
  }

  // ---- Ramer-Douglas-Peucker ---------------------------------------------
  function rdp(points, eps) {
    if (points.length < 3) return points;
    let dmax = 0, idx = 0; const a = points[0], b = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) { const d = segDist(points[i], a, b); if (d > dmax) { dmax = d; idx = i; } }
    if (dmax > eps) { const l = rdp(points.slice(0, idx + 1), eps), r = rdp(points.slice(idx), eps); return l.slice(0, -1).concat(r); }
    return [a, b];
  }
  function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; if (!L) return Math.hypot(p[0] - a[0], p[1] - a[1]); let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)); }

  async function trace(file, opts) {
    let mode = (opts && opts.mode) || "auto";
    const detail = opts && opts.detail != null ? opts.detail : 1;
    const eps = 0.8 + 3 * (1 - detail);
    let id, b;
    if (mode === "auto") {
      id = await loadImageData(file, THIN_DIM); b = binarize(id);
      mode = inkWidth(b) > 4.5 ? "outline" : "centerline";
    }
    let segs;
    if (mode === "outline") {
      id = await loadImageData(file, OUTLINE_DIM); b = open1(binarize(id));
      segs = outline(b, eps);
    } else {
      if (!b || Math.max(b.w, b.h) > THIN_DIM) { id = await loadImageData(file, THIN_DIM); b = binarize(id); }
      segs = centerline(b, eps);
    }
    if (!segs.length) throw "no strokes found";
    segs.mode = mode;
    return segs;
  }
  return { trace, _test: { loadImageData, binarize, open1, inkWidth, outline, centerline } };
})();
