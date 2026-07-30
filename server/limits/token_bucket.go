package limits

import (
	"container/list"
	"math"
	"sync"
	"time"
)

type Result struct {
	OK         bool
	RetryAfter int
}

type bucket struct {
	key     string
	tokens  float64
	at      time.Time
	element *list.Element
}

type Pool struct {
	mu              sync.Mutex
	refillPerSecond float64
	burst           float64
	maxKeys         int
	now             func() time.Time
	buckets         map[string]*bucket
	order           *list.List
}

func NewPool(refillPerMinute, burst float64, maxKeys int) *Pool {
	if maxKeys < 1 {
		maxKeys = 10000
	}
	return &Pool{
		refillPerSecond: refillPerMinute / 60,
		burst:           burst,
		maxKeys:         maxKeys,
		now:             time.Now,
		buckets:         make(map[string]*bucket),
		order:           list.New(),
	}
}

func (pool *Pool) Consume(key string, cost float64) Result {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	now := pool.now()
	current := pool.buckets[key]
	if current == nil {
		if len(pool.buckets) >= pool.maxKeys {
			oldest := pool.order.Front()
			if oldest != nil {
				delete(pool.buckets, oldest.Value.(*bucket).key)
				pool.order.Remove(oldest)
			}
		}
		current = &bucket{key: key, tokens: pool.burst, at: now}
		current.element = pool.order.PushBack(current)
		pool.buckets[key] = current
	} else {
		pool.order.MoveToBack(current.element)
	}
	current.tokens = math.Min(pool.burst, current.tokens+now.Sub(current.at).Seconds()*pool.refillPerSecond)
	current.at = now
	if cost <= current.tokens {
		current.tokens -= cost
		return Result{OK: true}
	}
	retry := int(math.Ceil((cost - current.tokens) / pool.refillPerSecond))
	if retry < 1 {
		retry = 1
	}
	return Result{RetryAfter: retry}
}
