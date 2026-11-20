/**
 * Claude Code can end a failed native turn with a <synthetic> API-error
 * assistant row and turn_duration, without firing the regular Stop hook.
 * Wait for the terminal row before treating an error as final: Claude Code
 * may recover from a transient API failure within the same turn.
 */
export type NativeApiFailure = { message: string; status?: number };

export function apiErrorStatusFromRow(row: Record<string, unknown>): number | null {
  const nestedStatus = row.error && typeof row.error === "object"
    ? (row.error as { status?: unknown }).status
    : undefined;
  for (const status of [row.apiErrorStatus, row.api_error_status, nestedStatus]) {
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  return null;
}

export function isNativeApiErrorRow(row: Record<string, unknown>): boolean {
  const message = row.message as { model?: unknown } | undefined;
  return row.type === "assistant" && row.isApiErrorMessage === true && message?.model === "<synthetic>";
}

export class NativeApiErrorTurn {
  private pending: NativeApiFailure | null = null;

  observe(row: Record<string, unknown>): NativeApiFailure | null {
    if (row.type === "assistant") {
      const message = row.message && typeof row.message === "object"
        ? row.message as Record<string, unknown> : {};
      if (isNativeApiErrorRow(row)) {
        const blocks = Array.isArray(message.content) ? message.content : [];
        const text = blocks
          .filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object"))
          .filter(block => block.type === "text" && typeof block.text === "string")
          .map(block => String(block.text).trim())
          .filter(Boolean)
          .join("\n");
        const explicitStatus = apiErrorStatusFromRow(row);
        const status = explicitStatus ?? (text && row.error === "invalid_request" ? 400 : null);
        this.pending = text || explicitStatus !== null ? {
          message: text || "Claude Code reported an upstream API error",
          ...(status !== null ? { status } : {}),
        } : null;
      } else if (message.model !== "<synthetic>") {
        // A subsequent real model reply means the native retry recovered.
        this.pending = null;
      }
    }
    if (row.type === "system" && row.subtype === "turn_duration" && this.pending) {
      const failure = this.pending;
      this.pending = null;
      return failure;
    }
    return null;
  }
}
