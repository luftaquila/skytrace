package limits

import (
	"testing"
	"time"
)

func TestPoolEvictsLeastRecentlyUsedKey(t *testing.T) {
	now := time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC)
	pool := NewPool(60, 1, 2)
	pool.now = func() time.Time { return now }

	if !pool.Consume("first", 1).OK || !pool.Consume("second", 1).OK {
		t.Fatal("initial buckets were rejected")
	}
	if pool.Consume("first", 1).OK {
		t.Fatal("touching an empty bucket unexpectedly succeeded")
	}
	if !pool.Consume("third", 1).OK {
		t.Fatal("third bucket was rejected")
	}
	if _, exists := pool.buckets["second"]; exists {
		t.Fatal("least recently used bucket was not evicted")
	}
	if !pool.Consume("second", 1).OK {
		t.Fatal("evicted key did not receive a fresh bucket")
	}
	if _, exists := pool.buckets["first"]; exists {
		t.Fatal("next least recently used bucket was not evicted")
	}
}

func TestPoolRefillAndRetryAfter(t *testing.T) {
	now := time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC)
	pool := NewPool(60, 1, 1)
	pool.now = func() time.Time { return now }

	if !pool.Consume("key", 1).OK {
		t.Fatal("initial token was rejected")
	}
	if result := pool.Consume("key", 1); result.OK || result.RetryAfter != 1 {
		t.Fatalf("depleted result = %#v", result)
	}
	now = now.Add(time.Second)
	if !pool.Consume("key", 1).OK {
		t.Fatal("refilled token was rejected")
	}
}
