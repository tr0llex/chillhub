package builds

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// kindUploadRequest is uploadRequest with a caller-chosen kind/gameId, needed
// here because uploadRequest hardcodes kind=game.
func kindUploadRequest(t *testing.T, kind, gid, ver string, zipData []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("kind", kind)
	_ = mw.WriteField("gameId", gid)
	_ = mw.WriteField("version", ver)
	fw, err := mw.CreateFormFile("zip", "build.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(zipData); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://example.com/admin/api/upload", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

// TestLauncherReuploadUnderSameVersionRejected reproduces, at the HTTP layer,
// the 2026-08-08 incident: the same launcher version uploaded a second time
// with different content. This must now be refused, and — the part that
// actually matters — the FIRST upload's content must survive untouched: a
// client that already reads "1.3.2" as fixed content is not allowed to have
// that content silently swapped out from under it.
func TestLauncherReuploadUnderSameVersionRejected(t *testing.T) {
	root := t.TempDir()
	h := New(root)

	w1 := httptest.NewRecorder()
	h.Upload(w1, kindUploadRequest(t, "launcher", "launcher", "1.3.2", zipBytes(t, map[string]string{
		"ChillHub.exe": "first build",
	})))
	if w1.Code != http.StatusOK {
		t.Fatalf("first upload: %d %s", w1.Code, w1.Body.String())
	}

	w2 := httptest.NewRecorder()
	h.Upload(w2, kindUploadRequest(t, "launcher", "launcher", "1.3.2", zipBytes(t, map[string]string{
		"ChillHub.exe": "second, different build",
	})))
	if w2.Code != http.StatusConflict {
		t.Fatalf("second upload under the same version: got %d %s, want %d", w2.Code, w2.Body.String(), http.StatusConflict)
	}

	got, err := os.ReadFile(filepath.Join(root, "content", "launcher", "1.3.2", "files", "ChillHub.exe"))
	if err != nil {
		t.Fatalf("original content missing after rejected re-upload: %v", err)
	}
	if string(got) != "first build" {
		t.Fatalf("content = %q, want the first upload untouched (%q)", got, "first build")
	}
}

// TestGameReuploadUnderSameVersionStillAllowed pins the boundary of the guard:
// it is scoped to gid=="launcher" only. Games keep the pre-existing "same
// version, new content" workflow — the 2026-08-08 incident was specific to
// self-update comparing version strings, and nothing about that applies here.
func TestGameReuploadUnderSameVersionStillAllowed(t *testing.T) {
	root := t.TempDir()
	h := New(root)

	w1 := httptest.NewRecorder()
	h.Upload(w1, kindUploadRequest(t, "game", "game", "1.0.0", zipBytes(t, map[string]string{"a.txt": "first"})))
	if w1.Code != http.StatusOK {
		t.Fatalf("first upload: %d %s", w1.Code, w1.Body.String())
	}

	w2 := httptest.NewRecorder()
	h.Upload(w2, kindUploadRequest(t, "game", "game", "1.0.0", zipBytes(t, map[string]string{"a.txt": "second"})))
	if w2.Code != http.StatusOK {
		t.Fatalf("re-upload of a game under the same version must still succeed: %d %s", w2.Code, w2.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(root, "content", "game", "1.0.0", "files", "a.txt"))
	if err != nil {
		t.Fatalf("read republished content: %v", err)
	}
	if string(got) != "second" {
		t.Fatalf("content = %q, want the re-upload to have replaced it (%q)", got, "second")
	}
}

// TestUploadInitRefusesAlreadyPublishedLauncherVersion checks the chunked
// entry point separately: it has its own copy of the guard (see
// launcherVersionAlreadyPublished's call sites) so that a chunked re-upload
// is refused before the client spends any bandwidth on it, not just after.
func TestUploadInitRefusesAlreadyPublishedLauncherVersion(t *testing.T) {
	root := t.TempDir()
	h := New(root)
	h.CurrentUser = func(*http.Request) string { return "admin" }

	w1 := httptest.NewRecorder()
	h.Upload(w1, kindUploadRequest(t, "launcher", "launcher", "1.3.2", zipBytes(t, map[string]string{
		"ChillHub.exe": "already published",
	})))
	if w1.Code != http.StatusOK {
		t.Fatalf("seed upload: %d %s", w1.Code, w1.Body.String())
	}

	initBody, err := json.Marshal(struct {
		Kind      string `json:"kind"`
		GameID    string `json:"gameId"`
		Version   string `json:"version"`
		ZipName   string `json:"zipName"`
		TotalSize int64  `json:"totalSize"`
	}{"launcher", "launcher", "1.3.2", "build.zip", 1024})
	if err != nil {
		t.Fatalf("marshal init body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://example.com/admin/api/upload/init", bytes.NewReader(initBody))
	w2 := httptest.NewRecorder()
	h.UploadInit(w2, req)
	if w2.Code != http.StatusConflict {
		t.Fatalf("UploadInit for an already-published launcher version: got %d %s, want %d", w2.Code, w2.Body.String(), http.StatusConflict)
	}
}

// TestUploadStreamRefusesAlreadyPublishedLauncherVersion is the streaming
// upload's own copy of the same guard (see launcherVersionAlreadyPublished's
// call sites). The zip part comes first over the wire, so by the time the
// handler can even see gameId/version the zipSaved event is already flushed —
// the rejection has to travel as an NDJSON error event, not an http.Error.
func TestUploadStreamRefusesAlreadyPublishedLauncherVersion(t *testing.T) {
	root := t.TempDir()
	h := New(root)
	h.CurrentUser = func(*http.Request) string { return "admin" }

	w1 := httptest.NewRecorder()
	h.Upload(w1, kindUploadRequest(t, "launcher", "launcher", "1.3.2", zipBytes(t, map[string]string{
		"ChillHub.exe": "already published",
	})))
	if w1.Code != http.StatusOK {
		t.Fatalf("seed upload: %d %s", w1.Code, w1.Body.String())
	}

	w2 := httptest.NewRecorder()
	h.UploadStream(w2, streamUploadRequest(t,
		map[string]string{"kind": "launcher", "gameId": "launcher", "version": "1.3.2"},
		zipBytes(t, map[string]string{"ChillHub.exe": "second, different build"})))

	events, garbage := ndjsonEvents(t, w2.Body.String())
	if len(garbage) > 0 {
		t.Fatalf("plain text in the NDJSON stream: %q", garbage)
	}
	if !hasErrorEvent(events) {
		t.Fatalf("no error event for a re-upload under the same version: %s", w2.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(root, "content", "launcher", "1.3.2", "files", "ChillHub.exe"))
	if err != nil {
		t.Fatalf("original content missing after rejected re-upload: %v", err)
	}
	if string(got) != "already published" {
		t.Fatalf("content = %q, want the first upload untouched", got)
	}
}

// TestUploadProcessStreamRefusesAlreadyPublishedLauncherVersion covers the
// race UploadInit's own guard cannot: a chunked upload starts while "1.3.2"
// is still unpublished (so Init lets it through), and only becomes a conflict
// once another publish — plain or chunked — lands before this one reaches
// process. The comment on that call site says exactly this is why it exists;
// this test is what makes that claim true rather than aspirational.
func TestUploadProcessStreamRefusesAlreadyPublishedLauncherVersion(t *testing.T) {
	h, root := adminHandlers(t)
	zipData := zipBytes(t, map[string]string{"ChillHub.exe": "in-flight chunked build"})

	id, _ := initUpload(t, h, fmt.Sprintf(
		`{"kind":"launcher","gameId":"launcher","version":"1.3.2","zipName":"b.zip","totalSize":%d,"chunkSize":65536}`,
		len(zipData)))

	// Someone else published "1.3.2" while this chunked upload was already in
	// flight — the exact race UploadInit's own check cannot see.
	wPublish := httptest.NewRecorder()
	h.Upload(wPublish, kindUploadRequest(t, "launcher", "launcher", "1.3.2", zipBytes(t, map[string]string{
		"ChillHub.exe": "published while the chunked upload was in flight",
	})))
	if wPublish.Code != http.StatusOK {
		t.Fatalf("racing publish: %d %s", wPublish.Code, wPublish.Body.String())
	}

	if w := putChunk(t, h, id, 0, zipData); w.Code != http.StatusOK {
		t.Fatalf("chunk: %d %s", w.Code, w.Body.String())
	}
	if w := completeUpload(t, h, id); w.Code != http.StatusOK {
		t.Fatalf("complete: %d %s", w.Code, w.Body.String())
	}

	w := processUpload(t, h, id)
	events, garbage := ndjsonEvents(t, w.Body.String())
	if len(garbage) > 0 {
		t.Fatalf("plain text in the NDJSON stream: %q", garbage)
	}
	if !hasErrorEvent(events) {
		t.Fatalf("no error event for a process racing a publish under the same version: %s", w.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(root, "content", "launcher", "1.3.2", "files", "ChillHub.exe"))
	if err != nil {
		t.Fatalf("winning publish's content missing: %v", err)
	}
	if string(got) != "published while the chunked upload was in flight" {
		t.Fatalf("content = %q, want the racing publish's content untouched by the losing process", got)
	}
}

// TestActivateLauncherDoesNotBlockOnNotify exercises the notify call site
// Activate gained for gid=="launcher": it must not hang or fail the request
// even when there is nothing at DEPLOY_KIT_NOTIFY_SCRIPT to run — the case
// notifyPublished's own tests already cover, wired up here through the
// handler that actually calls it, on the code path an operator uses for real.
func TestActivateLauncherDoesNotBlockOnNotify(t *testing.T) {
	root := t.TempDir()
	h := New(root)

	w1 := httptest.NewRecorder()
	h.Upload(w1, kindUploadRequest(t, "launcher", "launcher", "1.3.2", zipBytes(t, map[string]string{
		"ChillHub.exe": "build",
	})))
	if w1.Code != http.StatusOK {
		t.Fatalf("seed upload: %d %s", w1.Code, w1.Body.String())
	}

	req := httptest.NewRequest(http.MethodPost, "http://example.com/admin/api/activate?gameId=launcher&version=1.3.2", nil)
	w2 := httptest.NewRecorder()
	h.Activate(w2, req)
	if w2.Code != http.StatusOK {
		t.Fatalf("activate: %d %s", w2.Code, w2.Body.String())
	}

	b, err := os.ReadFile(filepath.Join(root, "manifests", "launcher", "latest.json"))
	if err != nil {
		t.Fatalf("latest.json not written: %v", err)
	}
	var latest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(b, &latest); err != nil {
		t.Fatalf("latest.json: %v", err)
	}
	if latest.Version != "1.3.2" {
		t.Fatalf("latest.json version = %q, want 1.3.2", latest.Version)
	}
}
