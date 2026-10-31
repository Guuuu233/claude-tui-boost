package bridge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// A session rebuilt from the request (liteSeed) is a fresh transcript, and
// Claude Code marks only its system prompt and its newest message for the
// prompt cache. The next rebuild's newest message is another one, and
// Anthropic reads only an entry an earlier request wrote at one of its own
// breakpoints, looking back at most 20 blocks from each of the new request's
// breakpoints: every rebuild wrote the whole conversation to the cache again.
//
// A rebuilt transcript therefore carries one breakpoint of its own, on the
// last block of the history it was given (never the line closing a history
// that ends in tool results, which the next rebuild will not have): the next
// rebuild of the conversation reads everything up to there and writes only
// what came after. When the conversation has grown further than the lookback
// since a breakpoint this runtime wrote, the mark goes where that earlier
// entry is still within reach, and the next rebuild steps on from there.
// Claude Code marks three blocks itself; four is Anthropic's limit.
//
// MAGPIE_CLAUDE_REBUILD_CACHE_MARK=0 leaves rebuilt transcripts unmarked.

const (
	// rebuildMarkReach keeps a mark inside Anthropic's lookback of 20
	// positions from the entry it is to read.
	rebuildMarkReach = 18
	// rebuildMarkTTL is a little under the hour every native run asks for
	// (CLAUDE_CODE_PROMPT_CACHE_TTL, cleanClaudeEnv). A mark is an hour's as
	// well: a 1h breakpoint may not follow a 5m one.
	rebuildMarkTTL   = 55 * time.Minute
	rebuildMarksKept = 4096
)

// rebuildMarks holds the transcript prefixes a mark was written (or read)
// at, by hash, and when.
var rebuildMarks = struct {
	sync.Mutex
	written map[string]time.Time
}{written: map[string]time.Time{}}

// rebuildMarksOff is set once Anthropic refuses a marked rebuild over its
// cache_control blocks (a Claude Code that marks more of its own).
var rebuildMarksOff atomic.Bool

// transcriptMark is the block appendClaudeTranscript marks for the prompt
// cache: history[msg].Parts[part].
type transcriptMark struct{ msg, part int }

func rebuildMarksEnabled() bool {
	return os.Getenv("MAGPIE_CLAUDE_REBUILD_CACHE_MARK") != "0" && !rebuildMarksOff.Load()
}

// rebuildMarkContext is what a rebuilt session's cached prefix holds before
// its transcript: the account, model, tools and settings its Claude Code is
// started with. The caller's own instructions come after it, in the turn.
func rebuildMarkContext(owner, model string, req *Request, tools []byte) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s\x00%s\x00%t\x00%s\x00", owner, model, req.Effort, req.ThinkOff, req.Schema)
	h.Write(tools)
	return hex.EncodeToString(h.Sum(nil))
}

// liteClosing is the line liteSeed closes a history ending in tool results
// with: not the client's, and gone from the next rebuild.
func liteClosing(m Message) bool {
	return m.Role == "assistant" && len(m.Parts) == 1 && m.Parts[0].Kind == Text && m.Parts[0].Text == liteResultsReceived
}

// rebuildCacheMark picks the block of history (as appendClaudeTranscript
// writes it under context) a rebuilt transcript marks, and remembers it.
func rebuildCacheMark(context string, history []Message, toolPrefix string) (transcriptMark, bool) {
	if !rebuildMarksEnabled() {
		return transcriptMark{}, false
	}
	end := len(history)
	if end > 0 && liteClosing(history[end-1]) {
		end--
	}
	type block struct {
		mark     transcriptMark
		pos      int
		hash     string
		eligible bool
	}
	var blocks []block
	sum := sha256.Sum256([]byte(context))
	prefix := sum[:]
	pos := 0
	for i, m := range history[:end] {
		role := m.Role
		if role == "system" {
			role = "user"
		}
		last := ""
		for j, p := range m.Parts {
			b, ok := transcriptBlock(p, toolPrefix)
			if !ok {
				continue
			}
			typ, _ := b["type"].(string)
			if typ == last && (typ == "tool_use" || typ == "tool_result") {
				// Anthropic counts consecutive calls, or results, as one
				// position: only the run's last block is marked.
				blocks[len(blocks)-1].eligible = false
			} else {
				pos++
			}
			raw, _ := json.Marshal(b)
			h := sha256.New()
			h.Write(prefix)
			if last == "" {
				h.Write([]byte("\x00" + role + "\x00"))
			}
			h.Write(raw)
			prefix = h.Sum(nil)
			text, _ := b["text"].(string)
			eligible := typ == "tool_use" || typ == "tool_result" || (typ == "text" && strings.TrimSpace(text) != "")
			blocks = append(blocks, block{transcriptMark{i, j}, pos, hex.EncodeToString(prefix), eligible})
			last = typ
		}
	}
	final := -1
	for k := len(blocks) - 1; k >= 0; k-- {
		if blocks[k].eligible {
			final = k
			break
		}
	}
	if final < 0 {
		return transcriptMark{}, false
	}
	now := time.Now()
	rebuildMarks.Lock()
	defer rebuildMarks.Unlock()
	chosen, prev := final, -1
	for k := final; k >= 0; k-- {
		if t, ok := rebuildMarks.written[blocks[k].hash]; ok && now.Sub(t) < rebuildMarkTTL {
			prev = k
			break
		}
	}
	if prev >= 0 {
		// Read now, so kept another hour.
		rebuildMarks.written[blocks[prev].hash] = now
		if blocks[final].pos-blocks[prev].pos > rebuildMarkReach {
			chosen = prev
			for k := prev + 1; k <= final && blocks[k].pos-blocks[prev].pos <= rebuildMarkReach; k++ {
				if blocks[k].eligible {
					chosen = k
				}
			}
		}
	}
	if len(rebuildMarks.written) >= rebuildMarksKept {
		for k, t := range rebuildMarks.written {
			if now.Sub(t) >= rebuildMarkTTL {
				delete(rebuildMarks.written, k)
			}
		}
		if len(rebuildMarks.written) >= rebuildMarksKept {
			rebuildMarks.written = map[string]time.Time{}
		}
	}
	rebuildMarks.written[blocks[chosen].hash] = now
	return blocks[chosen].mark, true
}

// noteRebuildMarkRefused turns the marks off for this runtime when Anthropic
// refuses a marked rebuild over its cache_control blocks.
func noteRebuildMarkRefused(text string) {
	if !strings.Contains(text, "cache_control") || !rebuildMarksOff.CompareAndSwap(false, true) {
		return
	}
	if len(text) > 300 {
		text = text[:300]
	}
	log.Printf("Claude interactive stops marking rebuilt sessions for the prompt cache: %s", text)
}
