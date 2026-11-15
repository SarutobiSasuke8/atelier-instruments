import test from "node:test";
import assert from "node:assert/strict";
import { encodeWav } from "../../../shared/wav-export.js";
import { parseBank, serializeBank } from "../ui/bank.js";
import { crc32Bytes, zipStore } from "../ui/zip-store.js";
import { renderSfx } from "../engine.js";

test("wav header matches the buffer", () => {
  const sound = renderSfx("menu-click", { length: 0.2 }, 3);
  const wav = encodeWav(sound.samples, sound.sampleRate);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString("ascii"), "RIFF");
  assert.equal(Buffer.from(wav.subarray(8, 12)).toString("ascii"), "WAVE");
  assert.equal(Buffer.from(wav.subarray(36, 40)).toString("ascii"), "data");
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), sound.sampleRate);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), sound.samples.length * 2);
  assert.equal(wav.length, 44 + sound.samples.length * 2);
});

test("zip stores wav names and bytes", () => {
  const click = renderSfx("menu-click", {}, 1);
  const err = renderSfx("error", { length: 0.2 }, 2);
  const files = [
    { name: "ui-menu-click.wav", data: encodeWav(click.samples, click.sampleRate) },
    { name: "ui-error.wav", data: encodeWav(err.samples, err.sampleRate) },
  ];
  const zip = zipStore(files);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  const names = [];
  let cursor = 0;
  for (const file of files) {
    const view = new DataView(zip.buffer, zip.byteOffset + cursor, 30);
    assert.equal(view.getUint32(0, true), 0x04034b50);
    assert.equal(view.getUint16(8, true), 0);
    const nameLen = view.getUint16(26, true);
    const size = view.getUint32(18, true);
    const name = Buffer.from(zip.subarray(cursor + 30, cursor + 30 + nameLen)).toString("utf8");
    names.push(name);
    const data = zip.subarray(cursor + 30 + nameLen, cursor + 30 + nameLen + size);
    assert.equal(crc32Bytes(data), crc32Bytes(file.data));
    assert.deepEqual(data, file.data);
    cursor += 30 + nameLen + size;
  }
  assert.deepEqual(names, ["ui-menu-click.wav", "ui-error.wav"]);
  assert.throws(() => zipStore([{ name: "..", data: new Uint8Array([1]) }]), /Bad zip name/);
  const stripped = zipStore([{ name: "../ui-menu-click.wav", data: files[0].data }]);
  const strippedNameLen = new DataView(stripped.buffer, stripped.byteOffset, 30).getUint16(26, true);
  const strippedName = Buffer.from(stripped.subarray(30, 30 + strippedNameLen)).toString("utf8");
  assert.equal(strippedName, "ui-menu-click.wav");
});

test("preset banks normalize, wrap a single item, and reject junk", () => {
  const bank = parseBank({
    name: "  Bench  ",
    items: [
      { name: "Tick", category: "menu-click", seed: 4, params: { pitch: 0.2, "no spaces": 1, loud: 0.5 } },
    ],
  });
  assert.equal(bank.name, "Bench");
  assert.equal(bank.items[0].params.pitch, 0.2);
  assert.equal(bank.items[0].params.loud, 0.5);
  assert.equal(bank.items[0].params["no spaces"], undefined);
  const again = parseBank(serializeBank(bank));
  assert.deepEqual(again, bank);

  const single = parseBank({ name: "Solo", category: "hit", seed: 8, params: { punch: 1 } });
  assert.equal(single.items.length, 1);
  assert.throws(() => parseBank({ items: [{ name: "", category: "hit", seed: 1 }] }), /name/);
  assert.throws(() => parseBank({ items: [{ name: "A", category: "hit", seed: 1.2 }] }), /seed/);
  assert.throws(() => parseBank("not json"), /JSON/);
});
