package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"flag"
	"io"
	"os"
	"path/filepath"
	"testing"

	"seedhammer.com/bezier"
	"seedhammer.com/curves"
	"seedhammer.com/engrave"
	"seedhammer.com/svgpath"
)

// gateParams mirrors the emulator's engraverParams (platform.go, js-tagged
// and so invisible here) closely enough to exercise the curves planner: the
// editor emits a "1 path 100 30" header, and the stroke-width check in
// curves.Parse only passes when Millimeter/StrokeWidth match that 100 units/mm,
// 30-unit-wide stroke — i.e. 6400 machine units/mm and a 0.3 mm needle.
const gateMM = 6400

var gateParams = engrave.Params{
	StrokeWidth: 0.3 * gateMM,
	Millimeter:  gateMM,
	StepperConfig: engrave.StepperConfig{
		TicksPerSecond: 30 * gateMM,
		Speed:          30 * gateMM,
		EngravingSpeed: 8 * gateMM,
		Acceleration:   250 * gateMM,
		Jerk:           2600 * gateMM,
	},
}

// buildCurvesTap wraps a curves payload the way the Studio host does before
// handing it to seedhammerSynthTap: a single NDEF external record of type
// "seedhammer.com:curves", inside an NDEF-message TLV (0x03 len … 0xFE). This
// is the reference implementation; nfc-bus.js reproduces it byte-for-byte
// (guarded by the node parity check and the ndeflib cross-check), so the emu
// sees exactly what the bench-proven bridge writes to a tag.
func buildCurvesTap(payload []byte) []byte {
	typ := []byte(curves.RecordType) // "seedhammer.com:curves"
	var rec []byte
	if len(payload) < 256 {
		// Short record: MB|ME|SR|TNF-external, 1-byte payload length.
		rec = append(rec, 0x80|0x40|0x10|0x04, byte(len(typ)), byte(len(payload)))
	} else {
		// Long record: MB|ME|TNF-external, 4-byte payload length.
		rec = append(rec, 0x80|0x40|0x04, byte(len(typ)))
		rec = binary.BigEndian.AppendUint32(rec, uint32(len(payload)))
	}
	rec = append(rec, typ...)
	rec = append(rec, payload...)

	var tlv []byte
	if len(rec) < 255 {
		tlv = append(tlv, 0x03, byte(len(rec)))
	} else {
		tlv = append(tlv, 0x03, 0xFF)
		tlv = binary.BigEndian.AppendUint16(tlv, uint16(len(rec)))
	}
	tlv = append(tlv, rec...)
	tlv = append(tlv, 0xFE)
	return tlv
}

// A path payload the editor's emit() would produce for a square drawn
// inside the plate (10 mm … 75 mm), coordinates quantized at 100 units/mm.
const textPayload = "2 text\nIN CASE OF EMERGENCY\nBREAK GLASS"

// pathPayloadBytes builds the reference v2 path payload — the same
// 10-75mm square outline the v1 fixture carried — through the same
// encoder the editor and the host converter use, so the fixture can
// never drift from the wire format.
func pathPayloadBytes(t testing.TB) []byte {
	t.Helper()
	pt := func(x, y int) bezier.Point { return bezier.Pt(x, y) }
	segs := []svgpath.Segment{
		{Op: svgpath.MoveTo, Args: [4]bezier.Point{pt(100, 100)}},
		{Op: svgpath.LineTo, Args: [4]bezier.Point{pt(750, 100)}},
		{Op: svgpath.LineTo, Args: [4]bezier.Point{pt(750, 750)}},
		{Op: svgpath.LineTo, Args: [4]bezier.Point{pt(100, 750)}},
		{Op: svgpath.LineTo, Args: [4]bezier.Point{pt(100, 100)}},
	}
	payload, err := curves.EncodePath(10, 3, segs)
	if err != nil {
		t.Fatalf("EncodePath: %v", err)
	}
	return payload
}

// TestCurvesTapRecognized is the correctness gate the whole hub hinges on:
// a curves tap must be *recognized as curves* by the emulator's reader, not
// fall through to the content sniffer. It drives the exact reader the emu
// hands gui (ndefReader over nfcReader), asserts the record type dispatches,
// the payload round-trips, and the curves planner accepts it within caps.
func TestCurvesTapRecognized(t *testing.T) {
	tap := buildCurvesTap(pathPayloadBytes(t))

	nr := newNFCReader()
	nr.tap(tap)
	r := &ndefReader{nfc: nr}

	got, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read tap: %v", err)
	}
	// The recordTyper contract gui/scan.go relies on. Without ndefReader
	// exposing this, a curves tap is rejected as "Unknown format".
	if rt := string(r.RecordType()); rt != curves.RecordType {
		t.Fatalf("record type = %q, want %q", rt, curves.RecordType)
	}
	if !bytes.Equal(got, pathPayloadBytes(t)) {
		t.Fatalf("payload round-trip mismatch: %d bytes", len(got))
	}

	// The scan funnel would now hand these bytes to the curves planner.
	d, err := curves.Parse(got, gateParams)
	if err != nil {
		t.Fatalf("curves.Parse: %v", err)
	}
	rep, err := d.Validate(gateParams)
	if err != nil {
		t.Fatalf("curves.Validate: %v", err)
	}
	if d.Strokes == 0 || d.Knots == 0 {
		t.Fatalf("planned an empty drawing: %+v", d)
	}
	// The structural caps retired firmware-side; the duration cap is
	// the complexity gate.
	if rep.Seconds > curves.MaxMinutes*60 {
		t.Fatalf("drawing exceeds the duration cap: %+v", rep)
	}
	t.Logf("planned: strokes=%d knots=%d report=%+v", d.Strokes, d.Knots, rep)
}

// TestTextTapRoundTrips proves the text-mode payload also survives the wrap:
// text records go through the same curves external record (the editor sends
// SH.recordType for both modes), and the firmware's Text() reads the body.
func TestTextTapRoundTrips(t *testing.T) {
	tap := buildCurvesTap([]byte(textPayload))
	nr := newNFCReader()
	nr.tap(tap)
	r := &ndefReader{nfc: nr}

	got, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read tap: %v", err)
	}
	if rt := string(r.RecordType()); rt != curves.RecordType {
		t.Fatalf("record type = %q, want %q", rt, curves.RecordType)
	}
	if mode, err := curves.Mode(got); err != nil || mode != curves.ModeText {
		t.Fatalf("mode = %q, %v; want text", mode, err)
	}
	body, err := curves.Text(got)
	if err != nil {
		t.Fatalf("curves.Text: %v", err)
	}
	if body != "IN CASE OF EMERGENCY\nBREAK GLASS" {
		t.Fatalf("text body = %q", body)
	}
}

// TestLongCurvesTap exercises the >255-byte payload path: a long NDEF record
// (SR clear, 4-byte payload length) inside a long message TLV (0xFF-escaped
// 2-byte length). The Studio Rich tab produces payloads in the tens of KB, so
// this size is the common case, not an edge one.
func TestLongCurvesTap(t *testing.T) {
	pt := func(x, y int) bezier.Point { return bezier.Pt(x, y) }
	segs := []svgpath.Segment{{Op: svgpath.MoveTo, Args: [4]bezier.Point{pt(100, 100)}}}
	for i := 0; i < 400; i++ { // ~400 line segments → several KB, well past 255
		segs = append(segs, svgpath.Segment{Op: svgpath.LineTo, Args: [4]bezier.Point{pt(100+(i%50)*10, 100+(i%40)*10)}})
	}
	payload, err := curves.EncodePath(10, 3, segs)
	if err != nil {
		t.Fatalf("EncodePath: %v", err)
	}
	if len(payload) < 256 {
		t.Fatalf("payload not long enough to test the long-record path: %d", len(payload))
	}
	tap := buildCurvesTap(payload)

	nr := newNFCReader()
	nr.tap(tap)
	r := &ndefReader{nfc: nr}
	got, rerr := io.ReadAll(r)
	if rerr != nil {
		t.Fatalf("read long tap: %v", rerr)
	}
	if rt := string(r.RecordType()); rt != curves.RecordType {
		t.Fatalf("long record type = %q, want %q", rt, curves.RecordType)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("long payload round-trip mismatch (%d vs %d bytes)", len(got), len(payload))
	}
	if _, err := curves.Parse(got, gateParams); err != nil {
		t.Fatalf("curves.Parse(long): %v", err)
	}
}

// updateGolden regenerates the testdata fixtures instead of asserting against
// them: `go test -run TestGoldenTaps -update`.
var updateGolden = flag.Bool("update", false, "rewrite the golden tap fixtures")

// TestGoldenTaps guards the reference tap bytes the JS builder (node parity
// check) and the ndeflib writer (python cross-check) diff against. By default
// it ASSERTS the committed fixtures still match what buildCurvesTap emits, so a
// byte-encoding change fails here rather than silently rewriting the golden the
// parity checks then validate against. `-update` rewrites them.
func TestGoldenTaps(t *testing.T) {
	dir := "testdata"
	fixtures := map[string][]byte{
		"tap_path.hex": pathPayloadBytes(t),
		"tap_text.hex": []byte(textPayload),
	}
	if *updateGolden {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for name, p := range fixtures {
			b := hex.EncodeToString(buildCurvesTap(p)) + "\n"
			if err := os.WriteFile(filepath.Join(dir, name), []byte(b), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return
	}
	for name, p := range fixtures {
		want, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("read golden %s: %v (regenerate with `go test -run TestGoldenTaps -update`)", name, err)
		}
		got := hex.EncodeToString(buildCurvesTap([]byte(p))) + "\n"
		if got != string(want) {
			t.Errorf("%s drifted from the committed golden:\n got %s\nwant %s", name, got, want)
		}
	}
}
