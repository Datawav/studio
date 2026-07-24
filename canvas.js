"use strict";
// SeedHammer Studio — canvas editor.
//
// A WYSIWYG vector surface. Every object on the plate (text field, rect,
// ellipse, line, freehand, polygon, dropped SVG, traced image) is a scene
// object = local paths + an affine transform + a style. The scene serializes
// to the same curves payload the other tabs produce: worldSegs() bakes each
// object's transform into absolute plate-mm coordinates and hands the flat
// segs array to the existing emit()/draw()/gauges() pipeline unchanged.
//
// The editing surface is an <svg viewBox="0 0 85 85"> (1 unit = 1mm) over a
// steel-look backdrop; the faithful engraving preview + gauges live in the
// existing right-hand panel. This file reuses the inline script's globals
// (SH, emit, bounds, mapSeg, parsePath, extractSVG, poly, ell, gseg, PLATE_MM,
// MARGIN_MM, FIT_MM, ITALIC, recompute).
window.Canvas = (function () {
  const SVGNS = "http://www.w3.org/2000/svg";
  const LSP = 1.18;                     // line spacing, matches richtext.go
  const ROT_OFF = 5;                    // rotate handle offset, mm
  const MINSZ = 1.5;                    // min object size on create, mm
  const UNDO_MAX = 60;

  let doc = { v: 1, objects: [] };
  let sel = null;                       // selected object id (single-object transforms)
  let marks = [];                       // shift-click multi-selection (for grouping/move)
  let tool = "select";
  let counter = 0;
  const undo = [], redo = [];
  let suppressSnapshot = false;

  // ---- geometry ----------------------------------------------------------
  function affine(tf) {
    const r = (tf.rot || 0) * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
    const sx = tf.sx == null ? 1 : tf.sx, sy = tf.sy == null ? 1 : tf.sy;
    return { a: sx * co, b: sx * si, c: -sy * si, d: sy * co, e: tf.x, f: tf.y };
  }
  const apply = (m, p) => [m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f];

  // localPaths(o): segs centered on the object's own origin (0,0).
  function localPaths(o) {
    switch (o.type) {
      case "text": return textLocal(o);
      case "rect": return centered(poly([[0, 0], [o.w, 0], [o.w, o.h], [0, o.h]], 1));
      case "ellipse": return ell(0, 0, o.w / 2, o.h / 2);
      case "group": { const out = []; for (const ch of o.children) { const m = affine(ch.tf); for (const s of localPaths(ch)) out.push(mapSeg(s, p => apply(m, p))); } return out; }
      case "freehand": return smoothPath(o.pts || []);
      default: return o.segs || [];      // line/poly/svg/trace: stored centered
    }
  }
  function centered(segs) {
    const b = bounds(segs); if (b.empty) return segs;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    return segs.map(s => mapSeg(s, ([x, y]) => [x - cx, y - cy]));
  }
  // Catmull-Rom through the sample points -> cubic Béziers, so freehand draws
  // and engraves as smooth curves rather than an angular polyline.
  function smoothPath(pts) {
    if (pts.length < 2) return [];
    if (pts.length === 2) return [{ op: "M", p: [pts[0]] }, { op: "L", p: [pts[1]] }];
    const out = [{ op: "M", p: [pts[0]] }];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      out.push({ op: "C", p: [c1, c2, p2] });
    }
    return out;
  }
  // Tight bounds: sample curves instead of taking their control points, so the
  // selection box and snapping wrap rotated and curved geometry exactly.
  const qbez = (a, b, c, t) => { const u = 1 - t; return [u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]]; };
  const cbez = (a, b, c, d, t) => { const u = 1 - t; return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]]; };
  function flatBounds(segs) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, pen = null;
    const acc = (x, y) => { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); };
    for (const s of segs) {
      const p = s.p;
      if (s.op === "M") { pen = p[0]; acc(pen[0], pen[1]); continue; }
      if (s.op === "L") { acc(p[0][0], p[0][1]); pen = p[0]; continue; }
      const e = p[p.length - 1];
      for (let i = 1; i <= 10; i++) { const t = i / 10, q = s.op === "Q" ? qbez(pen, p[0], e, t) : cbez(pen, p[0], p[1], e, t); acc(q[0], q[1]); }
      pen = e;
    }
    if (!isFinite(a)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0, empty: true };
    return { minX: a, minY: b, maxX: c, maxY: d, w: c - a, h: d - b, empty: false };
  }
  function textLocal(o) {
    const cellH = SH.height, asc = SH.ascent, adv = SH.advance, sc = o.sizeMM / cellH;
    const out = [], lines = (o.str || "").split("\n");
    for (let li = 0; li < lines.length; li++) {
      let x = 0; const y = li * o.sizeMM * LSP;
      for (const ch of lines[li]) {
        const g = gseg(ch);
        if (g) for (const s of g) out.push(mapSeg(s, ([px, py]) => {
          let fx = px; if (o.italic) fx += ITALIC * (asc - py);
          return [x + fx * sc, y + py * sc];
        }));
        x += adv * sc;
      }
      if (o.underline && x > 0) { const uy = y + asc * sc + o.sizeMM * 0.1; out.push({ op: "M", p: [[0, uy]] }, { op: "L", p: [[x, uy]] }); }
    }
    return centered(out);
  }
  // local half-extents for handles
  function halfExtent(o) {
    if (o.type === "rect" || o.type === "ellipse") return { hw: o.w / 2, hh: o.h / 2 };
    const b = flatBounds(localPaths(o));
    if (b.empty) return { hw: 1, hh: 1 };
    return { hw: Math.max(b.w / 2, 0), hh: Math.max(b.h / 2, 0) };
  }
  function worldSegs() {
    const out = [];
    for (const o of doc.objects) { const m = affine(o.tf); for (const s of localPaths(o)) out.push(mapSeg(s, p => apply(m, p))); }
    return out;
  }

  // ---- SVG surface -------------------------------------------------------
  let svg, gObjs, gUI;
  function pathD(segs) {
    let d = "";
    for (const s of segs) { const p = s.p;
      if (s.op === "M") d += `M${p[0][0]} ${p[0][1]} `;
      else if (s.op === "L") d += `L${p[0][0]} ${p[0][1]} `;
      else if (s.op === "Q") d += `Q${p[0][0]} ${p[0][1]} ${p[1][0]} ${p[1][1]} `;
      else d += `C${p[0][0]} ${p[0][1]} ${p[1][0]} ${p[1][1]} ${p[2][0]} ${p[2][1]} `;
    }
    return d;
  }
  const mstr = m => `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
  function el(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }

  function render() {
    if (!svg) return;
    gObjs.textContent = "";
    for (const o of doc.objects) {
      const g = el("g", { transform: mstr(affine(o.tf)), "data-id": o.id, class: "cvObj" });
      g.appendChild(el("path", { d: pathD(localPaths(o)), fill: "none", stroke: "var(--engrave)", "stroke-width": 1.4, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round", "stroke-linecap": "round" }));
      gObjs.appendChild(g);
    }
    renderUI();
  }
  function renderUI() {
    gUI.textContent = "";
    if (marks.length > 1) {
      for (const id of marks) { const o = doc.objects.find(x => x.id === id); if (!o) continue; const m = affine(o.tf), { hw, hh } = halfExtent(o), ph = Math.max(hw, 0.6), pv = Math.max(hh, 0.6); const cs = [[-ph, -pv], [ph, -pv], [ph, pv], [-ph, pv]].map(p => apply(m, p)); gUI.appendChild(el("polygon", { points: cs.map(c => c.join(",")).join(" "), class: "cvMark" })); }
      return;
    }
    const o = current(); if (!o) return;
    const m = affine(o.tf), { hw, hh } = halfExtent(o);
    const ph = Math.max(hw, 0.6), pv = Math.max(hh, 0.6);           // pad degenerate boxes
    const corners = [[-ph, -pv], [ph, -pv], [ph, pv], [-ph, pv]].map(p => apply(m, p));
    const mids = [[0, -pv], [ph, 0], [0, pv], [-ph, 0]].map(p => apply(m, p));
    gUI.appendChild(el("polygon", { points: corners.map(c => c.join(",")).join(" "), class: "cvBox" }));
    // rotate handle above the top edge
    const topMid = apply(m, [0, -pv]), ctr = apply(m, [0, 0]);
    let dx = topMid[0] - ctr[0], dy = topMid[1] - ctr[1], L = Math.hypot(dx, dy) || 1;
    const rp = [topMid[0] + dx / L * ROT_OFF, topMid[1] + dy / L * ROT_OFF];
    gUI.appendChild(el("line", { x1: topMid[0], y1: topMid[1], x2: rp[0], y2: rp[1], class: "cvBox" }));
    gUI.appendChild(el("circle", { cx: rp[0], cy: rp[1], r: 1.6, class: "cvRot", "data-h": "rot" }));
    corners.forEach((c, i) => gUI.appendChild(el("rect", { x: c[0] - 1.3, y: c[1] - 1.3, width: 2.6, height: 2.6, class: "cvH", "data-h": "c" + i })));
    mids.forEach((c, i) => gUI.appendChild(el("rect", { x: c[0] - 1.1, y: c[1] - 1.1, width: 2.2, height: 2.2, class: "cvH cvHm", "data-h": "m" + i })));
  }
  const current = () => doc.objects.find(o => o.id === sel) || null;

  function toMM(ev) {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const r = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [r.x, r.y];
  }

  // ---- interaction -------------------------------------------------------
  let drag = null;
  function onDown(ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    svg.setPointerCapture && svg.setPointerCapture(ev.pointerId);
    const p = toMM(ev), h = ev.target.getAttribute && ev.target.getAttribute("data-h");
    if (tool !== "select") { startCreate(tool, p, ev); return; }
    if (h && current()) { startHandle(h, p); return; }
    // hit-test: a direct stroke hit, else the topmost object whose box contains p
    const hitG = ev.target.closest && ev.target.closest(".cvObj");
    const id = hitG ? hitG.getAttribute("data-id") : pickAt(p);
    if (id && ev.shiftKey) { toggleMark(id); return; }
    if (id) { marks = []; select(id); startMove(p); }
    else { marks = []; select(null); }
  }
  function toggleMark(id) {
    const i = marks.indexOf(id);
    if (i >= 0) marks.splice(i, 1); else marks.push(id);
    if (marks.length === 1) { sel = marks[0]; } else if (!marks.length) sel = null;
    renderUI(); syncStyle();
  }
  // pointer p (mm) into an object's local frame, undoing translate/rotate/scale
  function toLocal(o, p) {
    const r = (o.tf.rot || 0) * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
    const x = p[0] - o.tf.x, y = p[1] - o.tf.y;
    return [(co * x + si * y) / (o.tf.sx || 1), (-si * x + co * y) / (o.tf.sy || 1)];
  }
  // topmost object whose (padded) bounding box contains p, or null
  function pickAt(p) {
    for (let i = doc.objects.length - 1; i >= 0; i--) {
      const o = doc.objects[i], lp = toLocal(o, p), { hw, hh } = halfExtent(o);
      const px = Math.max(hw, 1.2), py = Math.max(hh, 1.2);
      if (lp[0] >= -px && lp[0] <= px && lp[1] >= -py && lp[1] <= py) return o.id;
    }
    return null;
  }
  function startMove(p) { const o = current(); drag = { kind: "move", o, start: p, tf0: { ...o.tf } }; }
  function startHandle(h, p) {
    const o = current(), { hw, hh } = halfExtent(o);
    drag = { kind: h === "rot" ? "rot" : "scale", o, start: p, tf0: { ...o.tf }, h, hw, hh, size0: o.sizeMM };
  }
  function startCreate(t, p, ev) {
    if (t === "text") { commitSnapshot(); const o = mkText("Text", p); select(o.id); focusEdit(); recomputeAll(); return; }
    if (t === "poly") { addPolyVertex(p); return; }
    // rect / ellipse / line / pen: drag to size
    drag = { kind: "create", t, start: p, pts: [p] };
  }
  function onMove(ev) {
    if (!drag) return;
    const p = toMM(ev);
    if (drag.kind === "move") { const dx = p[0] - drag.start[0], dy = p[1] - drag.start[1]; drag.o.tf.x = drag.tf0.x + dx; drag.o.tf.y = drag.tf0.y + dy; snapMove(drag.o); liveTransform(drag.o); }
    else if (drag.kind === "rot") { const o = drag.o, ctr = [o.tf.x, o.tf.y]; const ang = Math.atan2(p[1] - ctr[1], p[0] - ctr[0]) * 180 / Math.PI + 90; o.tf.rot = ev.shiftKey ? Math.round(ang / 15) * 15 : ang; liveTransform(o); renderUI(); }
    else if (drag.kind === "scale") { doScale(p, ev.shiftKey); }
    else if (drag.kind === "create") { drag.pts.push(p); previewCreate(); }
  }
  function onUp() {
    if (!drag) { return; }
    gUI.querySelectorAll(".cvSnap").forEach(n => n.remove());
    if (drag.kind === "create") finishCreate();
    else if (drag.kind === "move" || drag.kind === "rot" || drag.kind === "scale") { commitSnapshot(); recomputeAll(); }
    drag = null;
  }
  // snap the object's centre and edges to the margins and the plate centre
  function snapMove(o) {
    gUI.querySelectorAll(".cvSnap").forEach(n => n.remove());
    const T = 1.4, gx = [MARGIN_MM, PLATE_MM / 2, PLATE_MM - MARGIN_MM], he = halfExtent(o);
    const ex = he.hw * Math.abs(o.tf.sx || 1), ey = he.hh * Math.abs(o.tf.sy || 1);
    const ax = [o.tf.x - ex, o.tf.x, o.tf.x + ex], ay = [o.tf.y - ey, o.tf.y, o.tf.y + ey];
    for (const g of gx) { let done = false; for (const a of ax) if (Math.abs(a - g) < T) { o.tf.x += g - a; gUI.appendChild(el("line", { x1: g, y1: 0, x2: g, y2: PLATE_MM, class: "cvSnap" })); done = true; break; } if (done) break; }
    for (const g of gx) { let done = false; for (const a of ay) if (Math.abs(a - g) < T) { o.tf.y += g - a; gUI.appendChild(el("line", { x1: 0, y1: g, x2: PLATE_MM, y2: g, class: "cvSnap" })); done = true; break; } if (done) break; }
  }
  // move/scale/rotate the live SVG group cheaply, defer the heavy preview
  function liveTransform(o) {
    const g = gObjs.querySelector(`[data-id="${o.id}"]`); if (g) g.setAttribute("transform", mstr(affine(o.tf)));
    if (o.type === "text" || o.type === "ellipse" || o.type === "rect") { const gp = g && g.firstChild; if (gp) gp.setAttribute("d", pathD(localPaths(o))); }
    renderUI(); previewDebounced();
  }
  // Resize by dragging a handle. The opposite handle stays fixed (the anchor);
  // shift locks the aspect ratio (and text always does, since stretched glyphs
  // look wrong). Works in the object's rotated frame, so it is correct at any
  // rotation, and negative scale past the anchor mirrors, as expected.
  function doScale(p, uniform) {
    const o = drag.o, r = (drag.tf0.rot || 0) * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
    const hw = drag.hw, hh = drag.hh, m0 = affine(drag.tf0);
    // per handle: the dragged corner's local sign (cx,cy) and which axes it drives
    const H = {
      c0: { cx: -1, cy: -1, ax: 1, ay: 1 }, c1: { cx: 1, cy: -1, ax: 1, ay: 1 }, c2: { cx: 1, cy: 1, ax: 1, ay: 1 }, c3: { cx: -1, cy: 1, ax: 1, ay: 1 },
      m0: { cx: 0, cy: -1, ax: 0, ay: 1 }, m1: { cx: 1, cy: 0, ax: 1, ay: 0 }, m2: { cx: 0, cy: 1, ax: 0, ay: 1 }, m3: { cx: -1, cy: 0, ax: 1, ay: 0 },
    }[drag.h];
    // anchor = the opposite handle, held fixed in world space
    const A = apply(m0, [H.ax ? -H.cx * hw : 0, H.ay ? -H.cy * hh : 0]);
    const dv = [p[0] - A[0], p[1] - A[1]];
    const dux = dv[0] * co + dv[1] * si, duy = -dv[0] * si + dv[1] * co; // project onto local axes
    let sx = H.ax ? (dux * H.cx) / (2 * hw || 1) : (drag.tf0.sx || 1);
    let sy = H.ay ? (duy * H.cy) / (2 * hh || 1) : (drag.tf0.sy || 1);
    const isText = o.type === "text";
    if ((uniform || isText) && H.ax && H.ay) { const f = Math.max(Math.abs(sx), Math.abs(sy)) || 0.01; sx = f * (sx < 0 ? -1 : 1); sy = f * (sy < 0 ? -1 : 1); }
    const place = (hwN, hhN) => {
      const vx = H.ax ? sx * H.cx * hwN : 0, vy = H.ay ? sy * H.cy * hhN : 0;
      o.tf.x = A[0] + co * vx - si * vy; o.tf.y = A[1] + si * vx + co * vy;
    };
    if (isText) {
      const f = Math.max(Math.abs(sx), Math.abs(sy)) || 0.01;
      o.sizeMM = Math.max(0.8, (drag.size0 || o.sizeMM) * f);
      o.tf.sx = sx < 0 ? -1 : 1; o.tf.sy = sy < 0 ? -1 : 1;
      const he = halfExtent(o); place(he.hw, he.hh);
    } else { o.tf.sx = sx || 0.01; o.tf.sy = sy || 0.01; place(hw, hh); }
    liveTransform(o);
  }

  // ---- object creation ---------------------------------------------------
  function nextId() { return "o" + (++counter); }
  function addObject(o) { doc.objects.push(o); return o; }
  function mkText(str, p) { return addObject({ id: nextId(), type: "text", tf: { x: p[0], y: p[1], sx: 1, sy: 1, rot: 0 }, str, sizeMM: 6, italic: false, underline: false }); }
  let polyPts = null;
  function addPolyVertex(p) {
    if (!polyPts) polyPts = [];
    // click near the first vertex closes the polygon
    if (polyPts.length >= 3 && Math.hypot(p[0] - polyPts[0][0], p[1] - polyPts[0][1]) < 2) { finishPoly(true); return; }
    polyPts.push(p); previewPoly();
  }
  function finishPoly(closed) {
    if (polyPts && polyPts.length >= 2) { commitSnapshot(); const segs = centered(poly(polyPts, closed ? 1 : 0)); const c = bounds(poly(polyPts, 0)); addObject({ id: nextId(), type: "polygon", tf: { x: (c.minX + c.maxX) / 2, y: (c.minY + c.maxY) / 2, sx: 1, sy: 1, rot: 0 }, segs }); }
    polyPts = null; gUI.querySelectorAll(".cvTmp").forEach(n => n.remove()); select(null); render(); recomputeAll();
  }
  function previewPoly() {
    gUI.querySelectorAll(".cvTmp").forEach(n => n.remove());
    if (!polyPts || !polyPts.length) return;
    gUI.appendChild(el("polyline", { points: polyPts.map(c => c.join(",")).join(" "), class: "cvTmp", fill: "none" }));
  }
  function previewCreate() {
    gUI.querySelectorAll(".cvTmp").forEach(n => n.remove());
    const a = drag.pts[0], b = drag.pts[drag.pts.length - 1];
    if (drag.t === "line") gUI.appendChild(el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: "cvTmp" }));
    else if (drag.t === "ellipse") gUI.appendChild(el("ellipse", { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, rx: Math.abs(b[0] - a[0]) / 2, ry: Math.abs(b[1] - a[1]) / 2, class: "cvTmp", fill: "none" }));
    else if (drag.t === "pen") gUI.appendChild(el("polyline", { points: drag.pts.map(c => c.join(",")).join(" "), class: "cvTmp", fill: "none" }));
    else gUI.appendChild(el("rect", { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]), class: "cvTmp", fill: "none" }));
  }
  function finishCreate() {
    gUI.querySelectorAll(".cvTmp").forEach(n => n.remove());
    const a = drag.pts[0], b = drag.pts[drag.pts.length - 1], t = drag.t;
    if (t === "pen") {
      const pts = decimate(drag.pts, 0.4); if (pts.length < 2) return;
      commitSnapshot(); const c = bounds(poly(pts, 0)), cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
      const local = pts.map(([x, y]) => [x - cx, y - cy]);
      // raw samples kept so the detail knob can re-smooth from the original.
      addObject({ id: nextId(), type: "freehand", tf: { x: cx, y: cy, sx: 1, sy: 1, rot: 0 }, pts: local, rawPts: local.map(p => p.slice()), eps: 0 });
    } else {
      const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]), cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
      if (t === "line") { if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MINSZ) return; commitSnapshot(); addObject({ id: nextId(), type: "line", tf: { x: cx, y: cy, sx: 1, sy: 1, rot: 0 }, segs: centered([{ op: "M", p: [a] }, { op: "L", p: [b] }]) }); }
      else { if (w < MINSZ && h < MINSZ) return; commitSnapshot(); addObject({ id: nextId(), type: t, tf: { x: cx, y: cy, sx: 1, sy: 1, rot: 0 }, w: Math.max(w, MINSZ), h: Math.max(h, MINSZ) }); }
    }
    // Drawing tools stay active so you can keep drawing; press V or Escape to
    // switch to Select and move or resize what you drew.
    select(null);
    render(); recomputeAll();
  }

  // ---- insert SVG / image ------------------------------------------------
  function insertSVG(text) {
    let segs; try { segs = extractSVG(text); } catch (e) { setStatus("SVG: " + (e.message || e)); return; }
    const b = bounds(segs); if (b.empty) return;
    const sc = Math.max(b.w, b.h) > 0 ? FIT_MM / Math.max(b.w, b.h) : 1;
    const scaled = segs.map(s => mapSeg(s, ([x, y]) => [x * sc, y * sc]));
    commitSnapshot(); addObject({ id: nextId(), type: "svg", tf: { x: PLATE_MM / 2, y: PLATE_MM / 2, sx: 1, sy: 1, rot: 0 }, segs: centered(scaled), eps: 0, raw: centered(scaled) });
    const o = doc.objects[doc.objects.length - 1]; select(o.id); setTool("select"); render(); recomputeAll();
  }
  function insertTrace(segs) {
    const b = bounds(segs); if (b.empty) { setStatus("Trace found nothing"); return; }
    const sc = Math.max(b.w, b.h) > 0 ? FIT_MM / Math.max(b.w, b.h) : 1;
    const scaled = centered(segs.map(s => mapSeg(s, ([x, y]) => [x * sc, y * sc])));
    commitSnapshot(); addObject({ id: nextId(), type: "trace", tf: { x: PLATE_MM / 2, y: PLATE_MM / 2, sx: 1, sy: 1, rot: 0 }, segs: scaled, raw: scaled, eps: 0 });
    const o = doc.objects[doc.objects.length - 1]; select(o.id); setTool("select"); render(); recomputeAll();
  }

  // ---- selection + style toolbar -----------------------------------------
  function select(id) { sel = id; renderUI(); syncStyle(); }
  function setTool(t) { tool = t; document.querySelectorAll("#cvTools [data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === t)); if (t !== "poly" && polyPts) finishPoly(false); svg && (svg.style.cursor = t === "select" ? "default" : "crosshair"); }
  function syncStyle() {
    const bar = document.getElementById("cvStyle"), o = current(), showGroup = marks.length >= 2;
    bar.hidden = !o && !showGroup;
    const gb = document.getElementById("cvGroup"), ub = document.getElementById("cvUngroup");
    if (gb) gb.hidden = !showGroup;
    if (ub) ub.hidden = !(o && o.type === "group");
    if (!o) { document.getElementById("cvStyleText").hidden = true; document.getElementById("cvStyleShape").hidden = true; return; }
    const isText = o.type === "text", canSimplify = o.type === "svg" || o.type === "trace" || o.type === "freehand";
    document.getElementById("cvStyleText").hidden = !isText;
    document.getElementById("cvStyleShape").hidden = !canSimplify;
    if (isText) { document.getElementById("cvSize").value = o.sizeMM.toFixed(1); document.getElementById("cvEdit").value = o.str; growEdit(); document.getElementById("cvItalic").classList.toggle("on", o.italic); document.getElementById("cvUnder").classList.toggle("on", o.underline); }
    if (canSimplify) document.getElementById("cvDetail").value = o.eps ? Math.min(100, o.eps * 100) : 0;
  }
  // A text field holds multiple lines: the editor is a textarea and its
  // height tracks the content, so it stays one line until Enter adds more.
  function growEdit() { const f = document.getElementById("cvEdit"); if (!f) return; f.style.height = "auto"; f.style.height = Math.min(f.scrollHeight, 160) + "px"; }
  function focusEdit() { const f = document.getElementById("cvEdit"); if (f) { f.focus(); f.select(); } }

  // ---- edits -------------------------------------------------------------
  function withObj(fn) { const o = current(); if (!o) return; commitSnapshot(); fn(o); render(); recomputeAll(); }
  function del() { withObj(o => { doc.objects = doc.objects.filter(x => x.id !== o.id); sel = null; }); syncStyle(); }
  function clearAll() { if (!doc.objects.length) return; commitSnapshot(); doc.objects = []; marks = []; sel = null; render(); syncStyle(); recomputeAll(); setStatus("Canvas cleared — undo to restore"); }
  function dup() { const o = current(); if (!o) return; commitSnapshot(); const n = JSON.parse(JSON.stringify(o)); n.id = nextId(); n.tf.x += 4; n.tf.y += 4; doc.objects.push(n); select(n.id); render(); recomputeAll(); }
  function raise(dir) { const i = doc.objects.findIndex(o => o.id === sel); if (i < 0) return; const j = i + dir; if (j < 0 || j >= doc.objects.length) return; commitSnapshot(); const a = doc.objects; [a[i], a[j]] = [a[j], a[i]]; render(); recomputeAll(); }
  function flip(axis) { withObj(o => { if (axis === "h") o.tf.sx *= -1; else o.tf.sy *= -1; }); }

  // ---- grouping ----------------------------------------------------------
  function group() {
    if (marks.length < 2) return;
    const objs = marks.map(id => doc.objects.find(o => o.id === id)).filter(Boolean);
    if (objs.length < 2) return;
    commitSnapshot();
    const all = [];
    for (const o of objs) { const m = affine(o.tf); for (const s of localPaths(o)) all.push(mapSeg(s, p => apply(m, p))); }
    const b = bounds(all), cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const children = objs.map(o => { const c = JSON.parse(JSON.stringify(o)); c.tf.x -= cx; c.tf.y -= cy; return c; });
    const ids = new Set(marks); doc.objects = doc.objects.filter(o => !ids.has(o.id));
    const g = { id: nextId(), type: "group", tf: { x: cx, y: cy, sx: 1, sy: 1, rot: 0 }, children };
    doc.objects.push(g); marks = []; select(g.id); render(); recomputeAll();
  }
  function ungroup() {
    const g = current(); if (!g || g.type !== "group") return;
    commitSnapshot();
    const gm = affine(g.tf), i = doc.objects.findIndex(o => o.id === g.id);
    const kids = g.children.map(ch => {
      const c = JSON.parse(JSON.stringify(ch)); c.id = nextId();
      const wp = apply(gm, [ch.tf.x, ch.tf.y]);
      c.tf.x = wp[0]; c.tf.y = wp[1];
      c.tf.rot = (g.tf.rot || 0) + (ch.tf.rot || 0);
      c.tf.sx = (g.tf.sx || 1) * (ch.tf.sx || 1); c.tf.sy = (g.tf.sy || 1) * (ch.tf.sy || 1);
      return c;
    });
    doc.objects.splice(i, 1, ...kids); marks = []; sel = kids.length ? kids[kids.length - 1].id : null;
    render(); syncStyle(); recomputeAll();
  }

  // ---- in-place text editing ---------------------------------------------
  function onDbl(ev) {
    const id = pickAt(toMM(ev)); if (!id) return;
    const o = doc.objects.find(x => x.id === id); if (!o || o.type !== "text") return;
    marks = []; select(id); openInline(o);
  }
  function openInline(o) {
    const stage = svg.parentElement; stage.style.position = "relative";
    const box = svg.getBoundingClientRect(), sx = box.width / PLATE_MM, sy = box.height / PLATE_MM;
    const c = apply(affine(o.tf), [0, 0]);
    const ta = document.createElement("textarea"); ta.className = "cvInline"; ta.value = o.str;
    ta.style.left = Math.max(2, c[0] * sx - 70) + "px"; ta.style.top = Math.max(2, c[1] * sy - 16) + "px";
    stage.appendChild(ta); ta.focus(); ta.select();
    const commit = () => { if (ta.parentNode) ta.remove(); commitSnapshot(); render(); recomputeAll(); };
    ta.oninput = () => { o.str = ta.value; render(); recomputeAll(); };
    ta.onblur = commit;
    ta.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ta.blur(); } if (e.key === "Escape") ta.blur(); };
  }

  // ---- simplify + auto-fit -----------------------------------------------
  function rdp(points, eps) {
    if (points.length < 3) return points;
    let dmax = 0, idx = 0; const a = points[0], b = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) { const d = segDist(points[i], a, b); if (d > dmax) { dmax = d; idx = i; } }
    if (dmax > eps) { const l = rdp(points.slice(0, idx + 1), eps), r = rdp(points.slice(idx), eps); return l.slice(0, -1).concat(r); }
    return [a, b];
  }
  function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; if (!L) return Math.hypot(p[0] - a[0], p[1] - a[1]); let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)); }
  // simplify a segs array (M/L runs) by RDP per subpath; curve segs pass through
  function simplifySegs(segs, eps) {
    if (!eps) return segs;
    const out = []; let run = null;
    const flush = () => { if (run && run.length > 1) { const r = rdp(run, eps); out.push({ op: "M", p: [r[0]] }); for (let i = 1; i < r.length; i++) out.push({ op: "L", p: [r[i]] }); } else if (run && run.length === 1) out.push({ op: "M", p: [run[0]] }); run = null; };
    for (const s of segs) {
      if (s.op === "M") { flush(); run = [s.p[0]]; }
      else if (s.op === "L" && run) run.push(s.p[0]);
      else { flush(); out.push(s); }
    }
    flush(); return out;
  }
  function setDetail(pct) { withObj(o => { o.eps = pct / 100; if (o.type === "freehand") o.pts = o.eps > 0 ? rdp(o.rawPts || o.pts, o.eps) : (o.rawPts || o.pts); else o.segs = simplifySegs(o.raw || o.segs, o.eps); }); }
  function decimate(pts, min) { const out = [pts[0]]; for (const p of pts) { const q = out[out.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= min) out.push(p); } return out; }
  function autoFit() {
    // bisect a global simplify epsilon on graphics objects until under caps
    const heavy = doc.objects.filter(o => o.raw);
    if (!heavy.length) { setStatus("Nothing to simplify"); return; }
    commitSnapshot();
    let lo = 0, hi = 4;
    for (let it = 0; it < 16; it++) {
      const eps = (lo + hi) / 2;
      heavy.forEach(o => { o.eps = eps; o.segs = simplifySegs(o.raw, eps); });
      const segs = worldSegs(), strokes = segs.filter(s => s.op === "M").length, bytes = encodePath(segs).length;
      if (strokes > SH.maxStrokes || bytes > SH.payloadCap) lo = eps; else hi = eps;
    }
    heavy.forEach(o => { o.eps = hi; o.segs = simplifySegs(o.raw, hi); });
    render(); recomputeAll(); syncStyle(); setStatus(`Auto-fit at ε=${hi.toFixed(2)}mm`);
  }

  // ---- undo / persistence ------------------------------------------------
  function snap() { return JSON.stringify(doc); }
  function commitSnapshot() { if (suppressSnapshot) return; undo.push(snap()); if (undo.length > UNDO_MAX) undo.shift(); redo.length = 0; }
  function doUndo() { if (!undo.length) return; redo.push(snap()); doc = JSON.parse(undo.pop()); afterRestore(); }
  function doRedo() { if (!redo.length) return; undo.push(snap()); doc = JSON.parse(redo.pop()); afterRestore(); }
  function afterRestore() { counter = doc.objects.reduce((m, o) => Math.max(m, +(o.id.slice(1)) || 0), 0); if (!doc.objects.find(o => o.id === sel)) sel = null; render(); syncStyle(); recomputeAll(); }
  let saveT = null;
  function persist() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem("shstudio.canvas", snap()); } catch (e) {} }, 400); }

  async function shareURL() {
    const json = snap();
    let hash;
    if (window.CompressionStream) {
      const cs = new CompressionStream("deflate-raw"), w = cs.writable.getWriter();
      w.write(new TextEncoder().encode(json)); w.close();
      const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
      hash = "z" + b64url(buf);
    } else hash = "j" + b64url(new TextEncoder().encode(json));
    location.hash = "canvas=" + hash;
    navigator.clipboard && navigator.clipboard.writeText(location.href).then(() => setStatus("Share link copied ✓"), () => {});
  }
  async function fromHash() {
    const m = /canvas=([zj])([A-Za-z0-9\-_]+)/.exec(location.hash); if (!m) return false;
    try {
      let bytes = ub64url(m[2]);
      if (m[1] === "z" && window.DecompressionStream) { const ds = new DecompressionStream("deflate-raw"), w = ds.writable.getWriter(); w.write(bytes); w.close(); bytes = new Uint8Array(await new Response(ds.readable).arrayBuffer()); }
      doc = JSON.parse(new TextDecoder().decode(bytes)); return true;
    } catch (e) { return false; }
  }
  function b64url(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function ub64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

  // ---- preview / gauge bridge --------------------------------------------
  let previewT = null;
  function previewDebounced() { clearTimeout(previewT); previewT = setTimeout(recomputeAll, 60); }
  function recomputeAll() { persist(); if (typeof recompute === "function" && mode() === "canvas") recompute(); }
  function mode() { const t = document.querySelector("[role=tab][aria-selected=true]"); return t ? t.dataset.mode : ""; }
  function setStatus(m) { const s = document.getElementById("status"); if (s) s.textContent = m; }

  // ---- keyboard ----------------------------------------------------------
  function onKey(e) {
    if (mode() !== "canvas") return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") { e.preventDefault(); e.shiftKey ? ungroup() : group(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { if (current()) { e.preventDefault(); del(); } return; }
    const step = e.shiftKey ? 5 : 1;
    if (current() && e.key.startsWith("Arrow")) { e.preventDefault(); commitSnapshot(); const o = current(); if (e.key === "ArrowLeft") o.tf.x -= step; if (e.key === "ArrowRight") o.tf.x += step; if (e.key === "ArrowUp") o.tf.y -= step; if (e.key === "ArrowDown") o.tf.y += step; render(); recomputeAll(); return; }
    const keys = { v: "select", t: "text", r: "rect", o: "ellipse", l: "line", p: "pen", g: "poly" };
    if (keys[e.key.toLowerCase()]) setTool(keys[e.key.toLowerCase()]);
    if (e.key === "Enter" && polyPts) finishPoly(polyPts.length >= 3);
    if (e.key === "Escape") { polyPts = null; gUI.querySelectorAll(".cvTmp").forEach(n => n.remove()); select(null); setTool("select"); }
  }

  // ---- boot --------------------------------------------------------------
  async function init() {
    svg = document.getElementById("cv"); if (!svg) return;
    gObjs = document.getElementById("cvObjs"); gUI = document.getElementById("cvUI");
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("dblclick", onDbl);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    document.querySelectorAll("#cvTools [data-tool]").forEach(b => b.onclick = () => setTool(b.dataset.tool));
    // toolbar buttons
    const on = (id, fn) => { const e = document.getElementById(id); if (e) e.onclick = fn; };
    on("cvUndo", doUndo); on("cvRedo", doRedo);
    on("cvDel", del); on("cvDup", dup); on("cvFwd", () => raise(1)); on("cvBack", () => raise(-1));
    on("cvFlipH", () => flip("h")); on("cvFlipV", () => flip("v"));
    on("cvGroup", group); on("cvUngroup", ungroup);
    on("cvItalic", () => withObj(o => o.italic = !o.italic) || syncStyle());
    on("cvUnder", () => withObj(o => o.underline = !o.underline) || syncStyle());
    on("cvAutoFit", autoFit); on("cvShare", shareURL); on("cvClear", clearAll);
    const sz = document.getElementById("cvSize"); if (sz) sz.oninput = () => withObj(o => o.sizeMM = Math.max(0.8, parseFloat(sz.value) || o.sizeMM));
    const ed = document.getElementById("cvEdit"); if (ed) ed.oninput = () => { growEdit(); const o = current(); if (o) { o.str = ed.value; render(); recomputeAll(); } };
    if (ed) ed.onchange = commitSnapshot;
    const det = document.getElementById("cvDetail"); if (det) det.oninput = () => setDetail(parseFloat(det.value));
    on("cvSvg", () => document.getElementById("cvSvgFile").click());
    on("cvImg", () => document.getElementById("cvImgFile").click());
    const sf = document.getElementById("cvSvgFile"); if (sf) sf.onchange = e => { const f = e.target.files[0]; if (f) f.text().then(insertSVG); e.target.value = ""; };
    const imf = document.getElementById("cvImgFile"); if (imf) imf.onchange = e => { const f = e.target.files[0]; if (f) traceFile(f); e.target.value = ""; };
    // restore: hash beats localStorage
    if (!(await fromHash())) { try { const s = localStorage.getItem("shstudio.canvas"); if (s) doc = JSON.parse(s); } catch (e) {} }
    counter = doc.objects.reduce((m, o) => Math.max(m, +(o.id.slice(1)) || 0), 0);
    setTool("select"); render();
  }

  // ---- image tracer (see tracer.js) --------------------------------------
  function traceFile(f) {
    if (!window.Tracer) { setStatus("Tracer unavailable"); return; }
    const modeSel = document.getElementById("cvTraceMode");
    setStatus("Tracing…");
    window.Tracer.trace(f, { mode: modeSel ? modeSel.value : "centerline", detail: 1 })
      .then(segs => insertTrace(segs)).catch(e => setStatus("Trace: " + (e.message || e)));
  }

  return { init, worldSegs, segs: worldSegs, refresh: () => { render(); syncStyle(); recomputeAll(); }, insertSVG, insertTrace, _doc: () => doc };
})();
document.addEventListener("DOMContentLoaded", () => window.Canvas.init());
