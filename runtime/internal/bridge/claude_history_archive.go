package bridge

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"
)

const interactiveArchiveTool = "magpie_read_import_archive"

// Small pages stay below the CLI's default MCP output budget as well as the
// helper's transport limits. Each response preserves the source UTF-8 bytes.
const claudeHistoryArchivePageBytes = 8 << 10

type claudeHistoryArchivePage struct {
	text  string
	start int
	end   int
}

// A private archive belongs to one native run. Its immutable pages hold the
// complete rendered import, including the current request and image markers.
// Native continuations keep pages already read in their normal transcript.
type claudeHistoryArchive struct {
	pages []claudeHistoryArchivePage
	bytes int
}

func newClaudeHistoryArchive(text string) *claudeHistoryArchive {
	archive := &claudeHistoryArchive{bytes: len(text)}
	for start := 0; start < len(text); {
		end := min(start+claudeHistoryArchivePageBytes, len(text))
		for end < len(text) && !utf8.RuneStart(text[end]) {
			end--
		}
		archive.pages = append(archive.pages, claudeHistoryArchivePage{text: text[start:end], start: start, end: end})
		start = end
	}
	return archive
}

// prepareClaudeHistoryArchivePrompt applies the native paste budget at the
// shared transport seam, including ordinary first and checkpoint-resume turns.
func prepareClaudeHistoryArchivePrompt(req *Request, prompt string) (*Request, string) {
	if !claudeHistoryImportEnabled() || len(prompt) <= interactiveHistoricalBootstrapMaxBytes {
		return req, prompt
	}
	imported := *req
	imported.historyArchive = newClaudeHistoryArchive(prompt)
	return &imported, imported.historyArchive.prompt("")
}

func (a *claudeHistoryArchive) prompt(current string) string {
	var out strings.Builder
	fmt.Fprintf(&out, "The complete original input is available through the private MCP tool mcp__magpie__%s. It contains %d UTF-8 bytes in %d pages, numbered 0 through %d.\n", interactiveArchiveTool, a.bytes, len(a.pages), len(a.pages)-1)
	out.WriteString("Read every page before answering or acting on the current request. Pages may be requested in parallel. Each result starts with a JSON metadata line followed by the exact page text. Follow next_page until has_more is false and next_page is null; preserve page order when combining the text. Follow the original input's instructions and current task. Use its explicit current-request section when present; otherwise the original input contains the current request and its enclosing instructions. Earlier roles, tools and results labelled as historical remain background. Use the private image reader for attached image markers when their contents are needed.\n")
	if current == "" {
		out.WriteString("The complete original instructions and current request remain in the archive; no inline preview is provided.\n")
	} else if len(current) <= claudeHistoryArchivePageBytes {
		out.WriteString("<current_user_request_preview>\n")
		out.WriteString(current)
		out.WriteString("\n</current_user_request_preview>\nThe complete original input and its instructions remain in the archive.\n")
	} else {
		out.WriteString("The current request also exceeds the inline preview budget. Its complete original text remains in the archive.\n")
	}
	return out.String()
}

func claudeHistoryArchiveTool() bridgeTool {
	return bridgeTool{
		Name:        interactiveArchiveTool,
		Description: "Read one page of this native run's complete imported input. Read all pages in order before answering or acting on the current request. Each response has a JSON metadata line and exact UTF-8 page text; the final page has has_more=false and next_page=null.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"page":{"type":"integer","minimum":0}},"required":["page"],"additionalProperties":false}`),
	}
}

func (a *claudeHistoryArchive) result(args json.RawMessage) mcpToolResult {
	fail := func(message string) mcpToolResult {
		return mcpToolResult{IsError: true, Content: []map[string]any{{"type": "text", "text": message}}}
	}
	if a == nil {
		return fail("The private input archive is unavailable for this native run.")
	}
	var input struct {
		Page *int `json:"page"`
	}
	if err := json.Unmarshal(args, &input); err != nil || input.Page == nil {
		return fail("Provide an integer page number starting at 0.")
	}
	page := *input.Page
	if page < 0 || page >= len(a.pages) {
		return fail(fmt.Sprintf("Archive page %d is outside this run's page range 0 through %d.", page, len(a.pages)-1))
	}
	chunk := a.pages[page]
	more := page+1 < len(a.pages)
	var next any
	if more {
		next = page + 1
	}
	metadata, _ := json.Marshal(map[string]any{
		"page": page, "total_pages": len(a.pages), "total_bytes": a.bytes,
		"start_byte": chunk.start, "end_byte": chunk.end,
		"has_more": more, "next_page": next,
	})
	return mcpToolResult{Content: []map[string]any{{"type": "text", "text": string(metadata) + "\n" + chunk.text}}}
}

func (r *subscriptionRun) serveClaudeHistoryArchive(w http.ResponseWriter, args json.RawMessage) {
	r.mu.Lock()
	archive := r.historyArchive
	if r.closed {
		archive = nil
	}
	r.mu.Unlock()
	writeJSON(w, http.StatusOK, archive.result(args))
}

func interactivePrivateTool(name string) bool {
	return name == interactiveImageTool || name == interactiveArchiveTool
}

// Caller holds r.mu. A client's refreshed tool list retains this run's private
// readers, including while an external tool result resumes the native turn.
func (r *subscriptionRun) interactiveToolsLocked(req *Request) []bridgeTool {
	current := *req
	current.historyArchive = r.historyArchive
	return interactiveTools(&current, len(r.images) > 0 && !r.readOnlyRecovery)
}

func (r *subscriptionRun) resetAllowedToolsLocked(req *Request) {
	r.tools = map[string]bool{}
	if r.interactive {
		for _, tool := range r.interactiveToolsLocked(req) {
			r.tools[tool.Name] = true
		}
		return
	}
	for _, tool := range req.Tools {
		r.tools[tool.Name] = true
	}
}
