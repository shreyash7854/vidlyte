# ==============================================================================
# Multi-Stage Production Dockerfile for VidLyte High-Performance HLS Gateway
# ==============================================================================

# Build Stage
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Copy module definition
COPY go.mod ./
RUN go mod download

# Copy source code and data files
COPY . .

# Compile static binary with zero external dependencies
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o vidlyte .

# Runtime Stage
FROM alpine:3.20

RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/vidlyte /app/vidlyte

# Copy persistent configuration and assets
COPY --from=builder /app/data /app/data
COPY --from=builder /app/internal/embed/player.html /app/internal/embed/player.html
COPY --from=builder /app/internal/admin/admin.html /app/internal/admin/admin.html
COPY --from=builder /app/internal/portal/index.html /app/internal/portal/index.html

# Expose core hub port
EXPOSE 8080

# Environment defaults
ENV PORT=8080
ENV ENV=production
ENV LOG_LEVEL=info
ENV PLAYER_PORT=none

# Run VidLyte
ENTRYPOINT ["/app/vidlyte"]
