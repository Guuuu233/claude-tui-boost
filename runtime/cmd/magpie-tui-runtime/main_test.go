package main

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func writeKeyFile(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatalf("write key file: %v", err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatalf("chmod key file: %v", err)
	}
}

// Contract/v1 default: every start gets a fresh random key, even when a
// key-file already exists on disk.
func TestDefaultGeneratesFreshKeyEveryCall(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "key")

	existing := make([]byte, 32)
	for i := range existing {
		existing[i] = 0xAB
	}
	writeKeyFile(t, path, []byte(hex.EncodeToString(existing)), 0o600)

	k1, err := loadOrGenerateKey(path, false)
	if err != nil {
		t.Fatalf("first generate: %v", err)
	}
	k2, err := loadOrGenerateKey(path, false)
	if err != nil {
		t.Fatalf("second generate: %v", err)
	}
	if len(k1) != 64 || len(k2) != 64 {
		t.Fatalf("keys must be 64 hex chars, got %d / %d", len(k1), len(k2))
	}
	if k1 == k2 {
		t.Fatal("default mode returned the same key twice; must rotate")
	}
	if k1 == hex.EncodeToString(existing) {
		t.Fatal("default mode reused the existing key file; must stay fresh random")
	}
}

// First supervised launch with --reuse-key and no key-file: a key is
// generated and stored atomically at 0600 so later restarts can reuse it.
func TestReuseMissingFileGeneratesAndStores(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "key")

	k, err := loadOrGenerateKey(path, true)
	if err != nil {
		t.Fatalf("reuse on missing file: %v", err)
	}
	if len(k) != 64 {
		t.Fatalf("generated key must be 64 hex chars, got %d", len(k))
	}
	if _, err := hex.DecodeString(k); err != nil {
		t.Fatalf("generated key is not hex: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("stored key file missing: %v", err)
	}
	if string(data) != k {
		t.Fatal("stored key file does not match the returned key")
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("stat stored key: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("stored key mode = %04o, want 0600", info.Mode().Perm())
	}
	// Second call reuses the stored bytes.
	k2, err := loadOrGenerateKey(path, true)
	if err != nil {
		t.Fatalf("second reuse: %v", err)
	}
	if k2 != k {
		t.Fatal("restart did not reuse the stored key")
	}
}

// A valid existing key-file is reused byte-for-byte — the exact bytes the
// protocol session was established with.
func TestReuseExistingValidFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "key")
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	want := hex.EncodeToString(raw)
	writeKeyFile(t, path, []byte(want), 0o600)

	got, err := loadOrGenerateKey(path, true)
	if err != nil {
		t.Fatalf("reuse valid file: %v", err)
	}
	if got != want {
		t.Fatalf("reused key = %q, want %q", got, want)
	}
}

// 0400 is stricter than 0600 and must also be accepted.
func TestReuseStricterModeAccepted(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "key")
	raw := make([]byte, 32)
	want := hex.EncodeToString(raw)
	writeKeyFile(t, path, []byte(want), 0o400)

	got, err := loadOrGenerateKey(path, true)
	if err != nil {
		t.Fatalf("reuse 0400 file: %v", err)
	}
	if got != want {
		t.Fatalf("reused key = %q, want %q", got, want)
	}
}

// Malformed or insecure existing files are refused, never rotated over.
func TestReuseRefusesInvalidFiles(t *testing.T) {
	valid := make([]byte, 32)
	validHex := hex.EncodeToString(valid)

	cases := map[string]func(t *testing.T, path string){
		"group/world readable mode": func(t *testing.T, path string) {
			writeKeyFile(t, path, []byte(validHex), 0o644)
		},
		"wrong length": func(t *testing.T, path string) {
			writeKeyFile(t, path, []byte("abc123"), 0o600)
		},
		"non-hex 64 bytes": func(t *testing.T, path string) {
			bad := make([]byte, 64)
			for i := range bad {
				bad[i] = 'z'
			}
			writeKeyFile(t, path, bad, 0o600)
		},
		"trailing newline": func(t *testing.T, path string) {
			writeKeyFile(t, path, []byte(validHex+"\n"), 0o600)
		},
		"not a regular file": func(t *testing.T, path string) {
			if err := os.Mkdir(path, 0o700); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "key")
			setup(t, path)
			if _, err := loadOrGenerateKey(path, true); err == nil {
				t.Fatalf("expected refusal for %s", name)
			}
		})
	}
}

// A symlinked key-file is refused even when the target is a valid
// 0600 key — never follow attacker-controlled links.
func TestReuseRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real-key")
	raw := make([]byte, 32)
	writeKeyFile(t, real, []byte(hex.EncodeToString(raw)), 0o600)
	link := filepath.Join(dir, "key")
	if err := os.Symlink(real, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if _, err := loadOrGenerateKey(link, true); err == nil {
		t.Fatal("expected symlink key file to be refused")
	}
}
