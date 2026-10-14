package bridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// The native lease only follows the wrapper process. tmux's pane server is
// detached and can survive a wrapper SIGKILL. A private, per-outer marker
// written by the wrapper BEFORE it launches tmux lets the next Runtime
// refuse takeover of a still-live pane. An unreadable/unknown marker must
// never be interpreted as evidence of a stopped Claude child.
type interactiveTmuxOwner struct {
	Version         int    `json:"version"`
	Session         string `json:"session"`
	SocketEnvSHA256 string `json:"socket_env_sha256"`
}

func interactiveTmuxSocketEnvironmentHash() string {
	sum := sha256.Sum256([]byte(os.Getenv("TMUX_TMPDIR") + "\x00" + os.Getenv("TMUX")))
	return hex.EncodeToString(sum[:])
}

var interactiveTmuxSessionName = regexp.MustCompile(`^claude-bridge-[[:xdigit:]]{8}$`)

func interactiveTmuxGuardPath(owner, outer string) string {
	return filepath.Join(mustStateDir(), "claude-interactive-native-leases", interactiveSessionStateKey(owner, outer)+".tmux.json")
}

// inspectInteractiveTmuxGuard must be called while holding the native
// per-outer process lease, so a different wrapper cannot overwrite the
// marker while we check it. required=true on automatic orphan recovery;
// old uninstrumented wrappers must fail closed rather than be guessed dead.
func inspectInteractiveTmuxGuard(owner, outer string, required bool) error {
	path := interactiveTmuxGuardPath(owner, outer)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if required {
			return errors.New("no native tmux ownership evidence for this session")
		}
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Size() < 5 || info.Size() > 1024 {
		return errors.New("unsafe or truncated native tmux marker")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var marker interactiveTmuxOwner
	if json.Unmarshal(data, &marker) != nil || marker.Version != 2 || !interactiveTmuxSessionName.MatchString(marker.Session) || len(marker.SocketEnvSHA256) != 64 {
		return errors.New("invalid native tmux marker; refusing unsafe recovery")
	}
	if marker.SocketEnvSHA256 != interactiveTmuxSocketEnvironmentHash() {
		return errors.New("native tmux socket environment changed; cannot establish original pane liveness")
	}
	// Use this Runtime's tmux binary, not an arbitrary executable path from
	// untrusted persisted metadata. Exact target matching (=name) prevents
	// another similarly named session being confused with the native owner.
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		return fmt.Errorf("cannot verify native tmux liveness: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, tmux, "has-session", "-t", "="+marker.Session)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return errInteractiveOuterLive
	}
	if ctx.Err() != nil {
		return errors.New("native tmux liveness check timed out")
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 {
		return errors.New("native tmux liveness check failed unexpectedly")
	}
	// tmux 3.x distinguishes no session/server from a socket or permission
	// error. Accept only its explicit absence reports; a generic exit 1 is
	// not enough to conclude the detached Claude process is gone.
	reason := strings.ToLower(strings.TrimSpace(string(out)))
	if strings.Contains(reason, "can't find session") || strings.Contains(reason, "no server running") || strings.Contains(reason, "failed to connect to server") {
		return nil
	}
	if strings.Contains(reason, "error connecting to") && strings.Contains(reason, "no such file or directory") {
		// tmux exited after its last pane was killed. No server socket
		// remains at the path inspected by this very Runtime.
		return nil
	}
	return errors.New("cannot prove native tmux session terminated")
}
