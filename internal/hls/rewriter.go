package hls

import (
	"bufio"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

var (
	ErrNotHLS = errors.New("content is not a valid HLS playlist (missing #EXTM3U header)")
)

// ResourceRegistrar is a callback that records an upstream URI and returns an opaque resource ID.
type ResourceRegistrar func(assetID, upstreamURI string) string

// SegmentRouter resolves an upstream media segment URL to a proxied edge destination.
type SegmentRouter func(assetID, upstreamURI string) string

// Rewriter parses RFC 8216 playlists line-by-line and safely rewrites all URI references to gateway URLs.
type Rewriter struct{}

// NewRewriter creates a new HLS Rewriter.
func NewRewriter() *Rewriter {
	return &Rewriter{}
}

// RewritePlaylist parses and rewrites a master or media playlist with standard gateway resource mapping.
func (rw *Rewriter) RewritePlaylist(content string, playlistURL *url.URL, assetID string, token string, register ResourceRegistrar) (string, error) {
	return rw.RewritePlaylistWithRouter(content, playlistURL, assetID, token, register, nil)
}

// RewritePlaylistWithRouter parses and rewrites playlist URIs, allowing media segments to route directly via an edge router.
func (rw *Rewriter) RewritePlaylistWithRouter(content string, playlistURL *url.URL, assetID string, token string, register ResourceRegistrar, router SegmentRouter) (string, error) {
	trimmedContent := strings.TrimSpace(content)
	if !strings.HasPrefix(trimmedContent, "#EXTM3U") {
		return "", ErrNotHLS
	}

	var sb strings.Builder
	sb.Grow(len(content) + 1024)

	scanner := bufio.NewScanner(strings.NewReader(content))
	var prevLine string

	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)

		if trimmed == "" {
			sb.WriteString(line)
			sb.WriteByte('\n')
			prevLine = trimmed
			continue
		}

		if strings.HasPrefix(trimmed, "#") {
			// Handle specific URI-bearing tags
			if strings.HasPrefix(trimmed, "#EXT-X-MEDIA:") {
				rewritten := rw.rewriteTagAttributeURI(trimmed, "URI", playlistURL, assetID, token, register, router)
				sb.WriteString(rewritten)
			} else if strings.HasPrefix(trimmed, "#EXT-X-MAP:") {
				rewritten := rw.rewriteTagAttributeURI(trimmed, "URI", playlistURL, assetID, token, register, router)
				sb.WriteString(rewritten)
			} else if strings.HasPrefix(trimmed, "#EXT-X-KEY:") {
				rewritten := rw.rewriteTagAttributeURI(trimmed, "URI", playlistURL, assetID, token, register, nil)
				sb.WriteString(rewritten)
			} else {
				// Standard tag, keep as-is
				sb.WriteString(line)
			}
		} else {
			// This is a URI line (either a stream variant in a master playlist, or a media segment in a media playlist)
			fullURI := resolveURI(playlistURL, trimmed)

			// If this line is a media chunk (not a nested .m3u8 playlist) and an edge router is provided:
			if router != nil && !isPlaylistURI(fullURI) {
				edgeURL := router(assetID, fullURI)
				if edgeURL != "" {
					sb.WriteString(edgeURL)
					sb.WriteByte('\n')
					prevLine = trimmed
					continue
				}
			}

			resourceID := register(assetID, fullURI)
			gatewayURI := fmt.Sprintf("/hls/%s/resource/%s?token=%s", assetID, resourceID, token)
			sb.WriteString(gatewayURI)
		}

		sb.WriteByte('\n')
		prevLine = trimmed
	}

	_ = prevLine
	return sb.String(), nil
}

// rewriteTagAttributeURI parses an attribute list in a tag and rewrites a specific URI attribute.
func (rw *Rewriter) rewriteTagAttributeURI(tagLine, attrName string, playlistURL *url.URL, assetID, token string, register ResourceRegistrar, router SegmentRouter) string {
	colonIdx := strings.IndexByte(tagLine, ':')
	if colonIdx == -1 {
		return tagLine
	}

	tagPrefix := tagLine[:colonIdx+1]
	attrStr := tagLine[colonIdx+1:]

	attrs := parseAttributes(attrStr)
	var newAttrs []string

	for _, attr := range attrs {
		if attr.key == attrName && attr.quoted {
			fullURI := resolveURI(playlistURL, attr.val)
			if router != nil && !isPlaylistURI(fullURI) {
				edgeURL := router(assetID, fullURI)
				if edgeURL != "" {
					newAttrs = append(newAttrs, fmt.Sprintf("%s=%q", attr.key, edgeURL))
					continue
				}
			}

			resourceID := register(assetID, fullURI)
			gatewayURI := fmt.Sprintf("/hls/%s/resource/%s?token=%s", assetID, resourceID, token)
			newAttrs = append(newAttrs, fmt.Sprintf("%s=%q", attr.key, gatewayURI))
		} else if attr.quoted {
			newAttrs = append(newAttrs, fmt.Sprintf("%s=%q", attr.key, attr.val))
		} else {
			newAttrs = append(newAttrs, fmt.Sprintf("%s=%s", attr.key, attr.val))
		}
	}

	return tagPrefix + strings.Join(newAttrs, ",")
}

type attribute struct {
	key    string
	val    string
	quoted bool
}

// parseAttributes safely parses RFC 8216 comma-separated attribute lists with quoted-string support.
func parseAttributes(attrStr string) []attribute {
	var results []attribute
	runes := []rune(attrStr)
	n := len(runes)

	i := 0
	for i < n {
		// Skip commas and whitespace
		for i < n && (runes[i] == ',' || runes[i] == ' ' || runes[i] == '\t') {
			i++
		}
		if i >= n {
			break
		}

		// Read key
		keyStart := i
		for i < n && runes[i] != '=' && runes[i] != ',' {
			i++
		}
		key := strings.TrimSpace(string(runes[keyStart:i]))

		if i >= n || runes[i] != '=' {
			// Malformed key without value, store key
			if key != "" {
				results = append(results, attribute{key: key, val: "", quoted: false})
			}
			continue
		}
		i++ // skip '='

		// Read value
		if i < n && runes[i] == '"' {
			// Quoted string
			i++ // skip opening quote
			valStart := i
			for i < n && runes[i] != '"' {
				if runes[i] == '\\' && i+1 < n {
					i += 2 // skip escape sequence
					continue
				}
				i++
			}
			val := string(runes[valStart:i])
			if i < n && runes[i] == '"' {
				i++ // skip closing quote
			}
			results = append(results, attribute{key: key, val: val, quoted: true})
		} else {
			// Unquoted value
			valStart := i
			for i < n && runes[i] != ',' {
				i++
			}
			val := strings.TrimSpace(string(runes[valStart:i]))
			results = append(results, attribute{key: key, val: val, quoted: false})
		}
	}

	return results
}

func resolveURI(base *url.URL, ref string) string {
	if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") {
		return ref
	}
	if base == nil {
		return ref
	}

	refURL, err := url.Parse(ref)
	if err != nil {
		return ref
	}

	return base.ResolveReference(refURL).String()
}

func isPlaylistURI(rawURI string) bool {
	lower := strings.ToLower(rawURI)
	parsed, err := url.Parse(lower)
	if err == nil {
		if strings.HasSuffix(parsed.Path, ".m3u8") {
			return true
		}
	}
	return strings.Contains(lower, ".m3u8")
}
