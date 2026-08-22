package feedback

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ChillHub/server/internal/adminutil"
)

// TestIsTruthy exercises exactly the spellings isTruthy accepts: "1" and any
// case of "true". Everything else — including "yes", "0", "false", "" and
// whitespace variants — must be rejected.
func TestIsTruthy(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"1", true},
		{"true", true},
		{"TRUE", true},
		{"True", true},
		{"tRuE", true},
		{"0", false},
		{"false", false},
		{"FALSE", false},
		{"", false},
		{"yes", false},
		{"on", false},
		{"2", false},
		{" 1", false},
		{"1 ", false},
		{"true ", false},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := isTruthy(tc.in); got != tc.want {
				t.Errorf("isTruthy(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// newTestHandlers returns Handlers rooted at a fresh temp dir, mirroring how
// the other adminapi packages set up httptest fixtures.
func newTestHandlers(t *testing.T) *Handlers {
	t.Helper()
	dir := t.TempDir()
	return New(dir)
}

func seedItem(t *testing.T, h *Handlers, it Item) {
	t.Helper()
	if err := os.MkdirAll(h.dir(), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := h.writeAll([]Item{it}); err != nil {
		t.Fatal(err)
	}
}

// TestMarkUnread mirrors MarkRead's setStatus wiring: POST with ?id sets the
// report's status back to "new", GET is rejected, and a missing id or unknown
// id both answer with an error instead of silently succeeding.
func TestMarkUnread(t *testing.T) {
	t.Run("flips status to new", func(t *testing.T) {
		h := newTestHandlers(t)
		seedItem(t, h, Item{ID: "abc", CreatedAt: "2026-01-01T00:00:00Z", Status: "read"})

		req := httptest.NewRequest(http.MethodPost, "/admin/feedback/markUnread?id=abc", nil)
		w := httptest.NewRecorder()
		h.MarkUnread(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
		}
		items, err := h.readAll()
		if err != nil {
			t.Fatal(err)
		}
		if len(items) != 1 || items[0].Status != "new" {
			t.Fatalf("items = %+v, want status=new", items)
		}
	})

	t.Run("rejects GET", func(t *testing.T) {
		h := newTestHandlers(t)
		seedItem(t, h, Item{ID: "abc", CreatedAt: "2026-01-01T00:00:00Z", Status: "read"})

		req := httptest.NewRequest(http.MethodGet, "/admin/feedback/markUnread?id=abc", nil)
		w := httptest.NewRecorder()
		h.MarkUnread(w, req)

		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", w.Code)
		}
	})

	t.Run("missing id is a bad request", func(t *testing.T) {
		h := newTestHandlers(t)
		req := httptest.NewRequest(http.MethodPost, "/admin/feedback/markUnread", nil)
		w := httptest.NewRecorder()
		h.MarkUnread(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
	})

	t.Run("unknown id is not found", func(t *testing.T) {
		h := newTestHandlers(t)
		seedItem(t, h, Item{ID: "abc", CreatedAt: "2026-01-01T00:00:00Z", Status: "read"})

		req := httptest.NewRequest(http.MethodPost, "/admin/feedback/markUnread?id=nope", nil)
		w := httptest.NewRecorder()
		h.MarkUnread(w, req)

		if w.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", w.Code)
		}
	})
}

// TestMarkUnreadPersistsAcrossReads confirms the write actually lands on
// disk (writeAll), not just in memory for the single request.
func TestMarkUnreadPersistsAcrossReads(t *testing.T) {
	h := newTestHandlers(t)
	seedItem(t, h, Item{ID: "abc", CreatedAt: "2026-01-01T00:00:00Z", Status: "read"})

	req := httptest.NewRequest(http.MethodPost, "/admin/feedback/markUnread?id=abc", nil)
	w := httptest.NewRecorder()
	h.MarkUnread(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}

	b, err := os.ReadFile(filepath.Join(h.dir(), "inbox.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"status": "new"`) {
		t.Fatalf("inbox.json does not show status new: %s", b)
	}
}

// Feedback rotation must bound the number of stored reports.
func TestPruneFeedbackItemsRotatesOldest(t *testing.T) {
	items := make([]Item, MaxItems+50)
	for i := range items {
		items[i] = Item{ID: adminutil.GenID(), Comment: "c"}
	}
	items[0].ID = "newest"
	out := Prune(items)
	if len(out) != MaxItems {
		t.Fatalf("expected %d items, got %d", MaxItems, len(out))
	}
	if out[0].ID != "newest" {
		t.Fatal("newest report was dropped")
	}
}
