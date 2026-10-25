package upstream

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"byse-resolver/internal/config"
	"byse-resolver/internal/parser"
)

var (
	ErrHostNotAllowed      = errors.New("upstream host is not in approved whitelist (SSRF blocked)")
	ErrPrivateIPBlocked    = errors.New("upstream resolves to private/internal IP address (SSRF blocked)")
	ErrMaxRedirectsExceeded = errors.New("upstream request exceeded maximum redirect count")
	ErrManifestTooLarge    = errors.New("upstream manifest exceeds maximum allowed size (2MB)")
)

const (
	maxManifestBytes = 2 * 1024 * 1024 // 2 MB limit for manifests
	maxRedirectCount = 5
)

// Client handles SSRF-protected, connection-pooled upstream fetches.
type Client struct {
	httpClient *http.Client
	cfg        *config.Config
}

// NewClient creates an SSRF-hardened upstream HTTP client.
func NewClient(cfg *config.Config) *Client {
	c := &Client{
		cfg: cfg,
	}

	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:        cfg.UpstreamMaxConns,
		MaxIdleConnsPerHost: cfg.UpstreamMaxConns / 2,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 5 * time.Second,
		DisableCompression:  true, // Preserve raw streams
	}

	c.httpClient = &http.Client{
		Transport: transport,
		Timeout:   cfg.UpstreamTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirectCount {
				return ErrMaxRedirectsExceeded
			}
			// Validate redirect destination
			return c.ValidateURL(req.URL)
		},
	}

	return c
}

// ValidateURL checks if a target URL is safe to fetch according to the SSRF policy.
func (c *Client) ValidateURL(u *url.URL) error {
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("unsupported URL scheme: %s", u.Scheme)
	}

	host := u.Hostname()
	if !c.cfg.IsHostApproved(host) {
		return fmt.Errorf("%w: %s", ErrHostNotAllowed, host)
	}

	// In non-dev, block private IP ranges (10.x, 192.168.x, 172.16-31.x, 169.254.x metadata)
	if c.cfg.Env == "production" {
		ip := net.ParseIP(host)
		if ip != nil && isPrivateOrLoopback(ip) {
			return fmt.Errorf("%w: %s", ErrPrivateIPBlocked, host)
		}
	}

	return nil
}

func isPrivateOrLoopback(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()
}

// FetchManifest retrieves a playlist with SSRF validation, header injection, and size bounding.
func (c *Client) FetchManifest(ctx context.Context, targetURL, provider string) (string, *url.URL, error) {
	u, err := url.Parse(targetURL)
	if err != nil {
		return "", nil, fmt.Errorf("malformed upstream URL: %w", err)
	}

	if err := c.ValidateURL(u); err != nil {
		return "", nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", nil, fmt.Errorf("failed to create upstream request: %w", err)
	}

	c.injectHeaders(req, provider)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", nil, fmt.Errorf("upstream manifest fetch failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("upstream returned status %d", resp.StatusCode)
	}

	// Read with strict limit to prevent memory exhaustion
	limitedReader := io.LimitReader(resp.Body, maxManifestBytes+1)
	bodyBytes, err := io.ReadAll(limitedReader)
	if err != nil {
		return "", nil, fmt.Errorf("error reading upstream manifest body: %w", err)
	}
	if int64(len(bodyBytes)) > maxManifestBytes {
		return "", nil, ErrManifestTooLarge
	}

	finalURL := resp.Request.URL
	if finalURL == nil {
		finalURL = u
	}

	return string(bodyBytes), finalURL, nil
}

// FetchResource streams a media segment, key, or auxiliary file with Range header forwarding.
func (c *Client) FetchResource(ctx context.Context, targetURL, provider, clientRange string) (*http.Response, error) {
	u, err := url.Parse(targetURL)
	if err != nil {
		return nil, fmt.Errorf("malformed upstream URL: %w", err)
	}

	if err := c.ValidateURL(u); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create upstream request: %w", err)
	}

	c.injectHeaders(req, provider)

	// Forward client range header if present (for seeking/partial content)
	if clientRange != "" {
		req.Header.Set("Range", clientRange)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("upstream resource fetch failed: %w", err)
	}

	return resp, nil
}

func (c *Client) injectHeaders(req *http.Request, provider string) {
	headers := parser.GetHeadersForProvider(provider, req.URL.String())
	req.Header.Set("User-Agent", headers.UserAgent)
	req.Header.Set("Origin", headers.Origin)
	req.Header.Set("Referer", headers.Referer)
	req.Header.Set("Accept", "*/*")
}
