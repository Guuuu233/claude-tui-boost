import { expect, test } from "bun:test";
import { NativeApiErrorTurn } from "../vendor/claude-bridge-magpie/src/native-api-error.ts";

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

import {reshapeAssistantEvent} from "../vendor/claude-bridge-magpie/src/claude-compat.ts";
test('native API failure retains authoritative error metadata through reshaping',()=>{
 const event=reshapeAssistantEvent({type:'assistant',isApiErrorMessage:true,error:'invalid_request',requestId:'fixture-request',message:{model:'<synthetic>',content:[{type:'text',text:'API Error: fixture refusal'}]}},'fixture-session');
 expect(event.isApiErrorMessage).toBe(true);expect(event.error).toBe('invalid_request');expect(event.request_id).toBe('fixture-request');
});
