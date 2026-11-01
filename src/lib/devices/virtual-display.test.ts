import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SPEC,
  parseDefaults,
  presetIdFor,
  serializeDefaults,
  SIZE_PRESETS,
  displayKey,
  isVirtualKey,
  parseDisplayKey,
  specError,
  validComponent,
  validStartApp,
} from "./virtual-display.ts";

describe("virtual display keys", () => {
  it("round-trips and tells virtual from physical", () => {
    assert.equal(displayKey("R5CW90ABC1", 2), "R5CW90ABC1#vd2");
    assert.deepEqual(parseDisplayKey("R5CW90ABC1#vd2"), { serial: "R5CW90ABC1", index: 2 });
    assert.deepEqual(parseDisplayKey("192.168.1.5:5555#vd1"), { serial: "192.168.1.5:5555", index: 1 });
    assert.equal(isVirtualKey("R5CW90ABC1#vd1"), true);
    for (const bad of ["R5CW90ABC1", "R5CW90ABC1#vd0", "#vd1", "x#vdz", "x#vd1 "]) {
      assert.equal(isVirtualKey(bad), false, bad);
    }
  });
});

describe("virtual display settings", () => {
  it("accepts the presets and the default", () => {
    assert.equal(specError(DEFAULT_SPEC), null);
    for (const preset of SIZE_PRESETS) assert.equal(specError(preset), null, preset.id);
  });

  it("rejects sizes and densities the agent refuses", () => {
    assert.match(specError({ width: 100, height: 1920, dpi: 320 }) ?? "", /Width and height/);
    assert.match(specError({ width: 1080, height: 5000, dpi: 320 }) ?? "", /Width and height/);
    assert.match(specError({ width: 1080.5, height: 1920, dpi: 320 }) ?? "", /Width and height/);
    assert.match(specError({ width: 1080, height: 1920, dpi: 10 }) ?? "", /Density/);
    assert.match(specError({ width: 1080, height: 1920, dpi: 641 }) ?? "", /Density/);
  });

  it("checks the app like the agent does", () => {
    for (const ok of ["org.mozilla.firefox", "+com.a.b", "?Firefox", "a_b-c.d"]) assert.equal(validStartApp(ok), true, ok);
    for (const bad of ["", "+", "?", "a b", "a;reboot", "$(id)", "a|b", "a\nb"]) assert.equal(validStartApp(bad), false, bad);
    assert.match(specError({ ...DEFAULT_SPEC, startApp: "x;reboot" }) ?? "", /package name/);
    assert.equal(specError({ ...DEFAULT_SPEC, startApp: "  " }), null);
    assert.equal(validComponent("com.android.settings/.Settings"), true);
    assert.equal(validComponent("a.b/a.b.Main$Inner"), true);
    for (const bad of ["a.b", "/x", "a.b/", "a b/.X", "a.b/.X;id"]) assert.equal(validComponent(bad), false, bad);
  });
});

describe("remembered defaults", () => {
  it("round-trips a valid choice", () => {
    const spec = { width: 720, height: 1280, dpi: 240, startApp: "org.mozilla.firefox" };
    assert.deepEqual(parseDefaults(serializeDefaults(spec)), spec);
    assert.equal(presetIdFor(spec), "small");
    assert.equal(presetIdFor({ width: 700, height: 1280, dpi: 240 }), "custom");
  });

  it("falls back to the built-in defaults for missing or bad data", () => {
    for (const raw of [null, "", "not json", "null", "{}", '{"width":50,"height":1920,"dpi":320}', '{"width":1080,"height":1920,"dpi":320,"startApp":"x;reboot"}']) {
      const spec = parseDefaults(raw);
      assert.equal(specError(spec), null, String(raw));
      assert.equal(spec.width, raw && raw.includes('"startApp":"x;reboot"') ? 1080 : DEFAULT_SPEC.width);
    }
  });
});
