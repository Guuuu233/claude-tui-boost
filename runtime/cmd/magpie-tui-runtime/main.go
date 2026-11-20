// magpie-tui-runtime is the extracted Claude TUI subscription runtime the
// plugin starts: an ordinary-user process that holds the loopback HTTP
// surface the plugin's bridge-auth-v1 calls, and owns the live Claude runs
// the PTY wrapper drives.
//
// Contract (magpie-tui-runtime-contract/v1, src/runtime-contract.mjs):
//
//	magpie-tui-runtime --serve \
//	    --port-file <path> --key-file <path> --models-file <path> \
//	    [--state-dir <dir>] [--bridge <claude-bridge binary>] \
//	    [--helper <magpie-tui-mcp-helper>] [--proxy <url|direct>]
//
// Writes a connection key to --key-file (0600), binds 127.0.0.1:0 and
// writes the port to --port-file, writes its advertised models to
// --models-file, then serves until SIGTERM/SIGINT. Any missing or
// wrong-signed call is refused; the runtime never replays a caller's
// history for them. Credentials stay with the native Claude CLI.
//
// The key is fresh random per start by default (contract/v1). The
// optional --reuse-key flag is for supervised production restarts: when
// --key-file already exists it must be a non-symlink regular file, mode
// 0600 or stricter, containing exactly 64 hex bytes, and its exact bytes
// are reused as the session secret; a missing file is still generated
// fresh and stored atomically 0600. Malformed or insecure existing files
// are refused, never silently rotated.
//
// The same binary is its own MCP helper when invoked as
// `magpie-tui-runtime claude-mcp-helper <callback> <tools-file>`, or the
// packaged magpie-tui-mcp-helper binary can be named with --helper.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"magpie-tui-runtime/internal/bridge"
	"magpie-tui-runtime/internal/claudebridge"
)

const contract = "magpie-tui-runtime-contract/v1"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "claude-mcp-helper" {
		// The vendored helper speaks stdio MCP on behalf of the runtime's
		// HTTP callback: it never touches the plugin's auth key itself.
		if err := claudebridge.RunMCP(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "magpie-tui-runtime:", err)
		os.Exit(1)
	}
}

func run(argv []string) error {
	fs := flag.NewFlagSet("magpie-tui-runtime", flag.ContinueOnError)
	var (
		serve        = fs.Bool("serve", false, "run the HTTP service")
		portFile     = fs.String("port-file", "", "write the bound port here")
		keyFile      = fs.String("key-file", "", "write the connection key here")
		modelsFile   = fs.String("models-file", "", "write the advertised models JSON here")
		stateDir     = fs.String("state-dir", "", "runtime state directory (default ~/.config/magpie-tui-runtime)")
		bridgePath   = fs.String("bridge", "", "claude-bridge PTY wrapper entrypoint (required for TUI runs)")
		helperBin    = fs.String("helper", "", "standalone MCP helper binary (default: this binary's claude-mcp-helper)")
		proxy        = fs.String("proxy", "", "proxy URL or 'direct' for Claude Code env")
		reuseKey     = fs.Bool("reuse-key", false, "reuse an existing --key-file (validated 0600 regular file, 64 hex bytes) instead of always generating fresh")
		claudeCfgDir = fs.String("claude-config-dir", "", "CLAUDE_CONFIG_DIR override for the native sign-in")
		modelsFlag   = fs.String("models", "", "comma-separated model ids to advertise (default: claude-tui)")
		exitOnEOF    = fs.Bool("exit-on-stdin-eof", false, "shut down when the owner closes stdin")
	)
	if err := fs.Parse(argv); err != nil {
		return err
	}
	if !*serve {
		return errors.New("expected --serve; run with --help for flags")
	}
	for _, f := range []string{*portFile, *keyFile, *modelsFile} {
		if strings.TrimSpace(f) == "" {
			return errors.New("--serve requires --port-file, --key-file and --models-file")
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *exitOnEOF {
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		defer cancel()
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			cancel()
		}()
	}

	state, err := resolveStateDir(*stateDir)
	if err != nil {
		return err
	}
	lock, err := lockRuntimeState(ctx, state)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	if err != nil {
		return err
	}
	defer lock.Close()

	// The state owner prepares the connection key before publishing readiness.
	keyHex, err := loadOrGenerateKey(*keyFile, *reuseKey)
	if err != nil {
		return err
	}

	models := map[string]string{}
	for _, id := range strings.Split(*modelsFlag, ",") {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		models[id] = id
	}
	if len(models) == 0 {
		models["claude-tui"] = "Claude TUI"
	}
	// helper invocation as explicit argv: the executable path may contain
	// spaces (macOS install dirs like "~/my magpie tui"), which a joined
	// "path arg" string cannot carry through mcpHelperCommand's Fields().
	var helperArgv []string
	if *helperBin != "" {
		helperArgv = []string{*helperBin}
	} else if exe, err := os.Executable(); err == nil {
		helperArgv = []string{exe, "claude-mcp-helper"}
	}

	bridge.Init(&bridge.Config{
		StateDir:        state,
		ClaudeConfigDir: *claudeCfgDir,
		BridgePath:      *bridgePath,
		HelperArgv:      helperArgv,
		Proxy:           *proxy,
		Models:          models,
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("bind loopback: %w", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	// Tell the callback URL builder where the runtime actually bound.
	bridge.SetCallbackPort(port)

	rt := bridge.NewRuntime([]byte(keyHex))
	srv := &http.Server{
		Handler:           rt.AdmissionHandler(),
		ReadHeaderTimeout: 10 * time.Second,
		// tool calls block while the caller runs them; no global idle
		// timeout, matching production's mux behavior.
	}

	// Handshake files: write the key first so a stale port never matches a
	// fresh key, then models, then the port last so a poller that sees the
	// port knows all three are committed.
	if err := writeFile600(*keyFile, []byte(keyHex)); err != nil {
		return err
	}
	modelsJSON, err := json.Marshal(map[string]any{
		"contract": contract,
		"models":   modelsJSONMap(models),
	})
	if err != nil {
		return err
	}
	if err := writeFile600(*modelsFile, modelsJSON); err != nil {
		return err
	}
	portText := fmt.Sprint(port)
	if err := writeFile600(*portFile, []byte(portText)); err != nil {
		return err
	}
	defer func() {
		if published, err := os.ReadFile(*portFile); err == nil && string(published) == portText {
			_ = os.Remove(*portFile)
		}
	}()

	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-served:
	}

	shutdown, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	runs, cancelRuns := context.WithTimeout(shutdown, 6*time.Second)
	rt.ShutdownContext(runs)
	cancelRuns()
	httpShutdown, cancelHTTP := context.WithTimeout(shutdown, 4*time.Second)
	defer cancelHTTP()
	if err := srv.Shutdown(httpShutdown); err != nil {
		_ = srv.Close()
		fmt.Fprintln(os.Stderr, "magpie-tui-runtime: HTTP shutdown:", err)
	}
	if errors.Is(serveErr, http.ErrServerClosed) {
		return nil
	}
	return serveErr
}

func resolveStateDir(path string) (string, error) {
	if path != "" {
		return path, nil
	}
	if configHome := os.Getenv("XDG_CONFIG_HOME"); filepath.IsAbs(configHome) {
		return filepath.Join(configHome, "magpie-tui-runtime"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "magpie-tui-runtime"), nil
}

func lockRuntimeState(ctx context.Context, state string) (*os.File, error) {
	if err := os.MkdirAll(state, 0o700); err != nil {
		return nil, fmt.Errorf("create Runtime state directory %q: %w", state, err)
	}
	path := filepath.Join(state, ".runtime.lock")
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open Runtime state lock %q: %w", path, err)
	}
	locked := false
	defer func() {
		if !locked {
			_ = file.Close()
		}
	}()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect Runtime state lock %q: %w", path, err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return nil, fmt.Errorf("Runtime state lock %q requires a regular 0600 file", path)
	}
	wait, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for wait.Err() == nil {
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		switch err {
		case nil:
			locked = true
			return file, nil
		case syscall.EINTR:
			continue
		case syscall.EWOULDBLOCK:
			select {
			case <-wait.Done():
			case <-tick.C:
			}
		default:
			return nil, fmt.Errorf("lock Runtime state directory %q: %w", state, err)
		}
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, fmt.Errorf("Runtime state directory %q is held by another Runtime", state)
}

func writeFile600(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// loadOrGenerateKey resolves the hex connection key the runtime serves
// with. Default (reuse=false) is the contract/v1 behavior: always fresh
// random. With reuse=true an existing key-file is validated and its exact
// bytes reused; a missing file is generated and stored atomically 0600;
// anything malformed or insecure is an error rather than a silent rotate.
func loadOrGenerateKey(path string, reuse bool) (string, error) {
	if reuse {
		return reuseOrGenerateKey(path)
	}
	return generateKey()
}

func generateKey() (string, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return "", err
	}
	return hex.EncodeToString(key), nil
}

func reuseOrGenerateKey(path string) (string, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		// First supervised launch: mint and store atomically 0600 so the
		// next restart reuses the same bytes.
		keyHex, err := generateKey()
		if err != nil {
			return "", err
		}
		if err := writeFile600(path, []byte(keyHex)); err != nil {
			return "", fmt.Errorf("store generated key file: %w", err)
		}
		return keyHex, nil
	}
	if err != nil {
		return "", fmt.Errorf("key file: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("key file %s is a symlink; refusing to reuse", path)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("key file %s is not a regular file; refusing to reuse", path)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return "", fmt.Errorf("key file %s mode %04o is not private (must be 0600 or stricter); refusing to reuse", path, perm)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read key file: %w", err)
	}
	keyHex := string(data)
	if len(keyHex) != 64 {
		return "", fmt.Errorf("key file %s holds %d bytes, expected exactly 64 hex chars; refusing to reuse", path, len(keyHex))
	}
	if _, err := hex.DecodeString(keyHex); err != nil {
		return "", fmt.Errorf("key file %s is not valid hex; refusing to reuse", path)
	}
	return keyHex, nil
}

func modelsJSONMap(models map[string]string) map[string]any {
	out := make(map[string]any, len(models))
	for id, name := range models {
		out[id] = map[string]any{"name": name}
	}
	return out
}
