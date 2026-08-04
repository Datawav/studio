package main

import (
	"strings"
	"testing"

	"seedhammer.com/curves"
	"seedhammer.com/engrave"
)

// TestVectorizePlate drives a real planned spline (the square path payload,
// planned exactly as the gui would) through the vectorizer and checks the SVG
// carries the plate frame, the safety keepout, and an engraved path with
// actual curve geometry — not just an empty frame.
func TestVectorizePlate(t *testing.T) {
	d, err := curves.Parse(pathPayloadBytes(t), gateParams)
	if err != nil {
		t.Fatalf("curves.Parse: %v", err)
	}
	spline := engrave.PlanEngraving(gateParams.StepperConfig, d.Engraving())
	svg := string(vectorizePlate(spline, gateParams, 85, 85))

	for _, want := range []string{`<svg`, `width="85mm"`, `height="85mm"`, `class="plate"`, `class="safe"`, `class="spline"`, `</svg>`} {
		if !strings.Contains(svg, want) {
			t.Errorf("SVG missing %q", want)
		}
	}
	// The engraved path must contain real geometry, not just the plate rects.
	if !strings.Contains(svg, " M ") || !strings.Contains(svg, " C ") {
		t.Errorf("SVG spline path has no move/curve commands:\n%s", svg)
	}

	// The small plate renders its own frame from the same spline space.
	small := string(vectorizePlate(spline, gateParams, 85, 55))
	for _, want := range []string{`width="85mm"`, `height="55mm"`} {
		if !strings.Contains(small, want) {
			t.Errorf("small-plate SVG missing %q", want)
		}
	}
}
