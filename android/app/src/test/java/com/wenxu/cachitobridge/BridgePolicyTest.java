package com.wenxu.cachitobridge;

import static org.junit.Assert.*;
import org.junit.Test;

public final class BridgePolicyTest {
    private final String token = "a".repeat(64);

    @Test public void normalizesPastedAddressWithoutBroadeningOrigin() {
        assertEquals("https://example.org", BridgePolicy.normalizeOrigin("https://Example.org:443/path/"));
        assertEquals("http://127.0.0.1:8000", BridgePolicy.normalizeOrigin("http://127.0.0.1:8000/"));
        assertEquals("http://[::1]:8000", BridgePolicy.normalizeOrigin("http://[::1]:8000/"));
        assertFalse(BridgePolicy.allowsOrigin("https://example.org", "https://example.org.attacker.invalid"));
        assertFalse(BridgePolicy.allowsOrigin("https://example.org", "null"));
        assertTrue(BridgePolicy.allowsOrigin("https://example.org", null));
    }

    @Test public void rejectsCredentialsAndNonWebAddresses() {
        for (String value : new String[]{"file:///test", "javascript:alert(1)", "https://u:p@example.org", "https://example.org?a=1", "http://example.org:70000"}) {
            assertThrows(IllegalArgumentException.class, () -> BridgePolicy.normalizeOrigin(value));
        }
    }

    @Test public void tokenIsRequiredEvenForNativeClients() {
        assertTrue(BridgePolicy.authenticated(token, "Bearer " + token));
        assertFalse(BridgePolicy.authenticated(token, null));
        assertFalse(BridgePolicy.authenticated(token, "Bearer " + "b".repeat(64)));
        assertFalse(BridgePolicy.authenticated("", "Bearer "));
        assertFalse(BridgePolicy.authenticated(token, "yuzuki-v1"));
    }

    @Test public void boundsNativeDeadline() {
        assertTrue(BridgePolicy.validTimeout(1));
        assertTrue(BridgePolicy.validTimeout(1_800_000));
        assertFalse(BridgePolicy.validTimeout(0));
        assertFalse(BridgePolicy.validTimeout(1_800_001));
    }
}
