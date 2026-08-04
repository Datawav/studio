// nfc-bus.js — the one place that turns a Studio editor payload into the
// exact byte stream a scanned tag delivers, and dispatches it to the
// in-browser SeedHammer emulator.
//
// The firmware recognises a drawing by its NDEF record type
// (seedhammer.com:curves, an external/TNF-0x04 record); everything else is
// content-sniffed. So the emulator must be fed a real NDEF message, not raw
// payload bytes. buildCurvesTap reproduces, byte-for-byte, what the
// nfc-bridge writes to a tag via ndeflib — proven by emu/nfc_test.go's
// golden and a node/ndeflib parity check. Both editor modes (text and path)
// travel as a curves record, matching the editor's own Web NFC send.
"use strict";
(function (root) {
  const RECORD_TYPE = "seedhammer.com:curves";
  const enc = new TextEncoder();

  // buildCurvesTap wraps a curves payload string as: an NDEF external record
  // of type seedhammer.com:curves, inside an NDEF-message TLV
  // (0x03 <len> … 0xFE) — the layer the firmware's nfc/ndef reader parses.
  // Short vs long forms follow the NFC Forum spec exactly (SR when the
  // payload fits a byte, 0xFF-escaped 2-byte TLV length past 254), so the
  // output equals ndeflib's for every size.
  function buildCurvesTap(payloadStrOrBytes) {
    // A v2 path payload is binary (Uint8Array); a text/v1 payload is a string.
    const payload = payloadStrOrBytes instanceof Uint8Array ? payloadStrOrBytes : enc.encode(payloadStrOrBytes);
    const type = enc.encode(RECORD_TYPE); // 21 bytes, ASCII
    const rec = [];
    if (payload.length < 256) {
      // MB | ME | SR | TNF-external, 1-byte payload length.
      rec.push(0xd4, type.length, payload.length);
    } else {
      // MB | ME | TNF-external, 4-byte payload length.
      const n = payload.length;
      rec.push(0xc4, type.length, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    }
    for (const b of type) rec.push(b);
    for (const b of payload) rec.push(b);

    return wrapTLV(rec);
  }

  // wrapTLV puts a record inside an NDEF-message TLV (0x03 <len> … 0xFE),
  // the layer the firmware's nfc/ndef reader parses, with the 0xFF-escaped
  // two-byte length past 254 the spec calls for.
  function wrapTLV(rec) {
    const tlv = [];
    if (rec.length < 255) {
      tlv.push(0x03, rec.length);
    } else {
      tlv.push(0x03, 0xff, (rec.length >>> 8) & 255, rec.length & 255);
    }
    for (const b of rec) tlv.push(b);
    tlv.push(0xfe);
    return new Uint8Array(tlv);
  }

  // buildTextTap wraps text as an NDEF Text record — TNF well-known, type
  // "T", the payload led by a status byte carrying the language length and
  // the language itself, which the firmware's reader skips. This is the
  // record a phone NFC app or write-nfc.py --raw writes, and the one the
  // scanner content-sniffs into a seed phrase, a descriptor, a key or plate
  // text.
  function buildTextTap(text) {
    const lang = enc.encode("en");
    const body = enc.encode(text);
    const payload = new Uint8Array(1 + lang.length + body.length);
    payload[0] = lang.length; // UTF-8 (bit 7 clear), language length in bits 0-5.
    payload.set(lang, 1);
    payload.set(body, 1 + lang.length);
    const rec = [];
    if (payload.length < 256) {
      // MB | ME | SR | TNF-well-known, 1-byte payload length.
      rec.push(0xd1, 1, payload.length);
    } else {
      // MB | ME | TNF-well-known, 4-byte payload length.
      const n = payload.length;
      rec.push(0xc1, 1, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    }
    rec.push(0x54); // "T"
    for (const b of payload) rec.push(b);
    return wrapTLV(rec);
  }

  // feedEmu delivers a curves payload to the running emulator as a synthetic
  // tap. Returns false if the emulator isn't booted yet (its tap global is
  // installed by the wasm main), so callers can defer.
  function feedEmu(payloadStr) {
    if (typeof root.seedhammerSynthTap !== "function") return false;
    root.seedhammerSynthTap(buildCurvesTap(payloadStr));
    return true;
  }

  // feedEmuText taps text in as a scanned Text record.
  function feedEmuText(text) {
    if (typeof root.seedhammerSynthTap !== "function") return false;
    root.seedhammerSynthTap(buildTextTap(text));
    return true;
  }

  root.NFCBus = { RECORD_TYPE, buildCurvesTap, buildTextTap, feedEmu, feedEmuText };
})(typeof globalThis !== "undefined" ? globalThis : this);
