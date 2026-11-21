package main

import (
	"encoding/json"
	"net/url"
	"strings"
	"time"
	"unsafe"

	"byse-resolver/internal/hls"
	"byse-resolver/internal/parser"
	"byse-resolver/internal/session"
)

const (
	ArenaSize = 4 * 1024 * 1024 // 4 MB arena buffer for manifest rewrites & crypto operations
)

var (
	arenaBuffer  [ArenaSize]byte
	outputOffset int32
	outputLen    int32
)

//go:wasmexport get_arena_ptr
func getArenaPtr() uintptr {
	return uintptr(unsafe.Pointer(&arenaBuffer[0]))
}

//go:wasmexport get_output_offset
func getOutputOffset() int32 {
	return outputOffset
}

//go:wasmexport get_output_len
func getOutputLen() int32 {
	return outputLen
}

func readString(offset, length int32) string {
	if offset < 0 || length <= 0 || int(offset+length) > len(arenaBuffer) {
		return ""
	}
	return string(arenaBuffer[offset : offset+length])
}

func readBytes(offset, length int32) []byte {
	if offset < 0 || length <= 0 || int(offset+length) > len(arenaBuffer) {
		return nil
	}
	return arenaBuffer[offset : offset+length]
}

func writeOutput(data []byte) int32 {
	// Place output at 2MB offset to avoid collisions with inputs
	outStart := int32(2 * 1024 * 1024)
	if len(data) > int(ArenaSize-outStart) {
		outputOffset = 0
		outputLen = 0
		return -1
	}
	copy(arenaBuffer[outStart:], data)
	outputOffset = outStart
	outputLen = int32(len(data))
	return outputLen
}

//go:wasmexport issue_token
func issueToken(assetOff, assetLen, ipOff, ipLen, ttlSec, keyOff, keyLen int32) int32 {
	assetID := readString(assetOff, assetLen)
	clientIP := readString(ipOff, ipLen)
	key := readBytes(keyOff, keyLen)
	if len(key) == 0 {
		key = []byte("vidlyte-default-edge-key-32b-secret")
	}

	keys := map[string][]byte{"k1": key}
	mgr, err := session.NewManager(keys, "k1", time.Duration(ttlSec)*time.Second)
	if err != nil {
		return -1
	}

	var token string
	if clientIP == "" || clientIP == "127.0.0.1" || clientIP == "::1" || clientIP == "none" {
		token, err = mgr.IssueToken(assetID, time.Duration(ttlSec)*time.Second)
	} else {
		token, err = mgr.IssueTokenForClient(assetID, clientIP, time.Duration(ttlSec)*time.Second)
	}
	if err != nil {
		return -1
	}

	return writeOutput([]byte(token))
}

//go:wasmexport verify_token
func verifyToken(assetOff, assetLen, ipOff, ipLen, tokenOff, tokenLen, keyOff, keyLen int32) int32 {
	assetID := readString(assetOff, assetLen)
	clientIP := readString(ipOff, ipLen)
	token := readString(tokenOff, tokenLen)
	key := readBytes(keyOff, keyLen)
	if len(key) == 0 {
		key = []byte("vidlyte-default-edge-key-32b-secret")
	}

	keys := map[string][]byte{"k1": key}
	mgr, err := session.NewManager(keys, "k1", 15*time.Minute)
	if err != nil {
		return 0
	}

	claims, err := mgr.ValidateTokenForClient(token, assetID, clientIP)
	if err != nil || claims == nil {
		return 0
	}
	return 1
}

//go:wasmexport rewrite_manifest
func rewriteManifest(
	m3u8Off, m3u8Len,
	baseOff, baseLen,
	assetOff, assetLen,
	tokenOff, tokenLen,
	proxyBaseOff, proxyBaseLen,
	providerOff, providerLen int32,
) int32 {
	m3u8Content := readString(m3u8Off, m3u8Len)
	baseURLStr := readString(baseOff, baseLen)
	assetID := readString(assetOff, assetLen)
	token := readString(tokenOff, tokenLen)
	proxyBase := readString(proxyBaseOff, proxyBaseLen)
	provider := readString(providerOff, providerLen)

	if proxyBase == "" {
		proxyBase = "/proxy?url="
	}

	var parsedBase *url.URL
	if baseURLStr != "" {
		parsedBase, _ = url.Parse(baseURLStr)
	}

	rewriter := hls.NewRewriter()
	registrar := func(aID, upstreamURI string) string {
		return url.QueryEscape(upstreamURI)
	}

	router := func(aID, upstreamURI string) string {
		// Route media chunk to Cloudflare edge proxy
		return proxyBase + url.QueryEscape(upstreamURI) + "&provider=" + provider
	}

	rewritten, err := rewriter.RewritePlaylistWithRouter(m3u8Content, parsedBase, assetID, token, registrar, router)
	if err != nil {
		return -1
	}

	return writeOutput([]byte(rewritten))
}

//go:wasmexport extract_vidrift_html
func extractVidriftHTML(htmlOff, htmlLen int32) int32 {
	htmlData := readBytes(htmlOff, htmlLen)
	meta, err := parser.ExtractEmbedMeta(htmlData)
	if err != nil || meta == nil {
		return -1
	}

	outJSON, err := json.Marshal(meta)
	if err != nil {
		return -1
	}

	return writeOutput(outJSON)
}

//go:wasmexport extract_media_details
func extractMediaDetails(htmlOff, htmlLen int32) int32 {
	htmlData := readBytes(htmlOff, htmlLen)
	details := parser.ExtractMediaDetails(htmlData)
	outJSON, err := json.Marshal(details)
	if err != nil {
		return -1
	}
	return writeOutput(outJSON)
}

//go:wasmexport sniff_media_type
// Returns: 1 = video/mp2t (MPEG-TS, 0x47), 2 = video/mp4 (ftyp), 3 = audio/aac (ADTS), 4 = text/vtt, 5 = mpegurl, 0 = unknown
func sniffMediaType(chunkOff, chunkLen int32) int32 {
	b := readBytes(chunkOff, chunkLen)
	if len(b) == 0 {
		return 0
	}
	if len(b) >= 7 && string(b[:7]) == "#EXTM3U" {
		return 5
	}
	if len(b) >= 6 && string(b[:6]) == "WEBVTT" {
		return 4
	}
	if b[0] == 0x47 {
		return 1
	}
	if len(b) >= 8 && string(b[4:8]) == "ftyp" {
		return 2
	}
	if len(b) >= 2 && b[0] == 0xff && (b[1]&0xf6) == 0xf0 {
		return 3
	}
	return 0
}

//go:wasmexport sanitize_tags
// High-performance byte-level scrubbing of upstream server brand tags from titles & subtitles
func sanitizeTags(textOff, textLen int32) int32 {
	s := readString(textOff, textLen)
	if s == "" {
		return 0
	}
	brands := []string{
		"Vidrift", "vidrift", "VIDRIFT",
		"Orion", "orion", "ORION",
		"Evion", "evion", "EVION",
		"FrameX", "framex", "FRAMEX",
		"AsianFlix", "asianflix", "ASIANFLIX",
		"Rumble", "rumble", "RUMBLE",
		"Cinejoy", "cinejoy", "CINEJOY",
		"Titan", "titan", "TITAN",
		"Atlas", "atlas", "ATLAS",
		"Vela", "vela", "VELA",
	}
	for _, b := range brands {
		s = strings.ReplaceAll(s, " · "+b, "")
		s = strings.ReplaceAll(s, " - "+b, "")
		s = strings.ReplaceAll(s, " ("+b+")", "")
		s = strings.ReplaceAll(s, " ("+b+" Vidrift)", "")
		s = strings.ReplaceAll(s, " ("+b+" Fast Edge)", "")
		s = strings.ReplaceAll(s, b, "")
	}
	s = strings.TrimSpace(s)
	return writeOutput([]byte(s))
}

func main() {
	select {}
}
