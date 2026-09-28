import assert from "node:assert/strict";
import { keyDownInject, keyUpInject, leaveToBrowser } from "./keyboard.ts";

const base = {
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
};

const letter = keyDownInject({ ...base, key: "a" });
assert.deepEqual(letter, { kind: "text", text: "a" });

const shifted = keyDownInject({ ...base, key: "A", shiftKey: true });
assert.deepEqual(shifted, { kind: "text", text: "A" });
assert.equal(keyUpInject({ ...base, key: "a" }), null);

const enter = keyDownInject({ ...base, key: "Enter" });
assert.deepEqual(enter, { kind: "key", keycode: 66, metastate: 0, repeat: 0 });
const enterUp = keyUpInject({ ...base, key: "Enter" });
assert.equal(enterUp && enterUp.kind === "key" ? enterUp.keycode : 0, 66);

const back = keyDownInject({ ...base, key: "Backspace", repeat: true });
assert.deepEqual(back, { kind: "key", keycode: 67, metastate: 0, repeat: 1 });

const selectAll = keyDownInject({ ...base, key: "a", ctrlKey: true });
assert.deepEqual(selectAll, { kind: "key", keycode: 29, metastate: 0x1000, repeat: 0 });

assert.equal(keyDownInject({ ...base, key: "r", ctrlKey: true }), null);
assert.equal(leaveToBrowser({ ...base, key: "F5" }), true);
assert.equal(keyDownInject({ ...base, key: "Shift" }), null);

console.log("keyboard inject ok");
