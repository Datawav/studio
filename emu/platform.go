//go:build js && wasm

package main

import (
	"image"
	"image/draw"
	"io"
	"syscall/js"
	"time"

	"seedhammer.com/engrave"
	"seedhammer.com/gui"
	"seedhammer.com/image/rgb565"
)

// Native panel dimensions. Match cmd/controller/platform_sh2.go so layout
// branches that gate on dims.X >= 480 stay identical to the device.
const (
	lcdWidth  = 480
	lcdHeight = 320
)

// The shared SeedHammer II engraver profile: the emulator plans and gauges
// with exactly what the device engraves.
var engraverParams = engrave.SH2Params

// Platform implements gui.Platform for a browser canvas. All state crossings
// with JS go through channels so the gui package never sees js.Value.
type Platform struct {
	fb      *rgb565.Image
	dirty   image.Rectangle
	pending bool
	events  chan gui.Event
	wakeups chan struct{}
	nfc     *nfcReader
	eng     *fakeEngraver
	blitter js.Value

	// rgba is a scratch slice reused across blits. Sized for a full-screen
	// frame; the firmware draws into sub-rectangles but the worst case is
	// every pixel.
	rgba []byte
}

func newPlatform(blitter js.Value) *Platform {
	p := &Platform{
		fb:      rgb565.New(image.Rect(0, 0, lcdWidth, lcdHeight)),
		events:  make(chan gui.Event, 64),
		wakeups: make(chan struct{}, 1),
		nfc:     newNFCReader(),
		eng:     newFakeEngraver(),
		blitter: blitter,
		rgba:    make([]byte, lcdWidth*lcdHeight*4),
	}
	return p
}

func (p *Platform) DisplaySize() image.Point {
	return image.Pt(lcdWidth, lcdHeight)
}

func (p *Platform) Dirty(r image.Rectangle) error {
	p.dirty = r.Intersect(p.fb.Rect)
	p.pending = !p.dirty.Empty()
	return nil
}

func (p *Platform) NextChunk() (draw.RGBA64Image, bool) {
	if p.pending {
		p.pending = false
		// Hand the gui package a sub-image so it draws into the dirty
		// region of the backing framebuffer.
		return p.fb.SubImage(p.dirty).(*rgb565.Image), true
	}
	if !p.dirty.Empty() {
		p.flush()
		p.dirty = image.Rectangle{}
	}
	return nil, false
}

func (p *Platform) flush() {
	r := p.dirty
	w, h := r.Dx(), r.Dy()
	need := w * h * 4
	if cap(p.rgba) < need {
		p.rgba = make([]byte, need)
	}
	buf := p.rgba[:need]
	stride := p.fb.Stride
	pix := p.fb.Pix
	off := (r.Min.Y-p.fb.Rect.Min.Y)*stride + (r.Min.X - p.fb.Rect.Min.X)
	di := 0
	for y := 0; y < h; y++ {
		row := pix[off : off+w]
		for x := 0; x < w; x++ {
			cr, cg, cb := rgb565.ToRGB888(row[x])
			buf[di+0] = cr
			buf[di+1] = cg
			buf[di+2] = cb
			buf[di+3] = 0xff
			di += 4
		}
		off += stride
	}
	js8 := js.Global().Get("Uint8ClampedArray").New(need)
	js.CopyBytesToJS(js8, buf)
	p.blitter.Invoke(js8, r.Min.X, r.Min.Y, w, h)
}

func (p *Platform) AppendEvents(deadline time.Time, evts []gui.Event) []gui.Event {
	// Drain anything already queued before blocking.
	for {
		select {
		case e := <-p.events:
			evts = append(evts, e)
		default:
			goto wait
		}
	}
wait:
	if len(evts) > 0 {
		return evts
	}
	d := time.Until(deadline)
	if d <= 0 {
		return evts
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case e := <-p.events:
		evts = append(evts, e)
	case <-p.wakeups:
	case <-t.C:
	}
	return evts
}

func (p *Platform) Wakeup() {
	select {
	case p.wakeups <- struct{}{}:
	default:
	}
}

// NFCReader wraps the raw nfcReader in the same NDEF readers that
// nfc/poller.Read uses on real hardware: TLV → record → payload. Every
// tap pushed onto nfcReader.taps must therefore be an NDEF-wrapped byte
// stream (the host builds a seedhammer.com:curves external record for a
// Studio editor payload, or a Well-Known Text record for a plain scan).
// This mirrors the production poller path so the simulator exercises the
// real nfc/ndef parser on every synth-tap. ndefReader also surfaces
// RecordType so the scan funnel dispatches the curves record by type;
// see nfc.go.
func (p *Platform) NFCReader() io.ReadCloser {
	p.nfc.arm()
	return &ndefReader{nfc: p.nfc}
}

func (p *Platform) Engraver(stall bool) (gui.Engraver, error) {
	return p.eng.open()
}

func (p *Platform) EngraverParams() engrave.Params { return engraverParams }

// Features advertises secure boot so the version string omits the "(UNLOCKED)"
// suffix that would otherwise appear in the corner of every captured screen.
func (p *Platform) Features() gui.Features { return gui.FeatureSecureBoot }

func (p *Platform) HardwareVersion() string { return "emu" }

// LockBoot is reached only from the (debug-only) OTP secure-boot flow, which
// the emulator never exposes. Return success so a stray call doesn't crash.
func (p *Platform) LockBoot() error { return nil }

// RecordPlate is the optional gui plateRecorder seam: NewEngraveScreen hands
// us the planned plate for every engrave (seed, descriptor, text, curves). We
// render it to an SVG resembling the steel and pass it to the host page's
// seedhammerPlateSVG sink. This is a DISPLAY/DOWNLOAD artifact only — it never
// re-enters any NFC path, so emulator test material can never reach a machine.
func (p *Platform) RecordPlate(plate gui.Plate) {
	sink := js.Global().Get("seedhammerPlateSVG")
	if sink.IsUndefined() {
		return
	}
	d := plate.Size.Dims()
	if svg := vectorizePlate(plate.Spline, engraverParams, d.X, d.Y); len(svg) > 0 {
		sink.Invoke(string(svg))
	}
}

// The nfcReader/ndefReader tap plumbing lives in nfc.go, free of the js
// build constraint so a host test can drive it.

// Compile-time assertion that *Platform satisfies gui.Platform.
var _ gui.Platform = (*Platform)(nil)
