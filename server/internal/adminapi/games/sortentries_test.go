package games

import "testing"

// TestSortEntries checks the pinned/order/gameID comparator documented on
// SortEntries: pinned entries first, then ascending Order, then ascending
// GameID as the final tiebreaker.
func TestSortEntries(t *testing.T) {
	cases := []struct {
		name  string
		in    []Entry
		wantIDs []string
	}{
		{
			name: "pinned before unpinned regardless of order",
			in: []Entry{
				{GameID: "zeta", Order: 0, Pinned: false},
				{GameID: "alpha", Order: 5, Pinned: true},
				{GameID: "beta", Order: 1, Pinned: false},
			},
			wantIDs: []string{"alpha", "zeta", "beta"},
		},
		{
			name: "within same pinned group, order wins",
			in: []Entry{
				{GameID: "c", Order: 2, Pinned: false},
				{GameID: "a", Order: 0, Pinned: false},
				{GameID: "b", Order: 1, Pinned: false},
			},
			wantIDs: []string{"a", "b", "c"},
		},
		{
			name: "tie on pinned and order falls back to gameID",
			in: []Entry{
				{GameID: "zzz", Order: 3, Pinned: false},
				{GameID: "aaa", Order: 3, Pinned: false},
				{GameID: "mmm", Order: 3, Pinned: false},
			},
			wantIDs: []string{"aaa", "mmm", "zzz"},
		},
		{
			name: "multiple pinned entries still ordered among themselves",
			in: []Entry{
				{GameID: "p2", Order: 2, Pinned: true},
				{GameID: "u1", Order: 0, Pinned: false},
				{GameID: "p1", Order: 1, Pinned: true},
			},
			wantIDs: []string{"p1", "p2", "u1"},
		},
		{
			name:    "empty input stays empty",
			in:      []Entry{},
			wantIDs: []string{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			SortEntries(tc.in)
			gotIDs := make([]string, len(tc.in))
			for i, e := range tc.in {
				gotIDs[i] = e.GameID
			}
			if len(gotIDs) != len(tc.wantIDs) {
				t.Fatalf("length mismatch: got %v want %v", gotIDs, tc.wantIDs)
			}
			for i := range gotIDs {
				if gotIDs[i] != tc.wantIDs[i] {
					t.Fatalf("order mismatch at %d: got %v want %v", i, gotIDs, tc.wantIDs)
				}
			}
		})
	}
}
