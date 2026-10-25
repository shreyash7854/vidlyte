package tmdb

import (
	"context"
	"testing"
)

func TestSlugify(t *testing.T) {
	tests := []struct {
		title    string
		year     string
		expected string
	}{
		{"Make Me Tingle", "2026", "make-me-tingle-2026"},
		{"Game of Thrones", "2011", "game-of-thrones-2011"},
		{"Attack on Titan: The Final Season", "2020", "attack-on-titan-the-final-season-2020"},
		{"Spider-Man: No Way Home", "", "spider-man-no-way-home"},
		{"Already-Slugged", "", "already-slugged"},
	}

	for _, tc := range tests {
		got := Slugify(tc.title, tc.year)
		if got != tc.expected {
			t.Errorf("Slugify(%q, %q) = %q; want %q", tc.title, tc.year, got, tc.expected)
		}
	}
}

func TestIsNumeric(t *testing.T) {
	if !IsNumeric("1399") {
		t.Errorf("expected 1399 to be numeric")
	}
	if !IsNumeric("289423") {
		t.Errorf("expected 289423 to be numeric")
	}
	if IsNumeric("make-me-tingle-2026") {
		t.Errorf("expected make-me-tingle-2026 not to be numeric")
	}
	if IsNumeric("tv1399") {
		t.Errorf("expected tv1399 not to be numeric")
	}
}

func TestResolveSlug_AlreadySlug(t *testing.T) {
	resolver := NewSlugResolver("")
	ctx := context.Background()

	slug, err := resolver.ResolveSlug(ctx, "tv", "make-me-tingle-2026")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if slug != "make-me-tingle-2026" {
		t.Errorf("expected make-me-tingle-2026, got %q", slug)
	}

	slugPrefixed, err := resolver.ResolveSlug(ctx, "tv", "asianflix:make-me-tingle-2026")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if slugPrefixed != "make-me-tingle-2026" {
		t.Errorf("expected make-me-tingle-2026, got %q", slugPrefixed)
	}
}
