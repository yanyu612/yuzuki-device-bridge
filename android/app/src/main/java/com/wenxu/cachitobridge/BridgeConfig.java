package com.wenxu.cachitobridge;

import android.content.Context;
import android.content.SharedPreferences;
import java.security.SecureRandom;
import java.util.Locale;

/** Installation-local state. Never exported with source or a plugin settings backup. */
final class BridgeConfig {
    static final String PROFILE_ID = "cachito-id36";
    static final String DEVICE_NAME = "Cachito · 诱桃偷欢 Pro AI版";
    private final SharedPreferences preferences;

    BridgeConfig(Context context) {
        preferences = context.getSharedPreferences("device_bridge_v1", Context.MODE_PRIVATE);
        if (!preferences.contains("token")) rotateToken();
        if (!preferences.contains("controllerId")) {
            preferences.edit().putString("controllerId", ProtocolEncoder.createDeviceId()).apply();
        }
    }

    String token() { return preferences.getString("token", ""); }
    String controllerId() { return preferences.getString("controllerId", ""); }
    String origin() { return preferences.getString("origin", "http://127.0.0.1:8000"); }
    int maxPower() { return preferences.getInt("maxPower", 30); }

    void save(String origin, int maxPower) {
        String normalized = BridgePolicy.normalizeOrigin(origin);
        if (maxPower < 2 || maxPower > 100) throw new IllegalArgumentException("上限须为 2–100");
        preferences.edit().putString("origin", normalized).putInt("maxPower", maxPower).apply();
    }

    void rotateToken() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder token = new StringBuilder(64);
        for (byte value : bytes) token.append(String.format(Locale.ROOT, "%02x", value & 255));
        preferences.edit().putString("token", token.toString()).apply();
    }
}
