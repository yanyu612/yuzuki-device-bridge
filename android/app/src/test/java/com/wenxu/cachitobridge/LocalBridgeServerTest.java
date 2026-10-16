package com.wenxu.cachitobridge;

import static org.junit.Assert.*;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;

/** Real loopback HTTP, with a fake device handler. Never touches Bluetooth. */
public final class LocalBridgeServerTest {
    private final String token = "a".repeat(64);
    private int powers, stops;
    private LocalBridgeServer server;

    @Before public void start() throws Exception {
        powers = stops = 0;
        server = new LocalBridgeServer(new LocalBridgeServer.Handler() {
            public JSONObject status() {
                try { return new JSONObject().put("ok", true).put("apiVersion", 2); }
                catch (org.json.JSONException error) { throw new AssertionError(error); }
            }
            public String token() { return token; }
            public String allowedOrigin() { return "http://127.0.0.1:8000"; }
            public boolean setPower(int power, long timeout, boolean startNew) { powers++; return true; }
            public void stopDevice() { stops++; }
            public void onServerError(String text) { throw new AssertionError(text); }
        });
        server.start();
    }
    @After public void close() { if (server != null) server.stop(); }

    private String request(String method, String path, String headers, String body) throws Exception {
        try (Socket socket = new Socket("127.0.0.1", 8765)) {
            socket.setSoTimeout(4000);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            String head = method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1:8765\r\n"
                    + headers + "Content-Length: " + bytes.length + "\r\n\r\n";
            socket.getOutputStream().write(head.getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().write(bytes);
            socket.getOutputStream().flush();
            ByteArrayOutputStream result = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            for (int n; (n = socket.getInputStream().read(buffer)) != -1;) result.write(buffer, 0, n);
            return result.toString(StandardCharsets.UTF_8.name());
        }
    }
    private String auth() { return "Authorization: Bearer " + token + "\r\nContent-Type: application/json\r\n"; }
    private String body(String power, String timeout) {
        return "{\"power\":" + power + ",\"timeoutMs\":" + timeout + ",\"startNew\":true,\"profileId\":\"cachito-id36\"}";
    }

    @Test public void rejectsOldUnauthenticatedControlAndStatus() throws Exception {
        assertTrue(request("POST", "/v1/suction", "X-Cachito-Bridge: yuzuki-v1\r\n", body("10", "1000")).startsWith("HTTP/1.1 401"));
        assertTrue(request("GET", "/v1/status", "", "").startsWith("HTTP/1.1 401"));
        assertEquals(0, powers);
    }
    @Test public void checksOriginBeforeAcceptingAnyControl() throws Exception {
        String result = request("POST", "/v1/suction", auth() + "Origin: https://attacker.invalid\r\n", body("10", "1000"));
        assertTrue(result.startsWith("HTTP/1.1 403"));
        assertFalse(result.contains("Access-Control-Allow-Origin"));
        assertEquals(0, powers);
    }
    @Test public void preflightRequiresAllowedOriginButNoToken() throws Exception {
        String result = request("OPTIONS", "/v1/suction", "Origin: http://127.0.0.1:8000\r\n", "");
        assertTrue(result.startsWith("HTTP/1.1 204"));
        assertTrue(result.contains("Access-Control-Allow-Headers: Content-Type, Authorization"));
        assertEquals(0, powers);
    }
    @Test public void acceptsAuthenticatedStatusAndBoundedCommandAndStop() throws Exception {
        assertTrue(request("GET", "/v1/status", auth(), "").startsWith("HTTP/1.1 200"));
        assertTrue(request("POST", "/v1/suction", auth(), body("10", "1000")).startsWith("HTTP/1.1 200"));
        assertTrue(request("POST", "/v1/stop", auth(), "").startsWith("HTTP/1.1 200"));
        assertEquals(1, powers); assertEquals(1, stops);
    }
    @Test public void rejectsCoercionExpiredAndUnsupportedProfiles() throws Exception {
        for (String json : new String[]{body("\"10\"", "1000"), body("10.5", "1000"), body("10", "0"),
                body("10", "1800001"), body("10", "1000").replace("cachito-id36", "unknown"), "{}"}) {
            assertTrue(request("POST", "/v1/suction", auth(), json).startsWith("HTTP/1.1 422"));
        }
        assertEquals(0, powers);
    }
    @Test public void rejectsDuplicateHeadersAndOversizeBody() throws Exception {
        assertTrue(request("POST", "/v1/suction", auth() + "Authorization: Bearer bad\r\n", body("10", "1000")).startsWith("HTTP/1.1 400"));
        assertTrue(request("POST", "/v1/suction", auth(), " ".repeat(4097)).startsWith("HTTP/1.1 413"));
        assertEquals(0, powers);
    }
}
