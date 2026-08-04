// vectorizePlate renders a planned engraving spline to an SVG that resembles
// the engraved steel plate: the 85 mm plate with rounded corners, the safety
// keepout, and the engraved strokes at the needle width. It is the curves-era
// replacement for the retired combined sim's internal/golden.VectorizePlate —
// inlined here (operating on the public bspline.Curve) because the emulator is
// its own module and Go's internal rule bars it from importing
// seedhammer.com/internal/golden. Host-testable: no js build constraint.

package main

import (
	"bufio"
	"bytes"
	"fmt"

	"seedhammer.com/bspline"
	"seedhammer.com/engrave"
)

func vectorizePlate(spline bspline.Curve, params engrave.Params, wMM, hMM int) []byte {
	stroke := params.StrokeWidth
	// Plate dimensions in machine units (the spline's space).
	side := params.F(float32(wMM))
	height := params.F(float32(hMM))
	corner := params.F(3)
	inset := params.F(3) // the 3 mm safety keepout

	var b bytes.Buffer
	out := bufio.NewWriter(&b)
	fmt.Fprintf(out, `<svg xmlns="http://www.w3.org/2000/svg" width="%dmm" height="%dmm" viewBox="0 0 %d %d" preserveAspectRatio="xMidYMid meet">`+"\n", wMM, hMM, side, height)
	// CSS-var driven so the host page can theme it; the fallbacks render a
	// light steel plate with dark engraving on their own.
	fmt.Fprintf(out, `<defs><style>
.plate  { fill: var(--plate-fill,#e9e9ec); stroke: var(--plate-stroke,#b3b3ba); stroke-width: %d; }
.safe   { fill: none; stroke: var(--safe-stroke,#cfcfd6); stroke-width: %d; stroke-dasharray: %d %d; }
.spline { fill: none; stroke: var(--spline-stroke,#16181d); stroke-width: %d; stroke-linejoin: round; stroke-linecap: round; }
</style></defs>`+"\n", stroke, stroke, stroke*4, stroke*4, stroke)
	fmt.Fprintf(out, `<rect class="plate" x="0" y="0" width="%d" height="%d" rx="%d" ry="%d"/>`+"\n", side, height, corner, corner)
	fmt.Fprintf(out, `<rect class="safe" x="%d" y="%d" width="%d" height="%d"/>`+"\n", inset, inset, side-2*inset, height-2*inset)

	fmt.Fprint(out, `<path class="spline" d="`)
	var seg bspline.Segment
	first := true
	for k := range spline {
		c, dt, engraved := seg.Knot(k)
		if dt == 0 {
			continue
		}
		if engraved {
			if first {
				first = false
				fmt.Fprintf(out, " M %d %d", c.C0.X, c.C0.Y)
			}
			fmt.Fprintf(out, " C %d %d, %d %d, %d %d", c.C1.X, c.C1.Y, c.C2.X, c.C2.Y, c.C3.X, c.C3.Y)
		} else {
			// A travel move: lift and reposition to the next stroke's start.
			first = true
			fmt.Fprintf(out, " M %d %d", c.C3.X, c.C3.Y)
		}
	}
	fmt.Fprintln(out, `"/>`)
	fmt.Fprintln(out, "</svg>")
	out.Flush()
	return b.Bytes()
}
