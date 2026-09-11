import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composerSource = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);

const modifierSendCondition =
  /e\.key === "Enter"\s*&&\s*!e\.shiftKey\s*&&\s*\(enterToSend \|\| e\.metaKey \|\| e\.ctrlKey\)/;

test("enter-to-send ignores the IME confirm keystroke", () => {
  const guardIndex = composerSource.indexOf(
    "e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229",
  );
  const sendIndex = composerSource.search(modifierSendCondition);
  assert.ok(guardIndex > -1, "composer keydown must check IME composition");
  assert.ok(sendIndex > -1, "composer keydown must keep the send branch");
  assert.ok(
    guardIndex < sendIndex,
    "composition guard must run before the send branch",
  );
});

test("modifier Enter sends when Enter-to-send is disabled", () => {
  const sendBranch = composerSource.match(
    /if \(\s*e\.key === "Enter"[\s\S]*?\(enterToSend \|\| e\.metaKey \|\| e\.ctrlKey\)[\s\S]*?void submit\(\);\s*\}/,
  )?.[0] ?? "";
  assert.ok(sendBranch, "composer keydown must include the modifier send branch");
  assert.match(sendBranch, /!e\.shiftKey/);
  assert.match(sendBranch, /e\.metaKey/);
  assert.match(sendBranch, /e\.ctrlKey/);

  const shouldSend = ({ key, shiftKey, metaKey, ctrlKey }, enterToSend) =>
    key === "Enter" && !shiftKey && (enterToSend || metaKey || ctrlKey);
  const cases = [
    [{ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: true }, true],
    [{ key: "Enter", shiftKey: false, metaKey: true, ctrlKey: false }, true],
    [{ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false }, false],
    [{ key: "Enter", shiftKey: true, metaKey: false, ctrlKey: true }, false],
  ];
  for (const [event, expected] of cases) {
    assert.equal(shouldSend(event, false), expected);
  }
});

test("model menu keydown ignores IME composition keystrokes", () => {
  const handler = composerSource.slice(
    composerSource.indexOf("const onModelThinkingMenuKeyDown"),
    composerSource.indexOf('e.key === "ArrowDown"'),
  );
  assert.match(
    handler,
    /e\.nativeEvent\.isComposing \|\| e\.nativeEvent\.keyCode === 229/,
    "menu navigation must bail out while an IME composition is active",
  );
});

test("an ideographic comma opens the slash menu from an empty draft (D405)", () => {
  const handler = composerSource.slice(
    composerSource.indexOf("onInput={(e) => {"),
    composerSource.indexOf("onCompositionStart={() => setComposing(true)}"),
  );
  assert.match(
    handler,
    /rewriteIdeographicCommaTrigger\(/,
    "the editable must route a committed 、 through the shared rewrite",
  );
  assert.match(
    handler,
    /valueRef\.current === ""/,
    "only a draft with nothing in it may be rewritten",
  );
  assert.match(
    handler,
    /pendingEditorCaretRef\.current = start/,
    "the caret must land after the substituted slash",
  );
});
