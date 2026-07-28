module studiocore

go 1.25.10

require seedhammer.com v0.0.0

require (
	github.com/seedhammer/kortschak-qr v0.3.2 // indirect
	gonum.org/v1/gonum v0.17.0 // indirect
)

// seedhammer.com is a vanity path and not go-gettable. build.sh symlinks a
// firmware checkout (FIRMWARE_DIR) to ./firmware, and this replace resolves
// the GOOS=js build against it. Studio CI can check the firmware out into
// ./firmware directly instead.
replace seedhammer.com => ./firmware

// Replaces do not cross module boundaries, so the firmware's own
// kortschak-qr replace must be mirrored here or this wrapper resolves
// the original module, which lacks the fork's additions (qr.MinSize).
replace github.com/seedhammer/kortschak-qr => github.com/Gangleri42/kortschak-qr v0.3.3
