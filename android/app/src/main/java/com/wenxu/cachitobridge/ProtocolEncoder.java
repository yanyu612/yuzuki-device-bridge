package com.wenxu.cachitobridge;

import java.security.SecureRandom;
import java.util.Locale;
import java.util.UUID;

public final class ProtocolEncoder {
    private static final SecureRandom RANDOM = new SecureRandom();

    private ProtocolEncoder() {
    }

    public static String createDeviceId() {
        return String.format(Locale.US, "%04X", RANDOM.nextInt(0x10000));
    }

    public static int createCommandId() {
        return 100 + RANDOM.nextInt(156);
    }

    public static EncodedCommand power(int power, int commandId, String deviceId) {
        if (power < 2 || power > 100) {
            throw new IllegalArgumentException("强度必须在 2 到 100 之间");
        }
        int encodedPower = (int) Math.floor(power * 0.5d + 50d);
        String body = "71000C" + twoHex(commandId)
                + "8200" + normalizeDeviceId(deviceId)
                + "0100640000" + twoHex(encodedPower) + "02";
        return finish(body, power, false);
    }

    public static EncodedCommand stop(int commandId, String deviceId) {
        String body = "71000C" + twoHex(commandId)
                + "0F00" + normalizeDeviceId(deviceId)
                + "01000000000000";
        return finish(body, 0, true);
    }

    private static EncodedCommand finish(String body, int requestedPower, boolean stop) {
        String packet = body + checksum(body);
        String uuidText = packet.substring(0, 8) + "-"
                + packet.substring(8, 12) + "-"
                + packet.substring(12, 16) + "-"
                + packet.substring(16, 20) + "-"
                + packet.substring(20);
        return new EncodedCommand(UUID.fromString(uuidText), packet, requestedPower, stop);
    }

    static String checksum(String hex) {
        if ((hex.length() & 1) != 0) {
            throw new IllegalArgumentException("十六进制数据长度必须为偶数");
        }
        int sum = 0;
        for (int i = 0; i < hex.length(); i += 2) {
            sum += Integer.parseInt(hex.substring(i, i + 2), 16);
        }
        return twoHex(sum & 0xFF);
    }

    private static String normalizeDeviceId(String value) {
        String normalized = value == null ? "" : value.trim().toUpperCase(Locale.US);
        if (!normalized.matches("[0-9A-F]{4}")) {
            throw new IllegalArgumentException("控制端编号必须是 4 位十六进制");
        }
        return normalized;
    }

    private static String twoHex(int value) {
        if (value < 0 || value > 255) {
            throw new IllegalArgumentException("字节值超出范围");
        }
        return String.format(Locale.US, "%02X", value);
    }

    public static final class EncodedCommand {
        public final UUID serviceUuid;
        public final String packetHex;
        public final int requestedPower;
        public final boolean stop;

        EncodedCommand(UUID serviceUuid, String packetHex, int requestedPower, boolean stop) {
            this.serviceUuid = serviceUuid;
            this.packetHex = packetHex;
            this.requestedPower = requestedPower;
            this.stop = stop;
        }
    }
}
