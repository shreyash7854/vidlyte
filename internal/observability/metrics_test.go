package observability

import (
	"strings"
	"testing"
)

func TestObservability(t *testing.T) {
	t.Run("RedactURLQuery strips token and url params", func(t *testing.T) {
		input := "/hls/tv/1399/1/1/master.m3u8?token=super-secret-hmac-token-12345&other=safe"
		output := RedactURLQuery(input)

		if strings.Contains(output, "super-secret-hmac-token-12345") {
			t.Errorf("token was not redacted from URL: %s", output)
		}
		if !strings.Contains(output, "token=[REDACTED]") {
			t.Errorf("expected token=[REDACTED], got: %s", output)
		}
		if !strings.Contains(output, "other=safe") {
			t.Errorf("non-sensitive param was lost: %s", output)
		}

		proxyInput := "/proxy?url=https%3A%2F%2Fimg.animecurx.tech%2Ftest.m3u8&provider=evion"
		proxyOutput := RedactURLQuery(proxyInput)
		if strings.Contains(proxyOutput, "animecurx") {
			t.Errorf("upstream url was not redacted: %s", proxyOutput)
		}
		if !strings.Contains(proxyOutput, "url=[REDACTED]") {
			t.Errorf("expected url=[REDACTED], got: %s", proxyOutput)
		}
	})

	t.Run("Metrics atomic increments", func(t *testing.T) {
		m := &Metrics{}
		m.IncRequests()
		m.IncCacheHit()
		m.AddBytes(1024)
		m.RecordStatus(200)

		snap := m.Snapshot()
		if snap.TotalRequests != 1 || snap.ActiveRequests != 1 || snap.CacheHits != 1 || snap.BytesStreamed != 1024 || snap.Status2xx != 1 {
			t.Errorf("unexpected metrics snapshot: %+v", snap)
		}

		m.DecActive()
		if m.Snapshot().ActiveRequests != 0 {
			t.Errorf("expected 0 active requests after DecActive")
		}
	})
}
