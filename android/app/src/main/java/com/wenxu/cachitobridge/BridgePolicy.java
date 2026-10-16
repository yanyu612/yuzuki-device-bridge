package com.wenxu.cachitobridge;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/** Pure policy helpers, shared by the HTTP server and installation UI. */
final class BridgePolicy {
    static final long MAX_TIMEOUT_MS = 30 * 60 * 1000L;
    static final long MANUAL_TIMEOUT_MS = 30_000L;

    static String normalizeOrigin(String value) {
        try {
            URI uri = new URI(value == null ? "" : value.trim());
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost();
            if (!(scheme.equals("http") || scheme.equals("https")) || host == null
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                    || uri.getRawFragment() != null || uri.getPort() < -1 || uri.getPort() > 65535) {
                throw new IllegalArgumentException();
            }
            // Accept a pasted server URL and retain its origin only.
            String normalizedHost = host.toLowerCase(Locale.ROOT);
            int port = uri.getPort();
            if ((scheme.equals("http") && port == 80) || (scheme.equals("https") && port == 443)) port = -1;
            return scheme + "://" + normalizedHost + (port == -1 ? "" : ":" + port);
        } catch (Exception error) {
            throw new IllegalArgumentException("请输入完整酒馆地址，例如 http://127.0.0.1:8000");
        }
    }

    static boolean allowsOrigin(String configured, String origin) {
        // Native clients have no Origin, but still require the installation token.
        return origin == null || configured.equals(origin);
    }

    static boolean authenticated(String token, String authorization) {
        if (token == null || token.length() != 64 || authorization == null) return false;
        return MessageDigest.isEqual(("Bearer " + token).getBytes(StandardCharsets.UTF_8),
                authorization.getBytes(StandardCharsets.UTF_8));
    }

    static boolean validTimeout(long timeoutMs) {
        return timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS;
    }
}
