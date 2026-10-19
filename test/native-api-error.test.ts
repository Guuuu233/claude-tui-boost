import { expect, test } from "bun:test";
import { NativeApiErrorTurn } from "../vendor/claude-bridge-magpie/src/native-api-error.ts";
import { makeClaudeErrorResultEvent } from "../vendor/claude-bridge-magpie/src/claude-compat.ts";

const terminal = { type: "system", subtype: "turn_duration" };
const tooLong = {
  type: "assistant",
  isApiErrorMessage: true,
  error: "invalid_request",
  message: {
    model: "<synthetic>",
    content: [{ type: "text", text: "Prompt is too long" }],
  },
};

test("a native invalid_request without a Stop hook fails at the terminal transcript row", () => {
  const turn = new NativeApiErrorTurn();
  expect(turn.observe(tooLong)).toBeNull();
  expect(turn.observe(terminal)).toEqual({ message: "Prompt is too long", status: 400 });
});

test("a transient native API error must not fail before the turn actually ends", () => {
  const turn = new NativeApiErrorTurn();
  expect(turn.observe(tooLong)).toBeNull();
  expect(turn.observe({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Recovered" }] } })).toBeNull();
  expect(turn.observe(terminal)).toBeNull();
});

test("synthetic assistant text without the explicit native error marker is not an API error", () => {
  const turn = new NativeApiErrorTurn();
  expect(turn.observe({ ...tooLong, isApiErrorMessage: false })).toBeNull();
  expect(turn.observe(terminal)).toBeNull();
});

test("an untrusted or missing native error message never becomes a success or an injected diagnostic", () => {
  const turn = new NativeApiErrorTurn();
  expect(turn.observe({ ...tooLong, message: { model: "<synthetic>", content: [] } })).toBeNull();
  expect(turn.observe(terminal)).toBeNull();
});

test("completed native API failures remain readable by an older Go runtime", () => {
  const event = makeClaudeErrorResultEvent({ message: "Prompt is too long", apiErrorStatus: 400, legacyResult: "Claude Code API error: Prompt is too long" });
  expect(event.is_error).toBe(true);
  expect(event.result).toBe("Claude Code API error: Prompt is too long");
  expect(event.error).toBe("Prompt is too long");
  expect(makeClaudeErrorResultEvent({ message: "ordinary failure" }).result).toBeNull();
});
