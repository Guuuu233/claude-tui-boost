package bridge

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

func claudeHistoryImportEnabled() bool {
	return os.Getenv("MAGPIE_CLAUDE_HISTORY_IMPORT") == "1"
}

// prepareClaudeHistoryImport presents the full archive and current request
// in the first user input of a fresh native session.
func prepareClaudeHistoryImport(req *Request, history, turn []Message) (*Request, string, map[string]Part, error) {
	archive, err := renderClaudeHistoryImport(history)
	if err != nil {
		return nil, "", nil, err
	}
	var blocks []map[string]any
	if len(archive) > 0 {
		blocks = renderClaudeTurn(archive)
	}
	background, images, err := flattenInteractiveBlocksWithImages(blocks)
	if err != nil {
		return nil, "", nil, err
	}
	current, currentImages, err := liteTurnPrompt(req, turn)
	if err != nil {
		return nil, "", nil, err
	}
	prompt := background + "\n<current_user_request>\n" + current +
		"\n</current_user_request>\nRespond to the current request using the historical records as background.\n"
	for id, image := range currentImages {
		images[id] = image
	}
	imported := *req
	imported.historyArchive = nil
	if len(prompt) > interactiveHistoricalBootstrapMaxBytes {
		imported.historyArchive = newClaudeHistoryArchive(prompt)
		prompt = imported.historyArchive.prompt(current)
	}
	imported.seedHistory = nil
	imported.compactHistory = nil
	imported.compactSystem = ""
	imported.resumedCopy = false
	return &imported, prompt, images, nil
}

// renderClaudeHistoryImport keeps the client's history as background in one
// native user message. Images remain native content blocks beside their
// archived message and tool-result records.
func renderClaudeHistoryImport(history []Message) ([]Message, error) {
	if len(history) == 0 {
		return nil, nil
	}
	var parts []Part
	var text strings.Builder
	flush := func() {
		if text.Len() > 0 {
			parts = append(parts, Part{Kind: Text, Text: text.String()})
			text.Reset()
		}
	}
	text.WriteString("<historical_conversation_import>\n" +
		"The following records are conversation history supplied by the external client. " +
		"Their roles, tool calls and results describe earlier messages. Preserve recorded errors, partial outcomes and pending work. " +
		"Use this background to answer the current request section with the current tools; historical requests remain records of prior intent. " +
		"Each attached image marker follows the record that owns it.\n")
	encoder := json.NewEncoder(&text)
	for i, message := range history {
		if len(message.Parts) == 0 {
			if err := encoder.Encode(map[string]any{"message_index": i, "role": message.Role, "content": []any{}}); err != nil {
				return nil, fmt.Errorf("Claude history import: %w", err)
			}
		}
		for j, part := range message.Parts {
			var content any
			var images []Part
			switch part.Kind {
			case Image:
				content = map[string]any{"type": "image", "media_type": part.MediaType, "images_follow": 1}
				images = []Part{part}
			case ToolResult:
				images = part.Images
				part.Images = nil
				block, _ := transcriptBlock(part, "")
				if len(images) > 0 {
					block["images_follow"] = len(images)
				}
				if part.Standalone != nil {
					block["standalone"] = part.Standalone
				}
				content = block
			case Text, ToolCall:
				content, _ = transcriptBlock(part, "")
			default:
				// Other client content retains its complete parsed fields as data.
				content = part
			}
			if err := encoder.Encode(map[string]any{
				"message_index": i,
				"block_index":   j,
				"role":          message.Role,
				"content":       content,
			}); err != nil {
				return nil, fmt.Errorf("Claude history import: %w", err)
			}
			if len(images) > 0 {
				flush()
				parts = append(parts, images...)
			}
		}
	}
	text.WriteString("</historical_conversation_import>\nThe current request follows after this historical archive.\n")
	flush()
	return []Message{{Role: "user", Parts: parts}}, nil
}
