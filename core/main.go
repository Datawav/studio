// Command studiocore exposes the firmware's curves cost model to the Studio
// editor as WebAssembly. The editor computes strokes and payload bytes in JS
// exactly, but the knot caps and the engraving time need the real planner:
// this compiles seedhammer.com/curves (Parse + Validate, the same gate the
// firmware's toPlate uses) to GOOS=js and exports studioCoreReport(payload),
// so the canvas gauges show firmware-exact numbers instead of a flat estimate.
//
//go:build js && wasm

package main

import (
	"encoding/json"
	"math"
	"syscall/js"

	"seedhammer.com/bezier"
	"seedhammer.com/bspline"
	"seedhammer.com/curves"
	"seedhammer.com/engrave"
	"seedhammer.com/svgpath"
)

// The SH2 engraver parameters, mirroring cmd/svgplate/emit.go and
// cmd/controller/platform_sh2.go. A payload is measured against these so the
// gauge matches exactly what the device would accept.
const deviceMM = 200 / 8 * 256 // 6400 machine units per millimeter.

var sh2 = engrave.Params{
	StrokeWidth: int(0.3 * deviceMM),
	Millimeter:  deviceMM,
	StepperConfig: engrave.StepperConfig{
		TicksPerSecond: 30 * deviceMM,
		Speed:          30 * deviceMM,
		EngravingSpeed: 8 * deviceMM,
		Acceleration:   250 * deviceMM,
		Jerk:           2600 * deviceMM,
	},
}

// report parses a curves path payload and returns its cost against the caps.
// The result object mirrors curves.Report plus the caps and the first cap the
// payload violates ("" if it fits), so the editor can render every gauge next
// to its limit with the firmware's own numbers.
func report(this js.Value, args []js.Value) any {
	res := map[string]any{
		"maxStrokes":     curves.MaxStrokes,
		"maxKnots":       curves.MaxKnots,
		"maxStrokeKnots": curves.MaxStrokeKnots,
		"maxSeconds":     curves.MaxMinutes * 60,
	}
	if len(args) < 1 {
		res["error"] = "no payload"
		return js.ValueOf(res)
	}
	d, err := curves.Parse(argBytes(args[0]), sh2)
	if err != nil {
		res["error"] = err.Error()
		return js.ValueOf(res)
	}
	r, verr := d.Validate(sh2)
	res["strokes"] = r.Strokes
	res["knots"] = r.Knots
	res["strokeKnots"] = r.MaxStrokeKnots
	res["seconds"] = r.Seconds
	res["bytes"] = r.Bytes
	if verr != nil {
		res["error"] = verr.Error()
	} else {
		res["error"] = ""
	}
	res["plan"] = planJSON(d)
	return js.ValueOf(res)
}

// planJSON returns the geometry the device actually engraves: the planner's
// spline sampled to polylines, excluding travel (pen-up) moves, as a JSON
// array of strokes ([[[x,y],...],...]) in millimetres. It mirrors the sampling
// in cmd/svgplate/preview.go, so the editor preview can show the real cut path
// (corner clamps, seam-free loops, resampling) instead of the raw input paths.
func planJSON(d *curves.Drawing) string {
	mm := float64(sh2.Millimeter)
	var strokes [][][2]float64
	var cur [][2]float64
	var seg bspline.Segment
	var samples []bezier.Point
	flush := func() {
		if len(cur) > 1 {
			strokes = append(strokes, cur)
		}
		cur = nil
	}
	for k := range engrave.PlanEngraving(sh2.StepperConfig, d.Engraving()) {
		c, dt, engraved := seg.Knot(k)
		if dt == 0 {
			continue
		}
		if !engraved { // a travel move breaks the stroke
			flush()
			continue
		}
		samples = append(samples[:0], c.C0)
		samples = bezier.Sample(samples, c, sh2.StrokeWidth/3)
		for _, p := range samples {
			cur = append(cur, [2]float64{float64(p.X) / mm, float64(p.Y) / mm})
		}
	}
	flush()
	b, err := json.Marshal(strokes)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// The v2 wire quantization, matching cmd/svgplate/emit.go: 0.1mm units
// (below the needle and the planner's sampling) and a 0.3mm needle.
const (
	encodeUPMM   = 10
	encodeStroke = 3
)

// encode turns a drawing into a version 2 binary curves payload. It takes
// an ASCII M/L/Q/C path in millimetres (the editor's world units), so the
// same round-to-0.1mm, stroke ordering and binary encoding the host
// converter uses run here through the shared curves package — the payload
// is byte-identical to what cmd/svgplate would emit for the same geometry.
// It returns {payload: Uint8Array} or {error: string}.
func encode(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return js.ValueOf(map[string]any{"error": "no path"})
	}
	scale := func(v float64) int { return int(math.Round(v * encodeUPMM)) }
	it := svgpath.NewIter(args[0].String(), 0, 0, scale)
	var segs []svgpath.Segment
	for {
		s, ok := it.Next()
		if !ok {
			break
		}
		segs = append(segs, s)
	}
	if err := it.Err(); err != nil {
		return js.ValueOf(map[string]any{"error": err.Error()})
	}
	segs = curves.Order(segs)
	payload, err := curves.EncodePath(encodeUPMM, encodeStroke, segs)
	if err != nil {
		return js.ValueOf(map[string]any{"error": err.Error()})
	}
	arr := js.Global().Get("Uint8Array").New(len(payload))
	js.CopyBytesToJS(arr, payload)
	return js.ValueOf(map[string]any{"payload": arr, "error": ""})
}

// argBytes reads a JS payload argument, whether a string (a text payload
// or a v1 ASCII path) or a Uint8Array (a v2 binary path).
func argBytes(arg js.Value) []byte {
	if arg.Type() == js.TypeString {
		return []byte(arg.String())
	}
	b := make([]byte, arg.Get("length").Int())
	js.CopyBytesToGo(b, arg)
	return b
}

func main() {
	js.Global().Set("studioCoreReport", js.FuncOf(report))
	js.Global().Set("studioCoreEncode", js.FuncOf(encode))
	js.Global().Set("studioCoreReady", js.ValueOf(true))
	if cb := js.Global().Get("studioCoreOnReady"); cb.Type() == js.TypeFunction {
		cb.Invoke()
	}
	select {} // keep the instance alive so the exported callback stays valid
}
